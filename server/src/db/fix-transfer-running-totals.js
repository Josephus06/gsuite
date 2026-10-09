// Raises every Transfer Order line's Fulfilled / Received, and every Item Fulfillment line's
// Received, to what their documents add up to, then re-derives the affected TOs' status. See
// lib/transferTotals.js for how they fell behind (TO-38777, 2026-10-09). Never lowers a figure.
//
// Dry run unless --apply. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/fix-transfer-running-totals.js
//   node src/db/fix-transfer-running-totals.js --apply
require('dotenv').config();
const pool = require('../db');
const { raiseTransferTotals } = require('../lib/transferTotals');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'APPLYING.\n' : 'DRY RUN -- nothing will be written (pass --apply).\n');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await raiseTransferTotals(conn, { dryRun: !APPLY });
    await conn.commit();
    console.log(`TO lines, Fulfilled raised : ${r.fulfilled}`);
    console.log(`TO lines, Received raised  : ${r.received}`);
    console.log(`Fulfillment lines, Received: ${r.ifl}`);
    console.log(`TO status changes          : ${r.statuses.length}`);
    const tally = {};
    for (const s of r.statuses) tally[`${s.from} -> ${s.to}`] = (tally[`${s.from} -> ${s.to}`] || 0) + 1;
    for (const [k, n] of Object.entries(tally)) console.log(`   ${k}: ${n}`);
    for (const s of r.statuses.slice(0, 15)) console.log(`   e.g. ${s.to_no}: ${s.from} -> ${s.to}`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally { conn.release(); }
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
