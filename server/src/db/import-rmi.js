// Migrates Return Material Inventory documents from live into rmis / rmi_lines.
//
// Live keeps every document type in one transaction table, so an RMI is a TransH row with
// Module_TransH = 'RMI' and its lines hang off it as transaction_transactionledgerinvtys --
// the same shape import-transfer-chain.js reads.
//
// THE TWO QUANTITY FIELDS, which are not named what you would expect:
//
//   AdjustQty_LdgrInvty  -> the grid's "Qty" column. Non-zero on all 264 lines.
//   QtyOut_LdgrInvty     -> the grid's "Received" column. Non-zero only once something has
//                           actually been received (214 of 264 lines).
//
// Qty_LdgrInvty, QtyIn_LdgrInvty and ReceivedQty_LdgrInvty are all zero on every RMI line
// live holds, so none of them is the field to read despite the names.
//
// NO STOCK IS MOVED. Local inventory_locations carries token quantities, not a mirror of
// live's on-hand, and no other importer here replays movements either. Replaying 199 returns
// against balances whose inbound history was never replayed would drive every source
// warehouse negative -- see the block comment in create-rmi.js. Documents in; movement is for
// RMIs raised in this app.
//
// RESUMABLE + IDEMPOTENT: documents are keyed on live's SysPK_TransH via rmis.live_pk, so a
// second run updates rather than duplicates.
//
//   node src/db/import-rmi.js --dry-run
//   node src/db/import-rmi.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');

