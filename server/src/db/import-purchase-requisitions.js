// Import named source Purchase Requisitions (PURCHASEREQ) with their lines -- never migrated, and
// purchasing continues from the open ones.
//
//   header   pr_no / date / needed-by (DeliveryDate) / department (by name) / requestor (the
//            source employee, by name) / memo / status
//   lines    get_transaction_ledger_invtys: item (source item key -> its code -> ours), requested
//            qty (PRQty), ordered qty (POQty), received qty, unit, description, JO (if any)
// A line whose item T1S does not hold is reported and left out (item_id is required); a PR with
// none left is skipped. PRs already in T1S (by number) are skipped, so it is safe to re-run.
//
//   node src/db/import-purchase-requisitions.js --file=prs.txt [--dry-run]   (lines "PR-# <SysPK>")
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1];
if (!fileArg) { console.error('Usage: --file=path (lines "PR-# <SysPK>")'); process.exit(2); }
const items = fs.readFileSync(fileArg, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [no, pk] = l.split(/\s+/); return { no, pk }; });
const CONCURRENCY = 3;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');
const norm = (s) => clean(s).toLowerCase();
const key = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const day = (v) => { const s = v ? String(v).slice(0, 10) : ''; return s >= '1990-01-01' ? s : null; };
const STATUS = { 'pending request': 'pending_request', 'request in-process': 'request_in_process', 'partially served': 'partially_served', completed: 'completed', cancelled: 'cancelled' };

async function main() {
  console.log(`${DRY_RUN ? 'DRY RUN -- ' : ''}${items.length} PR(s). Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  let t = await L.login();
  const [depts] = await pool.query('SELECT id, name FROM departments');
  const deptByName = new Map(depts.map((d) => [key(d.name), d.id]));
  const [emps] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));
  const liveEmps = L.listRows(await L.api(t, 'get_employees', { limit: 5000, offset: 0 }));
  const empNameByPk = new Map(liveEmps.map((e) => [e.SysPK_Empl, clean(e.Name_Empl || `${e.FirstName_Empl || ''} ${e.LastName_Empl || ''}`)]));
  const [invs] = await pool.query('SELECT id, item_code FROM inventories');
  const invByCode = new Map(invs.map((i) => [norm(i.item_code), i.id]));
  const [pkMap] = await pool.query('SELECT live_item_pk, item_id FROM live_item_pk_map');
  const itemByLivePk = new Map(pkMap.map((m) => [m.live_item_pk, m.item_id]));
  const itemCodeByPk = new Map(); // source item key -> its code (fetched once per item)
  const joByPk = new Map();       // source JO key -> our JO id

  async function itemFor(pk) {
    if (!pk) return null;
    if (itemByLivePk.has(pk)) return itemByLivePk.get(pk);
    if (!itemCodeByPk.has(pk)) {
      const r = L.listRows(await L.api(t, 'get_inventories', { where: { SysPK_Invty: pk }, limit: 1 }))[0];
      itemCodeByPk.set(pk, r ? clean(r.UserPK_Invty) : null);
    }
    const code = itemCodeByPk.get(pk);
    return code ? invByCode.get(norm(code)) || null : null;
  }
  async function joFor(pk) {
    if (!pk) return null;
    if (!joByPk.has(pk)) {
      const r = L.listRows(await L.api(t, 'get_transactions', { where: { SysPK_TransH: pk }, limit: 1 }))[0];
      let id = null;
      if (r) { const [[jo]] = await pool.query('SELECT id FROM job_orders WHERE job_order_no = ?', [r.UserPK_TransH]); id = jo ? jo.id : null; }
      joByPk.set(pk, id);
    }
    return joByPk.get(pk);
  }

  const out = { imported: 0, exists: 0, notFound: 0, lines: 0, droppedLines: [], noLines: [], failed: [] };
  let cursor = 0, since = 0;
  async function worker() {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= items.length) return;
      const it = items[i];
      if ((since += 1) >= 300) { since = 0; t = await L.login(); }
      try {
        const [[dup]] = await pool.query('SELECT id FROM purchase_requisitions WHERE pr_no = ?', [it.no]);
        if (dup) { out.exists += 1; continue; }
        const h = L.listRows(await L.api(t, 'get_transactions', { where: { UserPK_TransH: it.no, Module_TransH: 'PURCHASEREQ' }, limit: 1 }))[0];
        if (!h) { out.notFound += 1; continue; }
        const src = L.listRows(await L.api(t, 'get_transaction_ledger_invtys', { where: { SysFK_TransH_LdgrInvty: h.SysPK_TransH } }));
        const lines = [];
        for (const l of src) {
          const itemId = await itemFor(l.SysFK_Invty_LdgrInvty);
          if (!itemId) { out.droppedLines.push(`${it.no}: ${clean(l.DisplayDescription_LdgrInvty).slice(0, 50)}`); continue; }
          lines.push({
            item_id: itemId, desc: clean(l.DisplayDescription_LdgrInvty).slice(0, 500) || null,
            jo: await joFor(l.SysFK_TransHJO_LdgrInvty), qty: num(l.PRQty_LdgrInvty) || num(l.Qty_LdgrInvty),
            po: num(l.POQty_LdgrInvty), rec: num(l.ReceivedQty_LdgrInvty) || num(l.RRQty_LdgrInvty),
            unit: l.UnitOfMeasure_LdgrInvty || null, title: l.Unit_LdgrInvty || null,
          });
        }
        if (!lines.length) { out.noLines.push(it.no); continue; }
        if (DRY_RUN) { out.imported += 1; out.lines += lines.length; continue; }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [r] = await conn.query(
            `INSERT INTO purchase_requisitions (pr_no, date_created, date_needed, department_id, requestor_id, memo, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [it.no, day(h.DateCreated_TransH), day(h.DeliveryDate_TransH), deptByName.get(key(h.DepartmentName_TransH)) || null,
              empByName.get(norm(empNameByPk.get(h.SysFK_Empl_TransH))) || empByName.get(norm(h.PreparedBy_TransH)) || null,
              clean(h.Memo_TransH).slice(0, 1000) || null, STATUS[norm(h.Status_TransH)] || 'request_in_process']);
          let n = 0;
          for (const l of lines) {
            n += 1;
            await conn.query(
              `INSERT INTO purchase_requisition_lines (purchase_requisition_id, line_no, item_id, purchase_description, job_order_id, qty, purchase_unit, unit_title, po_qty, received_qty)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [r.insertId, n, l.item_id, l.desc, l.jo, l.qty, l.unit, l.title, l.po, l.rec]);
          }
          await conn.commit();
          out.imported += 1; out.lines += lines.length;
        } catch (e) { await conn.rollback(); out.failed.push(`${it.no}: ${e.message}`); }
        finally { conn.release(); }
      } catch (e) { out.failed.push(`${it.no}: ${e.message}`); }
      if (out.imported && out.imported % 200 === 0) console.log(`  ...${out.imported} imported`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`${DRY_RUN ? 'WOULD IMPORT' : 'Imported'} ${out.imported} PR(s), ${out.lines} line(s) | already in T1S ${out.exists} | not in source ${out.notFound}`);
  if (out.droppedLines.length) console.log(`\nLines left out, item not in T1S (${out.droppedLines.length}):\n  ` + out.droppedLines.slice(0, 20).join('\n  '));
  if (out.noLines.length) console.log(`\nPRs skipped, no importable line (${out.noLines.length}): ${out.noLines.slice(0, 20).join(', ')}`);
  if (out.failed.length) console.log(`\nFailed (${out.failed.length}):\n  ` + out.failed.slice(0, 20).join('\n  '));
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
