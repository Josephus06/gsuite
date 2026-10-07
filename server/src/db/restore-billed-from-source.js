// Undoes the first run of fix-so-partially-billed.js where it was wrong (2026-10-07). That run moved
// every Billed order with some line invoiced short to Partially Billed -- hundreds of migrated
// 2019-2021 orders among them, whose Job Order quantities simply came over incomplete -- and set their
// short-invoiced JOs back from Invoiced. The source is the authority on a migrated order: each order
// now Partially Billed that the source calls fully Billed (or Paid) goes back to Billed, and its JOs
// back to Invoiced, as the sync itself sets a Billed order's JOs. Orders the source calls partially
// billed (SO-70419), and orders raised in T1S, are left as they are.
//
//   node src/db/restore-billed-from-source.js            # preview
//   node src/db/restore-billed-from-source.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { sourceSoStatuses } = require('../lib/liveStatusSync');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [orders] = await pool.query(
    `SELECT id, sales_order_no, DATE_FORMAT(date_created, '%Y-%m-%d') AS day FROM sales_orders
      WHERE status = 'partially_billed' AND created_at < '2026-09-28' ORDER BY id`);
  if (!orders.length) { console.log('No migrated order is Partially Billed.'); await pool.end(); return; }
  console.log(`${orders.length} migrated order(s) Partially Billed; reading their status at the source...`);
  const source = await sourceSoStatuses(orders.map((o) => o.sales_order_no));

  let restored = 0; let jos = 0; let keptPartial = 0; let notInSource = 0;
  for (const o of orders) {
    if (!source.has(o.sales_order_no)) { notInSource += 1; continue; }
    const st = String(source.get(o.sales_order_no)).toUpperCase();
    const fullyBilled = (st.includes('BILLED') || st.includes('PAID')) && !st.includes('PARTIAL');
    if (!fullyBilled) { keptPartial += 1; continue; }
    restored += 1;
    if (restored <= 40) console.log(`  ${o.sales_order_no}: partially_billed -> billed (source: ${source.get(o.sales_order_no)})`);
    if (!APPLY) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE sales_orders SET status = 'billed', updated_at = NOW() WHERE id = ?", [o.id]);
      const [r] = await conn.query(
        `UPDATE job_orders SET production_stage = 'invoiced', updated_at = NOW()
          WHERE sales_order_id = ? AND status <> 'Cancelled' AND production_stage IN ('completed', 'partially_completed', 'in_process')`,
        [o.id]);
      jos += r.affectedRows;
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  if (restored > 40) console.log(`  ... and ${restored - 40} more`);
  console.log(`\n${restored} back to Billed${APPLY ? ` (${jos} JO stage(s) back to Invoiced)` : ' -- preview, nothing written'}; `
    + `${keptPartial} kept Partially Billed (the source agrees); ${notInSource} not found at the source (left alone).`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
