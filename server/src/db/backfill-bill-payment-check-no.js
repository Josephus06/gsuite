// Backfills bill_payments.check_no from the live system (asked 2026-11-06: BPAY-13781 shows
// Check No 6000421064 on live but nothing here, so the cheque could not be found by its number).
//
// Live keeps it in CheckNo_TransH. import-bill-payments.js already copied that field, but the list
// call it read (get_bill_payments) does not carry it, so every imported payment came in blank.
// get_transactions with `where: { UserPK_TransH }` returns the full header including the field --
// one call per payment, as in backfill-bill-payment-date-released.js.
//
// Only fills BLANKS, and only with what live actually has: a cash/online payment with no cheque
// stays blank, and a number someone typed here is never overwritten.
//
//   node src/db/backfill-bill-payment-check-no.js --dry-run   what it would do
//   node src/db/backfill-bill-payment-check-no.js
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY = process.argv.includes('--dry-run');
const CONCURRENCY = 6;

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const token = (await r.json())?.data?.token;
  if (!token) throw new Error('Could not log in to the live system.');
  return token;
}

async function liveCheckNo(token, billPaymentNo) {
  const r = await fetch(`${SITE}/api/get_transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ where: { UserPK_TransH: billPaymentNo } }),
  });
  const j = await r.json().catch(() => null);
  const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
  if (!rows.length) return { found: false, no: null };
  const no = rows[0].CheckNo_TransH == null ? '' : String(rows[0].CheckNo_TransH).trim();
  return { found: true, no: no ? no.slice(0, 60) : null };
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');

  const [rows] = await pool.query(
    "SELECT id, bill_payment_no FROM bill_payments WHERE check_no IS NULL OR TRIM(check_no) = '' ORDER BY id DESC");
  console.log(`${rows.length} bill payments with no Check No.\n`);
  if (!rows.length) { await pool.end(); return; }

  const token = await login();
  let filled = 0; let blankThere = 0; let notFound = 0; let failed = 0; let done = 0;
  const samples = [];

  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const row = queue.shift();
      try {
        const { found, no } = await liveCheckNo(token, row.bill_payment_no);
        if (!found) notFound += 1;
        else if (!no) blankThere += 1;
        else {
          filled += 1;
          if (samples.length < 10) samples.push(`${row.bill_payment_no} -> ${no}`);
          if (!DRY) {
            // Re-check blank at write time so a number typed in meanwhile is kept.
            await pool.query(
              "UPDATE bill_payments SET check_no = ? WHERE id = ? AND (check_no IS NULL OR TRIM(check_no) = '')",
              [no, row.id]);
          }
        }
      } catch {
        failed += 1; // picked up on the next run, since only blanks are read
      }
      done += 1;
      if (done % 200 === 0) process.stdout.write(`   ...${done}/${rows.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nSample:\n  ${samples.join('\n  ')}`);
  console.log(`\nCheck No found and ${DRY ? 'would be ' : ''}set : ${filled}`);
  console.log(`Blank on live too (not a cheque)    : ${blankThere}`);
  console.log(`Not found on live                   : ${notFound}`);
  console.log(`Lookup failed (re-run to retry)     : ${failed}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
