// Backfills bill_payments.date_released from the live system.
//
// THE FIELD IS CALLED AcknowledgeDate_TransH OVER THERE. The live UI labels it "Date Released" --
// found by pulling the live bundle and grepping its audit-log label map, where
// `case "AcknowledgeDate": Field_Log = "Date Released"` spells the two out as the same thing.
// Nothing in the API is named "released", which is why the obvious searches came back empty.
//
// One call per payment, because live offers no bulk filter for them: get_transactions accepts
// `where: { UserPK_TransH }` and returns exactly one row, while every attempt at a type or module
// filter returns nothing. UserPK_TransH is what this build stored as bill_payment_no, so the two
// join directly.
//
// NOTHING IS INVENTED. A payment whose AcknowledgeDate is null over there is left null here: that
// means it has not been released, not that we failed to find a date. Deriving one from CheckDate
// would put a release date on payments that may never have been released that day, and a
// disbursement report is the wrong place to guess.
//
// Only fills BLANKS -- a date already set here is never overwritten, so a re-run cannot undo a
// correction someone made by hand.
//
//   node src/db/backfill-bill-payment-date-released.js --dry-run   what it would do
//   node src/db/backfill-bill-payment-date-released.js
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY = process.argv.includes('--dry-run');
const CONCURRENCY = 6;

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.LIVE_SITE_USERNAME,
      password: process.env.LIVE_SITE_PASSWORD,
    }),
  });
  const token = (await r.json())?.data?.token;
  if (!token) throw new Error('Could not log in to the live system.');
  return token;
}

async function acknowledgeDate(token, billPaymentNo) {
  const r = await fetch(`${SITE}/api/get_transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ where: { UserPK_TransH: billPaymentNo } }),
  });
  const j = await r.json().catch(() => null);
  const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
  if (!rows.length) return { found: false, date: null };
  const raw = rows[0].AcknowledgeDate_TransH;
  // Live returns an ISO timestamp; only the day matters and only the day is stored, which also
  // sidesteps the timezone slide a Date round-trip would risk.
  return { found: true, date: raw ? String(raw).slice(0, 10) : null };
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');

  const [rows] = await pool.query(
    `SELECT id, bill_payment_no FROM bill_payments
      WHERE date_released IS NULL AND status <> 'voided'
      ORDER BY id`,
  );
  console.log(`${rows.length} bill payments with no Date Released.\n`);
  if (!rows.length) { await pool.end(); return; }

  const token = await login();
  let withDate = 0; let blankThere = 0; let notFound = 0; let done = 0;

  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const row = queue.shift();
      try {
        const { found, date } = await acknowledgeDate(token, row.bill_payment_no);
        if (!found) notFound += 1;
        else if (!date) blankThere += 1;
        else {
          withDate += 1;
          if (!DRY) {
            await pool.query('UPDATE bill_payments SET date_released = ? WHERE id = ?', [date, row.id]);
          }
        }
      } catch {
        // A single lookup failing must not abandon the run; it is simply not backfilled and will
        // be picked up next time, since only blanks are ever read.
        notFound += 1;
      }
      done += 1;
      if (done % 100 === 0) process.stdout.write(`   ...${done}/${rows.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDate Released found and ${DRY ? 'would be ' : ''}set : ${withDate}`);
  console.log(`Blank on live too (not yet released)      : ${blankThere}`);
  console.log(`Not found on live                         : ${notFound}`);

  if (!DRY) {
    const [[s]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(date_released IS NOT NULL) AS released
         FROM bill_payments WHERE status <> 'voided'`,
    );
    console.log(`\n${Number(s.released) || 0} of ${s.total} live bill payments now carry a Date Released.`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
