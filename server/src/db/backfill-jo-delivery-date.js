// Backfill job_orders.delivery_date/time from the sales order line they were created from.
//
// Create JO never copied these two fields, so every job order made through the app has them
// NULL while its sales order line carries the date Sales committed to. Production, Scheduled
// Job Orders and the dashboard all read job_orders.delivery_date -- the dashboard windows on
// COALESCE(delivery_date, planned_start_at) -- so the committed date never reached the floor.
//
// Deliberately fills only NULLs, and only from a line that actually has a date. It cannot
// overwrite a date somebody typed on the Job Order screen by hand, which is the one thing
// here that would be unrecoverable.
//
//   node src/db/backfill-jo-delivery-date.js [--dry-run]
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

const WHERE = `
  FROM job_orders jo
  JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
 WHERE jo.delivery_date IS NULL
   AND sol.delivery_date IS NOT NULL`;

(async () => {
  try {
    const [[before]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(delivery_date IS NOT NULL) AS with_date
         FROM job_orders`
    );
    console.log(`job_orders: ${before.total} rows, ${before.with_date} with a delivery date.`);

    const [[gap]] = await pool.query(`SELECT COUNT(*) AS n ${WHERE}`);
    console.log(`Fillable (JO blank, SO line dated): ${gap.n}`);

    if (!gap.n) { console.log('Nothing to do.'); process.exit(0); }

    const [sample] = await pool.query(
      `SELECT jo.job_order_no, sol.delivery_date, sol.delivery_time ${WHERE} ORDER BY jo.id DESC LIMIT 5`
    );
    console.log('Sample of what would be set:');
    for (const r of sample) console.log(`  ${r.job_order_no}  ${r.delivery_date ? String(r.delivery_date).slice(0, 10) : ''} ${r.delivery_time || ''}`);

    if (DRY_RUN) { console.log('\nDRY RUN -- nothing written.'); process.exit(0); }

    // Chunked so one statement never holds a long write lock on a 124k-row table over the
    // Railway proxy, which drops connections on long-running writes. The ids are collected
    // first because MySQL rejects LIMIT on a multi-table UPDATE.
    const [targets] = await pool.query(`SELECT jo.id ${WHERE}`);
    const ids = targets.map((r) => r.id);
    let done = 0;
    for (let i = 0; i < ids.length; i += 2000) {
      const batch = ids.slice(i, i + 2000);
      const [res] = await pool.query(
        `UPDATE job_orders jo
           JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
            SET jo.delivery_date = sol.delivery_date,
                jo.delivery_time = sol.delivery_time
          WHERE jo.id IN (?)
            AND jo.delivery_date IS NULL
            AND sol.delivery_date IS NOT NULL`,
        [batch]
      );
      done += res.affectedRows;
      console.log(`  ...${done}/${gap.n}`);
    }

    const [[after]] = await pool.query(
      'SELECT COUNT(*) AS total, SUM(delivery_date IS NOT NULL) AS with_date FROM job_orders'
    );
    console.log(`\nDone. Filled ${done}. job_orders now ${after.with_date}/${after.total} with a delivery date.`);
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
