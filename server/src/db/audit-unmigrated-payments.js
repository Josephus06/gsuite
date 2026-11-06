// READ-ONLY. Lists the bill payments (BPAY-) and cheques (CHK-) on the live system that this build
// does not have, plus the ones it has with a different amount or without the check no. live shows
// (asked 2026-11-06 after BPAY-13781 / check 6000421064 turned out never to have been migrated).
//
// Pages live's get_bill_payments and get_cheques lists in full (~70-80 pages each) and compares by
// document number. Voided / cancelled documents on live are left out. Writes nothing to the DB;
// the full list goes to a CSV.
//
//   node src/db/audit-unmigrated-payments.js                      everything
//   node src/db/audit-unmigrated-payments.js --from=2026-01-01    only documents dated from then
//   node src/db/audit-unmigrated-payments.js --out=/root/unmigrated.csv
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const argVal = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const FROM = argVal('from', '0000-00-00');
const TO = argVal('to', '9999-12-31');
const OUT = argVal('out', 'unmigrated-payments.csv');
const PAGE = 200;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const day = (v) => (v ? String(v).slice(0, 10) : '');
const clean = (v) => (v == null ? '' : String(v).trim());
const listRows = (j) => (Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isVoid = (s) => /VOID|CANCEL/i.test(s || '');

let TOKEN;
async function api(ep, body, attempts = 4) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e) { last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

async function pageAll(ep) {
  const out = [];
  for (let off = 0; off < 200000; off += PAGE) {
    const rows = listRows(await api(ep, { searchKey: '', limit: PAGE, offset: off }));
    out.push(...rows);
    if (rows.length < PAGE) break;
    if ((off / PAGE) % 20 === 19) process.stdout.write(`   ...${ep} ${out.length}\n`);
  }
  return out;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST} | window ${FROM}..${TO} | READ-ONLY\n`);
  TOKEN = (await api('login', { username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }))?.data?.token;
  if (!TOKEN) throw new Error('Could not log in to the live system.');

  const [bpLocal] = await pool.query('SELECT bill_payment_no AS no, total_amount, check_no, status FROM bill_payments');
  const [chLocal] = await pool.query('SELECT cheque_no AS no, total_amount, cheque_number AS check_no, status FROM cheques');

  const kinds = [
    { kind: 'Bill Payment', ep: 'get_bill_payments', local: new Map(bpLocal.map((r) => [r.no, r])) },
    { kind: 'Cheque', ep: 'get_cheques', local: new Map(chLocal.map((r) => [r.no, r])) },
  ];
  const findings = [];
  for (const k of kinds) {
    const live = await pageAll(k.ep);
    let inWindow = 0;
    const seen = new Set();
    for (const r of live) {
      const no = clean(r.user_pk);
      const d = day(r.DateCreated_TransH);
      if (!no || seen.has(no) || isVoid(r.Status_TransH) || d < FROM || d > TO) continue;
      seen.add(no); inWindow += 1;
      const base = { kind: k.kind, no, date: d, payee: clean(r.Name_Accnt), amount: num(r.TotalAmount_TransH),
        check_no: clean(r.CheckNo_TransH), method: clean(r.PaymentMethod_TransH), bank: clean(r.Title_COA), bill: clean(r.sl_pk) };
      const here = k.local.get(no);
      if (!here) findings.push({ ...base, issue: 'MISSING' });
      else if (Math.abs(num(here.total_amount) - base.amount) > 0.01) {
        findings.push({ ...base, issue: `AMOUNT DIFFERS (here ${num(here.total_amount).toFixed(2)}${here.status === 'voided' ? ', voided here' : ''})` });
      } else if (base.check_no && !clean(here.check_no)) findings.push({ ...base, issue: 'CHECK NO. BLANK HERE' });
    }
    const mine = findings.filter((f) => f.kind === k.kind);
    const count = (p) => mine.filter((f) => f.issue.startsWith(p)).length;
    console.log(`${k.kind}s on live (not voided, in window): ${inWindow}`);
    console.log(`   missing here            : ${count('MISSING')}`);
    console.log(`   amount differs          : ${count('AMOUNT')}`);
    console.log(`   check no. blank here    : ${count('CHECK')}`);
    const byMonth = {};
    for (const f of mine.filter((x) => x.issue === 'MISSING')) byMonth[f.date.slice(0, 7)] = (byMonth[f.date.slice(0, 7)] || 0) + 1;
    if (Object.keys(byMonth).length) console.log(`   missing by month        : ${Object.entries(byMonth).sort().map(([m, n]) => `${m}:${n}`).join('  ')}`);
    for (const f of mine.filter((x) => x.issue === 'MISSING').slice(0, 15)) {
      console.log(`      ${f.no}  ${f.date}  ${f.amount.toFixed(2).padStart(12)}  chk ${f.check_no || '-'}  ${f.payee}${f.bill ? `  (pays ${f.bill})` : ''}`);
    }
    console.log('');
  }

  const cols = ['issue', 'kind', 'no', 'date', 'payee', 'amount', 'check_no', 'method', 'bank', 'bill'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(OUT, [cols.join(','), ...findings.map((f) => cols.map((c) => esc(f[c])).join(','))].join('\n'));
  console.log(`Full list (${findings.length} row(s)) written to ${OUT}`);
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
