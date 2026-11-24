// One-off backfill (2026-11-24): Vendor Bills migrated by import-vendor-bills.js have no Office Location
// and no Account (19,696 of 25,340 on the droplet) -- that importer never mapped either; the later
// importers do. VB-24614 showed "Office Location: --  Account: --".
//
//   Account  the payable the bill's OWN source GL entry credits (live_gl_entries, already here): 20100
//            Accounts Payable - Trade for nearly all, as on the bills raised in T1S. 21402 (withholding)
//            is never the bill's account. A bill whose source GL has no payable line is listed, not guessed.
//   Office   the source system's own LocationName_TransH for the bill (get_transactions by bill no),
//            matched to locations by name. A name with no match is listed, not guessed.
//
// Only EMPTY fields are filled; nothing already set is overwritten. Dry run by default:
//
//   node src/db/backfill-vendor-bill-office-account.js            (dry run: what it would set)
//   node src/db/backfill-vendor-bill-office-account.js --apply
//   ... --limit=200                                               (first N bills only, for a trial)
//
// Office names fetched from the source are cached in /tmp/vb-office-cache.json, so --apply after a dry
// run does not ask the source again, and an interrupted run resumes. Low concurrency on the source.
// The droplet, office and SM boxes replicate: run on ONE box (the droplet).
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || null;
const CACHE = (process.argv.find((a) => a.startsWith('--cache=')) || '').slice(8) || '/tmp/vb-office-cache.json';
const SITE = 'http://gsuite.graphicstar.com.ph';
const PAYABLES = ['20100', '20200', '27010'];
const CONCURRENCY = 4;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
    signal: AbortSignal.timeout(30000),
  });
  const token = (await r.json())?.data?.token;
  if (!token) throw new Error('Could not log in to the source system (LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD).');
  return token;
}
async function sourceLocation(token, billNo) {
  for (let a = 0; a < 4; a += 1) {
    try {
      const r = await fetch(`${SITE}/api/get_transactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ where: { Module_TransH: 'VENDORBILL', UserPK_TransH: billNo } }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json();
      const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
      if (!rows.length) return { found: false };
      return { found: true, location: rows[0].LocationName_TransH || null };
    } catch (e) { await sleep(1500 * (a + 1)); }
  }
  return { error: true };
}

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${APPLY ? '' : ' -- DRY RUN (add --apply to write)'}${LIMIT ? ` | first ${LIMIT} bills` : ''}\n`);

  const [bills] = await pool.query(
    `SELECT id, bill_no, office_location_id, account_id FROM vendor_bills
      WHERE status <> 'cancelled' AND (office_location_id IS NULL OR account_id IS NULL)
      ORDER BY id ${LIMIT ? `LIMIT ${LIMIT}` : ''}`);
  console.log(`Bills missing an office or an account: ${bills.length}`);
  if (!bills.length) return;

  // ---- account, from each bill's own source GL payable credit
  const ids = bills.map((b) => b.id);
  const acctOf = new Map();
  for (let k = 0; k < ids.length; k += 2000) {
    const [rows] = await pool.query(
      `SELECT g.source_id, g.account_code, COUNT(*) n FROM live_gl_entries g
        WHERE g.source_type = 'vendor_bill' AND g.source_id IN (?) AND g.credit > 0 AND g.account_code IN (?)
        GROUP BY g.source_id, g.account_code`, [ids.slice(k, k + 2000), PAYABLES]);
    for (const r of rows) {
      const list = acctOf.get(r.source_id) || [];
      list.push(r.account_code); acctOf.set(r.source_id, list);
    }
  }
  const [coa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code IN (?)', [PAYABLES]);
  const coaByCode = new Map(coa.map((a) => [String(a.account_code), a]));

  // ---- office, from the source system (cached)
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* first run */ }
  const need = bills.filter((b) => b.office_location_id == null && !(b.bill_no in cache));
  if (need.length) {
    console.log(`Asking the source system for ${need.length} bill office(s)${Object.keys(cache).length ? ` (${Object.keys(cache).length} cached)` : ''}...`);
    const token = await login();
    let i = 0; let done = 0; const started = Date.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < need.length) {
        const b = need[i++];
        const r = await sourceLocation(token, b.bill_no);
        if (!r.error) cache[b.bill_no] = r.found ? (r.location || '') : null;
        done += 1;
        if (done % 500 === 0 || done === need.length) {
          fs.writeFileSync(CACHE, JSON.stringify(cache));
          console.log(`  ${done}/${need.length} (${Math.round((Date.now() - started) / 1000)}s)`);
        }
      }
    }));
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  }
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l]));

  // ---- plan
  const plan = [];
  const noAccount = []; const twoAccounts = []; const noOffice = []; const unknownOffice = new Map(); const notInSource = [];
  const tally = { office: new Map(), account: new Map() };
  for (const b of bills) {
    const set = {};
    if (b.account_id == null) {
      const codes = acctOf.get(b.id) || [];
      if (codes.length === 1 && coaByCode.has(codes[0])) set.account_id = coaByCode.get(codes[0]);
      else if (codes.length > 1) twoAccounts.push(b.bill_no);
      else noAccount.push(b.bill_no);
    }
    if (b.office_location_id == null) {
      const name = cache[b.bill_no];
      if (name === undefined) noOffice.push(b.bill_no);
      else if (name === null) notInSource.push(b.bill_no);
      else if (!name) noOffice.push(b.bill_no);
      else if (locByName.has(norm(name))) set.office = locByName.get(norm(name));
      else unknownOffice.set(name, (unknownOffice.get(name) || 0) + 1);
    }
    if (set.account_id) tally.account.set(`${set.account_id.account_code} ${set.account_id.account_name}`, (tally.account.get(`${set.account_id.account_code} ${set.account_id.account_name}`) || 0) + 1);
    if (set.office) tally.office.set(set.office.location_name, (tally.office.get(set.office.location_name) || 0) + 1);
    if (set.account_id || set.office) plan.push({ id: b.id, bill_no: b.bill_no, ...set });
  }

  console.log(`\nWould set an Account on ${[...tally.account.values()].reduce((s, n) => s + n, 0)} bill(s):`);
  for (const [k, n] of tally.account) console.log(`  ${k}: ${n}`);
  console.log(`Would set an Office on ${[...tally.office.values()].reduce((s, n) => s + n, 0)} bill(s):`);
  for (const [k, n] of [...tally.office].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  const list = (label, arr) => { if (arr.length) console.log(`${label}: ${arr.length}${arr.length <= 25 ? ` (${arr.join(', ')})` : ` (first: ${arr.slice(0, 25).join(', ')} ...)`}`); };
  console.log('\nLeft as they are:');
  list('  no payable line in the source GL (account)', noAccount);
  list('  two different payables in the source GL (account)', twoAccounts);
  list('  no office in the source', noOffice);
  list('  not found in the source', notInSource);
  if (unknownOffice.size) console.log(`  office name with no T1S location: ${[...unknownOffice].map(([k, n]) => `"${k}" x${n}`).join(', ')}`);

  if (!APPLY) { console.log('\nDry run -- nothing written. Re-run with --apply.'); return; }
  let n = 0;
  for (const p of plan) {
    const fields = []; const vals = [];
    if (p.account_id) { fields.push('account_id = COALESCE(account_id, ?)'); vals.push(p.account_id.id); }
    if (p.office) { fields.push('office_location_id = COALESCE(office_location_id, ?)'); vals.push(p.office.id); }
    await pool.query(`UPDATE vendor_bills SET ${fields.join(', ')} WHERE id = ?`, [...vals, p.id]);
    n += 1;
    if (n % 2000 === 0) console.log(`  updated ${n}/${plan.length}`);
  }
  console.log(`\nUpdated ${n} bill(s).`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
