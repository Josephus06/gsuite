// Reversal journals for Vendor Bills cancelled before Cancel started writing them (2026-10-14).
// Since then (routes/vendorBills.js) a cancelled bill keeps its entry in its own period and a
// reversal journal takes it out in the period of the void. A bill cancelled earlier -- VB-24847,
// VB-24640, VB-24898 -- has no journal, so the GL still leaves it out entirely (lib/glImpact.js).
// Writing the journal brings it in line: the bill's entry returns to its own period and the journal,
// dated the day it was cancelled (Philippine date), takes it back out.
//
// The same rules as Cancel (lib/vendorBillReversal.js): the bill's posted entry mirrored, and nothing
// for a bill that was never in the ledger. A reversal date in a closed A/P period is skipped and
// reported -- reopen the month, or re-run after. Idempotent: postReversalJournal will not write a
// second journal for a bill.
//
//   node src/db/backfill-vendor-bill-reversals.js --dry-run
//   node src/db/backfill-vendor-bill-reversals.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { postReversalJournal, mirror } = require('../lib/reversalJournal');
const { postedBillGlRows, billInLedger } = require('../lib/vendorBillReversal');
const { periodLock } = require('../lib/accountingPeriod');

const DRY_RUN = process.argv.includes('--dry-run');
// cancelled_at is UTC; the reversal is dated on the business (Philippine) day it happened.
const phDay = (d) => new Date(new Date(d).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [bills] = await pool.query(
    `SELECT vb.id, vb.bill_no, vb.cancelled_at, vb.cancelled_by_user_id
       FROM vendor_bills vb
      WHERE vb.status = 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM journals j WHERE j.source_type = 'vendor_bill' AND j.source_id = vb.id AND j.status <> 'void')
      ORDER BY vb.id`);
  console.log(`${bills.length} cancelled bill(s) without a reversal journal.`);
  for (const b of bills) {
    const gl = await postedBillGlRows(pool, b.id);
    if (!gl) { console.log(`  ${b.bill_no}: not found`); continue; }
    if (!(await billInLedger(pool, gl.vb))) { console.log(`  ${b.bill_no}: never in the ledger -- nothing to reverse`); continue; }
    const date = b.cancelled_at ? phDay(b.cancelled_at) : phDay(new Date());
    const lock = await periodLock(date, 'ap');
    if (lock) { console.log(`  ${b.bill_no}: reversal date ${date} is in a closed period (${lock}) -- skipped`); continue; }
    const rows = mirror(gl.glRows);
    const amount = rows.reduce((s, r) => s + Number(r.debit || 0), 0).toFixed(2);
    if (DRY_RUN) { console.log(`  ${b.bill_no}: would post a reversal of ${amount} dated ${date} (${rows.length} lines)`); continue; }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const res = await postReversalJournal(conn, {
        sourceType: 'vendor_bill', sourceId: b.id, sourceNo: gl.vb.bill_no, glRows: gl.glRows,
        documentDate: gl.vb.date_created, voidedAt: b.cancelled_at, reason: 'Cancelled before reversal journals were posted',
        userId: b.cancelled_by_user_id || null, locationId: gl.vb.office_location_id || null, date,
      });
      await conn.commit();
      console.log(`  ${b.bill_no}: ${res ? `${res.journalNo} posted, ${amount} dated ${date}` : 'nothing posted'}`);
    } catch (e) {
      await conn.rollback();
      console.log(`  ${b.bill_no}: FAILED -- ${e.message}`);
    } finally { conn.release(); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
