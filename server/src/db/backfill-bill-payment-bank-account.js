// Puts the REAL bank account on each imported bill payment.
//
// import-bill-payments.js gave every payment the same account. Its own comment says why -- "live
// only names the bank in Title_COA, so we default to Cash in Bank (11000)" -- and defaulting a
// NOT NULL foreign key was a reasonable way to get the import through at the time. The cost only
// shows up now: the Disbursement Report has an Account column, and it read "11000 — Cash in Bank"
// for all 868 payments when the money actually came out of three different accounts.
//
// Title_COA is the account's NAME, and every distinct value live uses matches a row in this
// build's chart_of_accounts exactly -- checked before writing this: 3 distinct titles, 3 matched,
// 0 unmatched. So the name is enough to resolve the account, and anything that does not match is
// left alone rather than guessed at.
//
// Read from the LIST endpoint, 200 at a time, because it already returns Title_COA alongside the
// user_pk this build stored as bill_payment_no -- no per-record lookup needed.
//
// Only corrects payments still sitting on the DEFAULT account. A payment whose account somebody
// has since set by hand is never touched, so a re-run cannot undo a correction.
//
//   node src/db/backfill-bill-payment-bank-account.js --dry-run
//   node src/db/backfill-bill-payment-bank-account.js
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY = process.argv.includes('--dry-run');
const DEFAULT_CODE = '11000';

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

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

async function fetchAll(token) {
  const byNo = new Map();
  for (let offset = 0; ; offset += 200) {
    const r = await fetch(`${SITE}/api/get_bill_payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ searchKey: '', limit: 200, offset }),
    });
    const j = await r.json();
    const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
    if (!rows.length) break;
    rows.forEach((x) => { if (x.user_pk) byNo.set(String(x.user_pk), x.Title_COA || null); });
    process.stdout.write(`   ...${byNo.size} live payments read\n`);
    if (rows.length < 200) break;
  }
  return byNo;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');

  const [[def]] = await pool.query(
    'SELECT id FROM chart_of_accounts WHERE account_code = ? LIMIT 1', [DEFAULT_CODE]);
  if (!def) throw new Error(`Account ${DEFAULT_CODE} not found; nothing to correct from.`);

  const [coa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const coaByName = new Map(coa.map((c) => [norm(c.account_name), c]));

  const [rows] = await pool.query(
    'SELECT id, bill_payment_no, bank_account_id FROM bill_payments WHERE bank_account_id = ?', [def.id]);
  console.log(`${rows.length} bill payments still on the default account.\n`);
  if (!rows.length) { await pool.end(); return; }

  const token = await login();
  const titleByNo = await fetchAll(token);
  console.log('');

  const counts = new Map();
  let changed = 0; let stillDefault = 0; let unmatched = 0; let missing = 0;

  for (const row of rows) {
    const title = titleByNo.get(String(row.bill_payment_no));
    if (title === undefined) { missing += 1; continue; }
    if (!title) { unmatched += 1; continue; }
    const acct = coaByName.get(norm(title));
    if (!acct) { unmatched += 1; console.log(`   no account named "${title}" here -- left alone.`); continue; }
    if (acct.id === def.id) { stillDefault += 1; continue; }
    if (!DRY) {
      await pool.query('UPDATE bill_payments SET bank_account_id = ? WHERE id = ?', [acct.id, row.id]);
    }
    changed += 1;
    const key = `${acct.account_code} — ${acct.account_name}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  console.log(`${DRY ? 'Would correct' : 'Corrected'} : ${changed}`);
  [...counts.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`   ${String(n).padStart(4)}  ${k}`));
  console.log(`Genuinely on ${DEFAULT_CODE} over there  : ${stillDefault}`);
  console.log(`No usable account name on live  : ${unmatched}`);
  console.log(`Not found on live               : ${missing}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