const day = (v) => (v || '').toString().slice(0, 10);
const dOrNull = (v) => { const s = day(v); return s && s >= '1990-01-01' ? s : null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

// Live's display strings -> the keys the list's status tabs filter on. Note the trailing
// space live really does store on "Received "; norm() takes care of it.
const STATUS = new Map([
  ['received', 'received'],
  ['partially received', 'partially_received'],
  ['pending receipt', 'pending_receipt'],
  ['pending', 'pending_receipt'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
]);

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  console.log(DRY_RUN ? 'DRY RUN -- fetch + report only.\n' : 'APPLYING.\n');

  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const [emps] = await pool.query("SELECT id, CONCAT(first_name,' ',last_name) nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));
  const [jos] = await pool.query('SELECT id, job_order_no FROM job_orders');
  const joByNo = new Map(jos.map((j) => [j.job_order_no, j.id]));
  const [imap] = await pool.query('SELECT live_item_pk, item_id FROM live_item_pk_map');
  const itemByLivePk = new Map(imap.map((r) => [r.live_item_pk, r.item_id]));
  const [invs] = await pool.query('SELECT id, item_code FROM inventories');
  const itemByCode = new Map(invs.map((i) => [norm(i.item_code), i.id]));
  console.log(`live_item_pk_map starts with ${itemByLivePk.size} item(s).`);

  const token = await login();

  // Live location pk -> local id, matched by name.
  const locByLivePk = new Map();
  for (let off = 0; off < 5000; off += 200) {
    const rows = listRows(await api(token, 'get_locations', { searchKey: '', limit: 200, offset: off }));
    if (!rows.length) break;
    for (const l of rows) {
      const local = locByName.get(norm(l.Name_Loc));
      if (local) locByLivePk.set(l.SysPK_Loc, local);
    }
    if (rows.length < 200) break;
  }
  console.log(`Mapped ${locByLivePk.size} live location(s).`);

  // An unmapped item is looked up once and written back to live_item_pk_map, which
  // permanently improves every importer that depends on it -- the approach
  // import-transfer-chain.js established.
  async function resolveItem(livePk) {
    if (!livePk) return null;
    if (itemByLivePk.has(livePk)) return itemByLivePk.get(livePk);
    const rows = listRows(await api(token, 'get_inventories', { where: { SysPK_Invty: livePk }, limit: 1 }));
    const code = rows[0]?.ItemCode_Invty || rows[0]?.Code_Invty;
    const local = code ? itemByCode.get(norm(code)) : null;
    if (local) {
      itemByLivePk.set(livePk, local);
      if (!DRY_RUN) {
        await pool.query(
          'INSERT IGNORE INTO live_item_pk_map (live_item_pk, item_id) VALUES (?, ?)', [livePk, local],
        );
      }
      console.log(`    resolved unmapped item ${code} -> ${local}`);
    }
    return local || null;
  }

  const headers = listRows(await api(token, 'get_transactions', {
    where: { Module_TransH: 'RMI' },
    include: ['transaction_transactionledgerinvtys', 'transaction_location', 'transaction_locationto'],
    order: [['ID_TransH', 'ASC']],
  }));
  console.log(`Live holds ${headers.length} RMI document(s).\n`);

  const stat = { inserted: 0, updated: 0, skippedNoLocation: 0, skippedNoDate: 0, lines: 0, linesNoItem: 0 };

  for (const h of headers) {
    const rmiNo = h.UserPK_TransH;
    const from = locByLivePk.get(h.SysFK_Loc_TransH) || null;
    const to = locByLivePk.get(h.SysFK_Loc2_TransH) || null;
    const dc = dOrNull(h.DateCreated_TransH);
    if (!from || !to) {
      stat.skippedNoLocation += 1;
      console.log(`  !! ${rmiNo}: location did not resolve (${h.transaction_location?.Name_Loc} -> ${h.transaction_locationto?.Name_Loc})`);
      continue;
    }
    if (!dc) { stat.skippedNoDate += 1; console.log(`  !! ${rmiNo}: no usable date`); continue; }

    const status = STATUS.get(norm(h.Status_TransH)) || 'pending_receipt';
    const preparedBy = empByName.get(norm(h.PreparedBy_TransH)) || null;

    const lines = [];
    for (const l of (h.transaction_transactionledgerinvtys || []).sort((a, b) => num(a.Seq_LdgrInvty) - num(b.Seq_LdgrInvty))) {
      const itemId = await resolveItem(l.SysFK_Invty_LdgrInvty);
      if (!itemId) { stat.linesNoItem += 1; continue; }
      lines.push({
        live_pk: l.SysPK_LdgrInvty,
        item_id: itemId,
        job_order_id: joByNo.get(l.JONumber_LdgrInvty) || null,
        qty: num(l.AdjustQty_LdgrInvty),
        received: num(l.QtyOut_LdgrInvty),
        uom: l.UnitOfMeasure_LdgrInvty || null,
        unit: l.Unit_LdgrInvty || null,
        qty_on_hand: num(l.QtyOnHand_LdgrInvty),
        rate: num(l.Rate_LdgrInvty),
        cost: num(l.Cost_LdgrInvty),
      });
    }
    stat.lines += lines.length;

    if (DRY_RUN) {
      stat.inserted += 1;
      console.log(`  ~ ${rmiNo} ${dc} ${status.padEnd(19)} ${lines.length} line(s)`);
      continue;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[existing]] = await conn.query('SELECT id FROM rmis WHERE live_pk = ?', [h.SysPK_TransH]);
      let rmiId;
      if (existing) {
        rmiId = existing.id;
        await conn.query(
          `UPDATE rmis SET rmi_no = ?, date_created = ?, return_from_location_id = ?, return_to_location_id = ?,
                  returned_by_employee_id = ?, memo = ?, status = ?, received_at = ?, cancelled_at = ?
            WHERE id = ?`,
          [rmiNo, dc, from, to, preparedBy, h.Memo_TransH || null, status,
            status === 'received' ? dOrNull(h.DateUpdated_TransH) : null,
            status === 'cancelled' ? dOrNull(h.DateCancelled_TransH) : null, rmiId],
        );
        await conn.query('DELETE FROM rmi_lines WHERE rmi_id = ?', [rmiId]);
        stat.updated += 1;
      } else {
        const [res] = await conn.query(
          `INSERT INTO rmis (rmi_no, date_created, return_from_location_id, return_to_location_id,
                             returned_by_employee_id, memo, status, received_at, cancelled_at, live_pk)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [rmiNo, dc, from, to, preparedBy, h.Memo_TransH || null, status,
            status === 'received' ? dOrNull(h.DateUpdated_TransH) : null,
            status === 'cancelled' ? dOrNull(h.DateCancelled_TransH) : null, h.SysPK_TransH],
        );
        rmiId = res.insertId;
        stat.inserted += 1;
      }

      for (const [i, l] of lines.entries()) {
        await conn.query(
          `INSERT INTO rmi_lines (rmi_id, line_no, item_id, job_order_id, qty, received, uom, unit,
                                  qty_on_hand, rate, cost, live_pk)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [rmiId, i + 1, l.item_id, l.job_order_id, l.qty, l.received, l.uom, l.unit,
            l.qty_on_hand, l.rate, l.cost, l.live_pk],
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      console.error(`  !! ${rmiNo} failed: ${e.message}`);
    } finally { conn.release(); }
  }

  console.log('\n---- summary ----');
  console.log(`inserted            : ${stat.inserted}`);
  console.log(`updated             : ${stat.updated}`);
  console.log(`lines written       : ${stat.lines}`);
  console.log(`skipped (location)  : ${stat.skippedNoLocation}`);
  console.log(`skipped (no date)   : ${stat.skippedNoDate}`);
  console.log(`lines dropped (item): ${stat.linesNoItem}`);

  if (!DRY_RUN) {
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM rmis');
    const [[lc]] = await pool.query('SELECT COUNT(*) n FROM rmi_lines');
    const [byStatus] = await pool.query('SELECT status, COUNT(*) n FROM rmis GROUP BY status ORDER BY n DESC');
    console.log(`\nrmis now: ${c.n} document(s), ${lc.n} line(s)`);
    for (const s of byStatus) console.log(`  ${s.status.padEnd(20)} ${s.n}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
