// Migrate the stock-movement chain in one pass, in dependency order:
//
//   Transfer Order  --(SysFK_TransHTO_TransH)-->  Item Fulfillment  --(SysFK_TransHSL_TransH)-->  Item Receipt
//   TO-####                                       IF-####                                         IR-####
//
// Headers link by document number, which is stored on both sides. LINES link by live's own
// key: an Item Fulfillment line names the Transfer Order line it fulfils, and an Item Receipt
// line names the Fulfillment line it receives, both through SysFK_LdgrInvtySL_LdgrInvty.
// That key is kept in <table>.live_pk (see add-transfer-chain-live-pk.js) so the chain can be
// rebuilt on a resumed run instead of only inside one process.
//
// EVERY LINK IN THIS CHAIN IS NOT NULL, by design: a fulfilment must know its transfer order
// AND the order line it fulfils; a receipt must know both the fulfilment and the order. So a
// document whose parent did not import is skipped rather than half-stored, and the run
// reports how many were dropped for that reason.
//
// ITEMS. Lines reference an item only by live pk, and item_id is NOT NULL. live_item_pk_map
// covers what earlier importers harvested from purchase orders (1,625 items), which resolved
// just 67% of transfer-order lines. get_inventories cannot be listed in full -- it times out,
// which is why that harvesting approach exists -- but it CAN be queried for a single pk, so
// unmapped items are looked up once, matched to inventories.item_code, and written back to
// live_item_pk_map. That permanently improves every importer that depends on the map.
//
// RESUMABLE + IDEMPOTENT at every level (documents are skipped by their number).
//
//   node src/db/import-transfer-chain.js --dry-run
//   node src/db/import-transfer-chain.js
//   node src/db/import-transfer-chain.js --only=to        (or =if / =ir)
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const PAGE = 200;

