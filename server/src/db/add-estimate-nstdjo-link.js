// Makes an Estimate line's NSTDJO # a real reference to the Non-Standard Job Order module
// instead of a free-text box.
//
// `estimate_job_orders.nstdjo_no` has been a varchar(50) anyone could type into since the table
// was created, and NOBODY EVER DID: 0 of the 4,721 estimate lines carry a value, and none of the
// 569 Non-Standard Job Orders is referenced by one. So there is nothing to preserve and nothing
// to backfill -- the column has only ever held NULL.
//
// A typed number would have been a dead string anyway: it could be a typo, could name an NSTDJO
// that was later cancelled, and could not be clicked through to. nstdjo_id makes the tag point at
// the record, and nstdjo_no keeps holding the number for display and print, written from the
// record rather than by hand so the two cannot disagree.
//
// NO FOREIGN KEY, deliberately, matching how this schema treats sales_invoices.estimate_id and
// sales_order_lines.estimate_job_order_id: these tables carry no FK constraints at all, and
// adding one here alone would make this the only table that refuses to let an NSTDJO be deleted.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-estimate-nstdjo-link.js
require('dotenv').config();
const pool = require('../db');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}
async function indexExists(table, index) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('estimate_job_orders', 'nstdjo_id')) {
    console.log('  estimate_job_orders.nstdjo_id already exists -- skipped.');
  } else {
    await pool.query('ALTER TABLE estimate_job_orders ADD COLUMN nstdjo_id BIGINT NULL AFTER nstdjo_no');
    console.log('  estimate_job_orders.nstdjo_id added.');
  }

  if (await indexExists('estimate_job_orders', 'idx_estimate_job_orders_nstdjo')) {
    console.log('  idx_estimate_job_orders_nstdjo already exists -- skipped.');
  } else {
    await pool.query('CREATE INDEX idx_estimate_job_orders_nstdjo ON estimate_job_orders (nstdjo_id)');
    console.log('  idx_estimate_job_orders_nstdjo created.');
  }

  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(nstdjo_no IS NOT NULL AND nstdjo_no <> '') AS with_a_typed_number,
            SUM(nstdjo_id IS NOT NULL) AS tagged_to_a_record
       FROM estimate_job_orders`,
  );
  console.log(`\n  ${s.total} estimate line(s): ${s.with_a_typed_number} with a typed number, `
    + `${s.tagged_to_a_record} tagged to an NSTDJO record.`);

  // A typed number that names a real NSTDJO could be linked up automatically. There are none
  // today, so this reports rather than guesses -- if some install does have them, the number is
  // worth seeing before anything is written.
  const [[m]] = await pool.query(
    `SELECT COUNT(*) AS n FROM estimate_job_orders ejo
       JOIN non_standard_job_orders n ON n.nstdjo_no = ejo.nstdjo_no
      WHERE ejo.nstdjo_id IS NULL AND ejo.nstdjo_no IS NOT NULL AND ejo.nstdjo_no <> ''`,
  );
  if (Number(m.n) > 0) {
    console.log(`  ${m.n} typed number(s) match a real NSTDJO and could be linked -- not done automatically.`);
  }

  await pool.end();
}

main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
