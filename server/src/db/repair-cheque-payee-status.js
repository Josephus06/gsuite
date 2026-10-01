// Repair migrated cheques against live: Payee, Payee Name, payee type and status.
//
// THE DEFECT (see lib/chequeSource.js): the importer stored live's free-typed Payee Name as the
// payee and matched it against suppliers, dropping the real payee account (CHK-9120: vendor
// YUTYCO ELECTRIC, payee name RANDILL CAPARROSO -> stored as RANDILL, no vendor). It also wrote
// payee_type 'supplier' where the form expects 'VENDOR', and folded FULLY APPLIED into 'open'.
//
// Touches only cheques.payee_type / payee_id / payee_name / status. Each UPDATE is guarded on
// the values read, so a cheque edited in T1S meanwhile is left alone and reported. The rollback
// file holds the old values.
//
//   node src/db/repair-cheque-payee-status.js            # dry run: counts + samples
//   node src/db/repair-cheque-payee-status.js --apply    # write; rollback JSON in rollback/
// Run from server/ -- the DB settings come from server/.env.
//   node src/db/repair-cheque-payee-status.js --rollback=<file>
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();
const { chequeStatus, makePayeeResolver } = require('../lib/chequeSource');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=')[1];
const PAGE = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const TYPE_CODE = { supplier: 'VENDOR', customer: 'CUSTOMER', employee: 'EMPLOYEE', VENDOR: 'VENDOR', CUSTOMER: 'CUSTOMER', EMPLOYEE: 'EMPLOYEE' };
const same = (a, b) => (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}

async function api(token, ep, payload, attempts = 5) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000 + a * 20000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal,
      });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

async function rollback(file) {
  const ops = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const o of ops) {
    const [r] = await pool.query(
      'UPDATE cheques SET payee_type = ?, payee_id = ?, payee_name = ?, status = ? WHERE id = ?',
      [o.old.payee_type, o.old.payee_id, o.old.payee_name, o.old.status, o.id]);
    n += r.affectedRows;
  }
  console.log(`Rolled back ${n} of ${ops.length} cheque(s).`);
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (ROLLBACK) { await rollback(ROLLBACK); return; }
  console.log(APPLY ? 'APPLYING.\n' : 'DRY RUN -- pass --apply to write.\n');

  const resolvePayee = await makePayeeResolver(pool);
  const [locals] = await pool.query('SELECT id, cheque_no, payee_type, payee_id, payee_name, status FROM cheques');
  const byNo = new Map(locals.map((c) => [c.cheque_no, c]));
  console.log(`Local cheques: ${locals.length}`);

  const token = await login();
  const ops = [];
  const tally = { seen: 0, notLocal: 0, unchanged: 0, payee: 0, status: 0, unresolvedPayee: 0 };
  const statusMoves = {};
  const unresolved = new Map();

  for (let off = 0; off < 100000; off += PAGE) {
    const page = listRows(await api(token, 'get_transactions', {
      where: { Module_TransH: 'CHEQUE' }, include: ['transaction_account'], limit: PAGE, offset: off,
    }));
    if (!page.length) break;
    for (const h of page) {
      tally.seen += 1;
      const c = byNo.get(h.UserPK_TransH);
      if (!c) { tally.notLocal += 1; continue; }
      const accountName = h.transaction_account?.Name_Accnt || null;
      const p = resolvePayee(h, accountName);
      if (p.payeeType && !p.payeeId && accountName) {
        tally.unresolvedPayee += 1;
        unresolved.set(`${p.payeeType} ${accountName}`, (unresolved.get(`${p.payeeType} ${accountName}`) || 0) + 1);
      }
      const want = {
        payee_type: p.payeeType || c.payee_type,
        // Never trade a payee link we have for none: when live's account cannot be matched,
        // keep the old id as long as it points at the same kind of record.
        payee_id: p.payeeId || (p.payeeType && p.payeeType !== TYPE_CODE[c.payee_type] ? null : c.payee_id),
        payee_name: p.payeeName || c.payee_name,
        status: chequeStatus(h.Status_TransH),
      };
      const payeeDiff = !same(want.payee_type, c.payee_type) || !same(want.payee_id, c.payee_id) || !same(want.payee_name, c.payee_name);
      const statusDiff = !same(want.status, c.status);
      if (!payeeDiff && !statusDiff) { tally.unchanged += 1; continue; }
      if (payeeDiff) tally.payee += 1;
      if (statusDiff) { tally.status += 1; const k = `${c.status} -> ${want.status}`; statusMoves[k] = (statusMoves[k] || 0) + 1; }
      ops.push({ id: c.id, cheque_no: c.cheque_no, account: accountName,
        old: { payee_type: c.payee_type, payee_id: c.payee_id, payee_name: c.payee_name, status: c.status }, new: want });
    }
    process.stdout.write(`\r  read ${tally.seen} from live, ${ops.length} to fix`);
    if (page.length < PAGE) break;
  }
  console.log('\n');
  console.log(tally);
  console.log('Status moves:', statusMoves);
  if (unresolved.size) {
    console.log(`Payee accounts with no local match (${unresolved.size} distinct; type kept, id left empty):`);
    [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => console.log(`  ${n}x ${k}`));
  }
  console.log('\nSamples:');
  for (const o of ops.slice(0, 12)) {
    console.log(`  ${o.cheque_no}: payee ${o.old.payee_type || '-'}#${o.old.payee_id || '-'} "${o.old.payee_name}" -> ${o.new.payee_type}#${o.new.payee_id || '-'} [${o.account}] name "${o.new.payee_name}"; status ${o.old.status} -> ${o.new.status}`);
  }
  const nineTwenty = ops.find((o) => o.cheque_no === 'CHK-9120');
  if (nineTwenty) console.log('\nCHK-9120:', JSON.stringify(nineTwenty));

  if (!APPLY) return;
  fs.mkdirSync('rollback', { recursive: true });
  const file = `rollback/cheque-payee-status-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify(ops, null, 1));
  console.log(`\nRollback file: ${file}`);
  let done = 0; let skipped = 0;
  for (const o of ops) {
    const [r] = await pool.query(
      `UPDATE cheques SET payee_type = ?, payee_id = ?, payee_name = ?, status = ?
       WHERE id = ? AND payee_type <=> ? AND payee_id <=> ? AND payee_name <=> ? AND status <=> ?`,
      [o.new.payee_type, o.new.payee_id, o.new.payee_name, o.new.status,
        o.id, o.old.payee_type, o.old.payee_id, o.old.payee_name, o.old.status]);
    if (r.affectedRows) done += 1; else { skipped += 1; console.log(`  skipped ${o.cheque_no}: changed since read`); }
  }
  console.log(`Updated ${done}, skipped ${skipped}.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