const day = (v) => (v || '').toString().slice(0, 10);
const dOrNull = (v) => { const s = day(v); return s && s >= '1990-01-01' ? s : null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

// Live labels a transfer order for display ("Pending Fulfillment", "CANCELLED"); this app
// filters on the snake_case keys in TransferOrders.jsx STATUS_TABS. Storing live's string
// verbatim leaves every tab except Received empty, because 'received' is the only value that
// happens to coincide -- 1,896 orders were invisible in the list until this map existed.
const TO_STATUS = new Map([
  ['pending fulfillment', 'pending_fulfillment'],
  ['pending', 'pending_fulfillment'], // nothing fulfilled yet, so it belongs in the first tab
  ['partially fulfilled', 'partially_fulfilled'],
  ['pending receipt', 'pending_receipt'],
  ['pending receipt / partially fulfilled', 'pending_receipt_partially_fulfilled'],
  ['received', 'received'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
]);
const mapToStatus = (s) => TO_STATUS.get(norm(s)) || 'pending_fulfillment';

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

  // ---- local lookups -------------------------------------------------------------------
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const [items] = await pool.query('SELECT id, item_code FROM inventories');
  const itemByCode = new Map(items.map((i) => [norm(i.item_code), i.id]));
  const [emps] = await pool.query("SELECT id, CONCAT(first_name,' ',last_name) nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));
  const [users] = await pool.query('SELECT id, display_name FROM users');
  const userByName = new Map(users.map((u) => [norm(u.display_name), u.id]));
  const [jos] = await pool.query('SELECT id, job_order_no FROM job_orders');
  const joByNo = new Map(jos.map((j) => [j.job_order_no, j.id]));

  const [imap] = await pool.query('SELECT live_item_pk, item_id FROM live_item_pk_map');
  const itemByLivePk = new Map(imap.map((r) => [r.live_item_pk, r.item_id]));
  console.log(`live_item_pk_map starts with ${itemByLivePk.size} item(s).`);

  const token = await login();

  // Live location pk -> local id.
  const locByLivePk = new Map();
  for (let off = 0; off < 5000; off += PAGE) {
    const rows = listRows(await api(token, 'get_locations', { searchKey: '', limit: PAGE, offset: off }));
    if (!rows.length) break;
    for (const l of rows) {
      const local = locByName.get(norm(l.Name_Loc));
      if (local) locByLivePk.set(l.SysPK_Loc, local);
    }
    if (rows.length < PAGE) break;
  }
  console.log(`Mapped ${locByLivePk.size} live location(s).`);

  // Resolve an item pk, looking it up on live once and caching it for good. get_inventories
  // cannot be listed in full but answers a single-pk query fine.
  let itemLookups = 0, itemLearned = 0;
  const itemUnresolvable = new Set();
  async function resolveItem(pk) {
    if (!pk) return null;
    if (itemByLivePk.has(pk)) return itemByLivePk.get(pk);
    if (itemUnresolvable.has(pk)) return null;
    itemLookups += 1;
    let code = null;
    try {
      const rows = listRows(await api(token, 'get_inventories', { where: { SysPK_Invty: pk }, limit: 1 }, 3));
      code = rows[0]?.UserPK_Invty || null;
    } catch { /* fall through to unresolvable */ }
    const localId = code ? (itemByCode.get(norm(code)) || null) : null;
    if (!localId) { itemUnresolvable.add(pk); return null; }
    itemByLivePk.set(pk, localId);
    if (!DRY_RUN) {
      await pool.query('INSERT IGNORE INTO live_item_pk_map (live_item_pk, item_id) VALUES (?, ?)', [pk, localId]);
    }
    itemLearned += 1;
    return localId;
  }

  // Live JO pk -> local job_orders.id, cached the same way items are. A transfer order line
  // says which job order it is for, and that is what the Items tab's "JO #" column shows.
  let joLookups = 0;
  const joUnresolvable = new Set();
  const joByLivePk = new Map();
  async function resolveJobOrder(pk) {
    if (!pk) return null;
    if (joByLivePk.has(pk)) return joByLivePk.get(pk);
    if (joUnresolvable.has(pk)) return null;
    joLookups += 1;
    let no = null;
    try {
      const rows = listRows(await api(token, 'get_transactions', { where: { SysPK_TransH: pk }, limit: 1 }, 3));
      no = rows[0]?.UserPK_TransH || null;
    } catch { /* fall through */ }
    const localId = no ? (joByNo.get(no) || null) : null;
    if (!localId) { joUnresolvable.add(pk); return null; }
    joByLivePk.set(pk, localId);
    return localId;
  }

  const stats = { to: 0, toLines: 0, if: 0, ifLines: 0, ir: 0, irLines: 0 };
  const skipped = { noParentTo: 0, noParentIf: 0, noToLine: 0, noIfLine: 0, noItem: 0, noLocation: 0, failed: 0 };

  // ---- existing state, so a re-run resumes -------------------------------------------
  const [toRows] = await pool.query('SELECT id, to_no FROM transfer_orders');
  const toByNo = new Map(toRows.map((r) => [r.to_no, r.id]));
  const [toLineRows] = await pool.query('SELECT id, live_pk FROM transfer_order_lines WHERE live_pk IS NOT NULL');
  const toLineByLivePk = new Map(toLineRows.map((r) => [r.live_pk, r.id]));
  const [ifRows] = await pool.query('SELECT id, fulfillment_no FROM item_fulfillments');
  const ifByNo = new Map(ifRows.map((r) => [r.fulfillment_no, r.id]));
  const [ifLineRows] = await pool.query('SELECT id, live_pk, transfer_order_line_id FROM item_fulfillment_lines WHERE live_pk IS NOT NULL');
  const ifLineByLivePk = new Map(ifLineRows.map((r) => [r.live_pk, r]));
  const [irRows] = await pool.query('SELECT receipt_no FROM item_receipts');
  const irByNo = new Set(irRows.map((r) => r.receipt_no));
  console.log(`Already local: ${toByNo.size} TO, ${ifByNo.size} IF, ${irByNo.size} IR.\n`);

  // transaction_transactionto / _sl carry the parent documents by NUMBER, which is how the
  // chain is matched -- the bare FKs are live UUIDs that mean nothing locally.
  // Paged to exhaustion, NOT stopped at the first short page. Live returns a short page
  // transiently under load, and treating that as the end silently truncated the Item Receipt
  // pass at exactly 18,000 of 40,836 -- it looked like a clean finish. Only two consecutive
  // empty pages end a module.
  async function pageModule(mod, handler, includes = []) {
    let emptyStreak = 0;
    for (let off = 0; off < 400000; off += PAGE) {
      let rows = [];
      try {
        rows = listRows(await api(token, 'get_transactions', {
          where: { Module_TransH: mod },
          include: ['transaction_transactionledgerinvtys', ...includes],
          limit: PAGE, offset: off,
        }));
      } catch (e) {
        console.warn(`  !! ${mod} page at ${off} failed: ${e.message}`);
        skipped.failed += 1; continue;
      }
      if (!rows.length) {
        emptyStreak += 1;
        if (emptyStreak >= 2) break;
        continue;
      }
      emptyStreak = 0;
      for (const r of rows) await handler(r);
    }
  }

  // ---- 1. Transfer Orders --------------------------------------------------------------
  if (!ONLY || ONLY === 'to') {
    console.log('=== Transfer Orders ===');
    let seen = 0;
    await pageModule('TRANSFERORDER', async (h) => {
      seen += 1;
      const toNo = h.UserPK_TransH;
      if (!toNo || toByNo.has(toNo)) return;
      const from = locByLivePk.get(h.SysFK_Loc_TransH) || null;
      const to = locByLivePk.get(h.SysFK_Loc2_TransH) || null;
      const dc = dOrNull(h.DateCreated_TransH);
      // withdraw/transfer locations and the date are NOT NULL -- without them there is no
      // transfer to speak of.
      if (!from || !to || !dc) { skipped.noLocation += 1; return; }

      const rawLines = h.transaction_transactionledgerinvtys || [];
      const lines = [];
      for (let i = 0; i < rawLines.length; i += 1) {
        const l = rawLines[i];
        const itemId = await resolveItem(l.SysFK_Invty_LdgrInvty);
        if (!itemId) { skipped.noItem += 1; continue; }
        lines.push({
          live_pk: l.SysPK_LdgrInvty,
          line_no: i + 1,
          item_id: itemId,
          // The line names its job order only by live pk. resolveJobOrder looks it up once
          // and caches it -- the ledger-invty endpoint has no JO include to piggyback on.
          job_order_id: await resolveJobOrder(l.SysFK_TransHJO_LdgrInvty),
          // The ordered quantity is POQty. QtyIn/QtyOut are the MOVEMENT, so both are 0
          // until the order is fulfilled -- reading them left qty at 0 on every pending line
          // (3,741 of 65,933), while live showed the real figure.
          to_count: num(l.POQty_LdgrInvty) || num(l.QtyIn_LdgrInvty) || num(l.QtyOut_LdgrInvty),
          qty: num(l.POQty_LdgrInvty) || num(l.QtyIn_LdgrInvty) || num(l.QtyOut_LdgrInvty),
          uom: l.UnitOfMeasure_LdgrInvty || null,
          unit: l.Unit_LdgrInvty || null,
          committed: num(l.CommittedQty_LdgrInvty),
          fulfilled: num(l.FullfilledQty_LdgrInvty),
          received: num(l.ReceivedQty_LdgrInvty),
          qty_on_hand: num(l.QtyOnHand_LdgrInvty),
          memo: l.Particulars_LdgrInvty || null,
        });
      }
      if (!lines.length) return;

      // A dry run still records the document and its lines in the lookup maps, with
      // placeholder ids. Without this the Item Fulfillment pass would find no parent for
      // anything and report the whole chain as broken -- an artefact of not inserting, not a
      // real finding.
      if (DRY_RUN) {
        stats.to += 1; stats.toLines += lines.length;
        toByNo.set(toNo, -1);
        for (const l of lines) if (l.live_pk) toLineByLivePk.set(l.live_pk, -1);
        return;
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO transfer_orders (to_no, date_created, date_needed, withdraw_from_location_id,
                                        transfer_to_location_id, requestor_id, memo, status, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [toNo, dc, dOrNull(h.DeliveryDate_TransH), from, to,
            // The requestor is the employee on the header (transaction_employee), NOT
            // PreparedBy_TransH -- that field is empty on transfer orders.
            empByName.get(norm(h.transaction_employee?.Name_Empl)) || null, h.Memo_TransH || null,
            mapToStatus(h.Status_TransH), userByName.get(norm(h.PreparedBy_TransH)) || null]
        );
        for (const l of lines) {
          const [lr] = await conn.query(
            `INSERT INTO transfer_order_lines (transfer_order_id, line_no, item_id, job_order_id, qty, to_count, uom, unit,
                                               committed, fulfilled, received, qty_on_hand, memo, live_pk)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.insertId, l.line_no, l.item_id, l.job_order_id, l.qty, l.to_count, l.uom, l.unit,
              l.committed, l.fulfilled, l.received, l.qty_on_hand, l.memo, l.live_pk]
          );
          if (l.live_pk) toLineByLivePk.set(l.live_pk, lr.insertId);
        }
        await conn.commit();
        toByNo.set(toNo, r.insertId);
        stats.to += 1; stats.toLines += lines.length;
      } catch (e) {
        await conn.rollback(); skipped.failed += 1;
        console.warn(`  !! ${toNo} failed: ${e.message}`);
      } finally { conn.release(); }
      if (stats.to % 2000 === 0) console.log(`  ...${seen} seen, ${stats.to} imported`);
    }, ['transaction_employee']);
    console.log(`Transfer Orders: ${stats.to} imported (${stats.toLines} lines) of ${seen} seen.\n`);
  }

  // ---- 2. Item Fulfillments ------------------------------------------------------------
  if (!ONLY || ONLY === 'if') {
    console.log('=== Item Fulfillments ===');
    let seen = 0;
    await pageModule('ITEMFULFILL', async (h) => {
      seen += 1;
      const ifNo = h.UserPK_TransH;
      if (!ifNo || ifByNo.has(ifNo)) return;
      // The parent TO is named by number on the linked transaction; fall back to the FK's
      // document when the include is absent.
      const toNo = h.transaction_transactionto?.UserPK_TransH || null;
      const toId = toNo ? toByNo.get(toNo) : null;
      if (!toId) { skipped.noParentTo += 1; return; }
      const dc = dOrNull(h.DateCreated_TransH);
      if (!dc) { skipped.failed += 1; return; }

      const rawLines = h.transaction_transactionledgerinvtys || [];
      const lines = [];
      for (const l of rawLines) {
        const toLineId = toLineByLivePk.get(l.SysFK_LdgrInvtySL_LdgrInvty);
        if (!toLineId) { skipped.noToLine += 1; continue; }
        const itemId = await resolveItem(l.SysFK_Invty_LdgrInvty);
        if (!itemId) { skipped.noItem += 1; continue; }
        lines.push({
          live_pk: l.SysPK_LdgrInvty,
          transfer_order_line_id: toLineId,
          item_id: itemId,
          qty_fulfilled: num(l.QtyOut_LdgrInvty) || num(l.FullfilledQty_LdgrInvty),
          memo: l.Particulars_LdgrInvty || null,
        });
      }
      if (!lines.length) return;

      if (DRY_RUN) {
        stats.if += 1; stats.ifLines += lines.length;
        ifByNo.set(ifNo, -1);
        for (const l of lines) if (l.live_pk) ifLineByLivePk.set(l.live_pk, { id: -1, transfer_order_line_id: l.transfer_order_line_id });
        return;
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO item_fulfillments (fulfillment_no, transfer_order_id, date_created, memo, created_by_user_id)
           VALUES (?, ?, ?, ?, ?)`,
          [ifNo, toId, dc, h.Memo_TransH || null, userByName.get(norm(h.PreparedBy_TransH)) || null]
        );
        for (const l of lines) {
          const [lr] = await conn.query(
            `INSERT INTO item_fulfillment_lines (item_fulfillment_id, transfer_order_line_id, item_id, qty_fulfilled, memo, live_pk)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [r.insertId, l.transfer_order_line_id, l.item_id, l.qty_fulfilled, l.memo, l.live_pk]
          );
          if (l.live_pk) ifLineByLivePk.set(l.live_pk, { id: lr.insertId, transfer_order_line_id: l.transfer_order_line_id });
        }
        await conn.commit();
        ifByNo.set(ifNo, r.insertId);
        stats.if += 1; stats.ifLines += lines.length;
      } catch (e) {
        await conn.rollback(); skipped.failed += 1;
        console.warn(`  !! ${ifNo} failed: ${e.message}`);
      } finally { conn.release(); }
      if (stats.if % 2000 === 0) console.log(`  ...${seen} seen, ${stats.if} imported`);
    }, ['transaction_transactionto']);
    console.log(`Item Fulfillments: ${stats.if} imported (${stats.ifLines} lines) of ${seen} seen.\n`);
  }

  // ---- 3. Item Receipts ----------------------------------------------------------------
  if (!ONLY || ONLY === 'ir') {
    console.log('=== Item Receipts ===');
    let seen = 0;
    await pageModule('ITEMRECEIPT', async (h) => {
      seen += 1;
      const irNo = h.UserPK_TransH;
      if (!irNo || irByNo.has(irNo)) return;
      const toNo = h.transaction_transactionto?.UserPK_TransH || null;
      const ifNo = h.transaction_transactionsl?.UserPK_TransH || null;
      const toId = toNo ? toByNo.get(toNo) : null;
      const ifId = ifNo ? ifByNo.get(ifNo) : null;
      // Both are NOT NULL: a receipt records what a specific fulfilment delivered.
      if (!toId) { skipped.noParentTo += 1; return; }
      if (!ifId) { skipped.noParentIf += 1; return; }
      const dc = dOrNull(h.DateCreated_TransH);
      if (!dc) { skipped.failed += 1; return; }

      const rawLines = h.transaction_transactionledgerinvtys || [];
      const lines = [];
      for (const l of rawLines) {
        const ifLine = ifLineByLivePk.get(l.SysFK_LdgrInvtySL_LdgrInvty);
        if (!ifLine) { skipped.noIfLine += 1; continue; }
        const itemId = await resolveItem(l.SysFK_Invty_LdgrInvty);
        if (!itemId) { skipped.noItem += 1; continue; }
        lines.push({
          live_pk: l.SysPK_LdgrInvty,
          transfer_order_line_id: ifLine.transfer_order_line_id,
          item_fulfillment_line_id: ifLine.id,
          item_id: itemId,
          qty_received: num(l.QtyIn_LdgrInvty) || num(l.ReceivedQty_LdgrInvty),
          memo: l.Particulars_LdgrInvty || null,
        });
      }
      if (!lines.length) return;

      if (DRY_RUN) { stats.ir += 1; stats.irLines += lines.length; return; }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO item_receipts (receipt_no, transfer_order_id, item_fulfillment_id, date_created, memo, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [irNo, toId, ifId, dc, h.Memo_TransH || null, userByName.get(norm(h.PreparedBy_TransH)) || null]
        );
        for (const l of lines) {
          await conn.query(
            `INSERT INTO item_receipt_lines (item_receipt_id, transfer_order_line_id, item_fulfillment_line_id, item_id, qty_received, memo, live_pk)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [r.insertId, l.transfer_order_line_id, l.item_fulfillment_line_id, l.item_id, l.qty_received, l.memo, l.live_pk]
          );
        }
        await conn.commit();
        irByNo.add(irNo);
        stats.ir += 1; stats.irLines += lines.length;
      } catch (e) {
        await conn.rollback(); skipped.failed += 1;
        console.warn(`  !! ${irNo} failed: ${e.message}`);
      } finally { conn.release(); }
      if (stats.ir % 2000 === 0) console.log(`  ...${seen} seen, ${stats.ir} imported`);
    }, ['transaction_transactionto', 'transaction_transactionsl']);
    console.log(`Item Receipts: ${stats.ir} imported (${stats.irLines} lines) of ${seen} seen.\n`);
  }

  console.log('=== Summary ===');
  console.log(`Transfer Orders   : ${stats.to} (${stats.toLines} lines)`);
  console.log(`Item Fulfillments : ${stats.if} (${stats.ifLines} lines)`);
  console.log(`Item Receipts     : ${stats.ir} (${stats.irLines} lines)`);
  console.log(`\nItem pk lookups against live: ${itemLookups}, newly mapped: ${itemLearned}, still unresolvable: ${itemUnresolvable.size}.`);
  console.log(`Job order pk lookups: ${joLookups}, resolved: ${joByLivePk.size}, unresolvable: ${joUnresolvable.size}.`);
  console.log(`live_item_pk_map now holds ${itemByLivePk.size} item(s).`);
  console.log(`Skipped -- parent TO missing: ${skipped.noParentTo}, parent IF missing: ${skipped.noParentIf}, ` +
    `TO line missing: ${skipped.noToLine}, IF line missing: ${skipped.noIfLine}, ` +
    `item unresolvable: ${skipped.noItem}, location/date missing: ${skipped.noLocation}, errors: ${skipped.failed}.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
