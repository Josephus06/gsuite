// Backfills two fields the first transfer-order import left empty:
//
//   transfer_orders.requestor_id       -- read from PreparedBy_TransH, which is blank on
//       transfer orders. The requestor is the employee on the header, reachable through the
//       transaction_employee include (Name_Empl, e.g. "Omar M Arranguez").
//   transfer_order_lines.job_order_id  -- collected from the line as a live pk and then never
//       written. The Items tab's "JO #" column has been empty for every imported order.
//
// Both are fixed in import-transfer-chain.js for future runs; this repairs the 38,190 orders
// and 65,933 lines already stored, without re-importing them.
//
// A line names its job order only by live pk and the ledger-invty endpoint has no JO include,
// so each distinct pk is looked up once and cached -- the same approach the importer uses for
// items.
//
// RESUMABLE: only rows still missing the value are touched, so a killed run resumes.
//
//   node src/db/backfill-transfer-order-jo-requestor.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const PAGE = 200;

const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}

async function api(token, ep, payload, attempts = 4) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000 + a * 15000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal,
      });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [emps] = await pool.query("SELECT id, CONCAT(first_name,' ',last_name) nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));
  const [jos] = await pool.query('SELECT id, job_order_no FROM job_orders');
  const joByNo = new Map(jos.map((j) => [j.job_order_no, j.id]));

  const [toRows] = await pool.query('SELECT id, to_no FROM transfer_orders');
  const toByNo = new Map(toRows.map((r) => [r.to_no, r.id]));
  const [lineRows] = await pool.query('SELECT id, live_pk FROM transfer_order_lines WHERE live_pk IS NOT NULL');
  const lineByLivePk = new Map(lineRows.map((r) => [r.live_pk, r.id]));
  console.log(`Local: ${toByNo.size} transfer order(s), ${lineByLivePk.size} line(s) with a live key, ${joByNo.size} job order(s) to match.\n`);

  const token = await login();

  const joByLivePk = new Map();
  const joUnresolvable = new Set();
  let joLookups = 0;
  async function resolveJobOrder(pk) {
    if (!pk) return null;
    if (joByLivePk.has(pk)) return joByLivePk.get(pk);
    if (joUnresolvable.has(pk)) return null;
    joLookups += 1;
    let no = null;
    try {
      const rows = listRows(await api(token, 'get_transactions', { where: { SysPK_TransH: pk }, limit: 1 }, 3));
      no = rows[0]?.UserPK_TransH || null;
    } catch { /* leave unresolved */ }
    const localId = no ? (joByNo.get(no) || null) : null;
    if (!localId) { joUnresolvable.add(pk); return null; }
    joByLivePk.set(pk, localId);
    return localId;
  }

  let seen = 0, reqSet = 0, reqMissing = 0, joSet = 0, joMissing = 0, lineNotLocal = 0, qtySet = 0;
  let emptyStreak = 0;

  for (let off = 0; off < 400000; off += PAGE) {
    let rows = [];
    try {
      rows = listRows(await api(token, 'get_transactions', {
        where: { Module_TransH: 'TRANSFERORDER' },
        include: ['transaction_transactionledgerinvtys', 'transaction_employee'],
        limit: PAGE, offset: off,
      }));
    } catch (e) { console.warn(`  !! page ${off} failed: ${e.message}`); }

    if (!rows.length) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;

    for (const h of rows) {
      seen += 1;
      const toId = toByNo.get(h.UserPK_TransH);
      if (!toId) continue;

      const empName = h.transaction_employee?.Name_Empl;
      const empId = empByName.get(norm(empName)) || null;
      if (empId) {
        const [r] = await pool.query(
          'UPDATE transfer_orders SET requestor_id = ? WHERE id = ? AND requestor_id IS NULL', [empId, toId]
        );
        reqSet += r.affectedRows;
      } else if (empName) { reqMissing += 1; }

      for (const l of (h.transaction_transactionledgerinvtys || [])) {
        const lineId = lineByLivePk.get(l.SysPK_LdgrInvty);
        if (!lineId) { lineNotLocal += 1; continue; }

        // Ordered qty: POQty, not QtyIn/QtyOut (those are the movement and stay 0 until
        // the order is fulfilled). Only touches lines still sitting at 0.
        const orderedQty = Number(l.POQty_LdgrInvty) || Number(l.QtyIn_LdgrInvty) || Number(l.QtyOut_LdgrInvty) || 0;
        if (orderedQty) {
          const [qr] = await pool.query(
            'UPDATE transfer_order_lines SET qty = ?, to_count = ? WHERE id = ? AND qty = 0', [orderedQty, orderedQty, lineId]
          );
          qtySet += qr.affectedRows;
        }
        if (!l.SysFK_TransHJO_LdgrInvty) continue;
        const joId = await resolveJobOrder(l.SysFK_TransHJO_LdgrInvty);
        if (!joId) { joMissing += 1; continue; }
        const [r] = await pool.query(
          'UPDATE transfer_order_lines SET job_order_id = ? WHERE id = ? AND job_order_id IS NULL', [joId, lineId]
        );
        joSet += r.affectedRows;
      }
    }
    if (seen % 2000 < PAGE) console.log(`  ...${seen} seen | requestor +${reqSet}, JO +${joSet} (${joLookups} lookups)`);
  }

  console.log(`\nDone. Seen ${seen} transfer order(s).`);
  console.log(`Requestor set on ${reqSet} order(s); ${reqMissing} named an employee with no local record.`);
  console.log(`Job order set on ${joSet} line(s); ${joMissing} referenced a job order not held locally.`);
  console.log(`Quantity repaired on ${qtySet} line(s) that were stored as 0.`);
  console.log(`JO pk lookups: ${joLookups}, distinct resolved: ${joByLivePk.size}, unresolvable: ${joUnresolvable.size}.`);
  if (lineNotLocal) console.log(`${lineNotLocal} live line(s) had no local row (their order was skipped at import).`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
