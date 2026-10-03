// Job Orders created IN T1S from a MIGRATED Sales Order came out with no processes (reported
// 2026-10-03 on SO-71549 / EST-108260). Create JO copies processes from the estimate line behind
// each SO line (sales_order_lines.estimate_job_order_id), but a migrated SO's lines carry no such
// link -- and the migration never brought the estimate's job lines into T1S either -- so there was
// nothing to copy. The source still has them: its estimate's job lines each carry their process /
// material rows (LdgrInvty).
//
// For each such JO (created since go-live, not NSSO/RWIP, with no processes or only blank lines),
// this fetches the source estimate behind its SO, matches estimate lines to the SO's lines by
// position, requiring the same quantity and description, and writes the matched line's process
// rows onto the JO -- mapped exactly as import-jo-processes.js maps a source JO's rows.
//
//   node src/db/backfill-jo-processes-from-estimate.js                 # preview, every affected SO
//   node src/db/backfill-jo-processes-from-estimate.js --so=SO-71549   # preview one
//   node src/db/backfill-jo-processes-from-estimate.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');
// `total` is a QUANTITY (item used, in its unit). On an ESTIMATE line TotalAmountOut is the PRICE,
// so the quantity is worked out as T1S does for estimate lines (Qty x size). Fixed 2026-10-03.
const { computeLineTotal } = require('../lib/liveEstimateSync');

const APPLY = process.argv.includes('--apply');
const ONE = (process.argv.find((a) => a.startsWith('--so=')) || '').split('=')[1] || null;
const num = (v) => { if (v === null || v === undefined || v === 'null' || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  // JOs to fill: no process lines, or only lines with neither a process nor an item.
  const [targets] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.sales_order_id, so.sales_order_no, e.estimate_no
       FROM job_orders jo
       JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN estimates e ON e.id = so.estimate_id
      WHERE jo.created_at >= '2026-09-28' AND jo.nsso_id IS NULL AND jo.parent_job_order_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM job_order_processes x WHERE x.job_order_id = jo.id AND (x.process_id IS NOT NULL OR x.item_id IS NOT NULL))
        ${ONE ? 'AND so.sales_order_no = ?' : ''}
      ORDER BY jo.id`, ONE ? [ONE] : []);
  const bySo = new Map();
  for (const t of targets) { if (!bySo.has(t.sales_order_id)) bySo.set(t.sales_order_id, []); bySo.get(t.sales_order_id).push(t); }
  console.log(`JOs without processes: ${targets.length} across ${bySo.size} SO(s)`);

  const [procs] = await pool.query('SELECT id, process_name FROM processes');
  const procByName = new Map(procs.map((p) => [norm(p.process_name), p.id]));
  const [invs] = await pool.query('SELECT id, item_code, display_name, sales_description FROM inventories');
  const invBy = new Map();
  for (const it of invs) for (const k of [it.item_code, it.display_name, it.sales_description]) if (k && !invBy.has(norm(k))) invBy.set(norm(k), it.id);

  // Audit rows need a user: recorded under the System Admin who ran it (first one, by id).
  const [[admin]] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND display_name LIKE 'Josephus%' ORDER BY id LIMIT 1");
  const t = await L.login();
  const plan = [];
  for (const [soId, jos] of bySo) {
    const { sales_order_no: soNo, estimate_no: estNo } = jos[0];
    if (!estNo) { console.log(`  ${soNo}: no estimate on the SO -- skipped`); continue; }
    const h = L.listRows(await L.api(t, 'get_transactions', { where: { UserPK_TransH: estNo }, limit: 1 }))[0];
    if (!h) { console.log(`  ${soNo}: ${estNo} not in the source -- skipped`); continue; }
    const r = await L.api(t, 'get_transaction', {
      where: { Module_TransH: h.Module_TransH, SysPK_TransH: h.SysPK_TransH },
      include: [['transaction_transactionledgerjobs', ['transactionledgerjob_transactionledgerinvtys', 'transactionledgerinvty_process', 'transactionledgerinvty_invty']]],
    });
    const tx = Array.isArray(r?.data) ? r.data[0] : r?.data;
    const estLines = (tx?.transaction_transactionledgerjobs || []).slice().sort((a, b) => Number(a.ID_LdgrJob) - Number(b.ID_LdgrJob));
    const [soLines] = await pool.query('SELECT id, line_no, quantity, description, job_order_id FROM sales_order_lines WHERE sales_order_id = ? ORDER BY line_no', [soId]);
    if (soLines.length !== estLines.length) { console.log(`  ${soNo}: ${soLines.length} SO lines vs ${estLines.length} estimate lines -- skipped`); continue; }
    for (const jo of jos) {
      const idx = soLines.findIndex((l) => Number(l.job_order_id) === Number(jo.id));
      const sl = soLines[idx]; const el = estLines[idx];
      if (!sl || !el) { console.log(`  ${jo.job_order_no}: its SO line not found -- skipped`); continue; }
      const sameQty = Math.abs(Number(sl.quantity) - Number(el.Quantity_LdgrJob ?? el.Qty_LdgrJob)) < 0.0001;
      const sameDesc = norm(sl.description) === norm(el.Description_LdgrJob || el.DisplayDescription_LdgrJob);
      if (!sameQty || !sameDesc) { console.log(`  ${jo.job_order_no}: estimate line ${idx + 1} differs (qty ${sameQty ? 'ok' : 'differs'}, description ${sameDesc ? 'ok' : 'differs'}) -- skipped`); continue; }
      const inv = (el.transactionledgerjob_transactionledgerinvtys || []).slice().sort((a, b) => (Number(a.Seq_LdgrInvty) || 0) - (Number(b.Seq_LdgrInvty) || 0) || Number(a.ID_LdgrInvty) - Number(b.ID_LdgrInvty));
      const rows = inv.map((x, i) => {
        const p = x.transactionledgerinvty_process || {}; const it = x.transactionledgerinvty_invty || {};
        return [
          jo.id, i + 1, procByName.get(norm(p.Name_Proc)) ?? null, num(x.ProcessQty_LdgrInvty), p.UOM_Proc || null,
          x.Category_LdgrInvty || null, x.Parts_LdgrInvty || null,
          invBy.get(norm(it.UserPK_Invty)) ?? invBy.get(norm(it.SalesDescription_Invty)) ?? null, null,
          x.ArtistRemarks_LdgrInvty || null, num(x.Length_LdgrInvty), num(x.Width_LdgrInvty),
          x.UnitOfMeasure_LdgrInvty || null, num(x.Qty_LdgrInvty), computeLineTotal(x),
          x.Unit_LdgrInvty || null, x.SalesRemarks_LdgrInvty || null, x.Particulars_LdgrInvty || null,
          num(x.ProcessCost_LdgrInvty), num(x.MaterialCost_LdgrInvty),
          (num(x.MaterialTransCost_LdgrInvty) || 0) + (num(x.ProcessTransCost_LdgrInvty) || 0), num(x.Cost_LdgrInvty),
          x.ProductionRemarks_LdgrInvty || null,
        ];
      });
      const names = inv.map((x) => x.transactionledgerinvty_process?.Name_Proc).filter(Boolean);
      console.log(`  ${jo.job_order_no}: ${rows.length} process line(s) -- ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', ...' : ''}`);
      if (rows.length) plan.push({ jo, rows });
    }
  }
  console.log(`\nTo write: ${plan.length} JO(s), ${plan.reduce((s, p) => s + p.rows.length, 0)} process line(s).`);
  if (!APPLY || !plan.length) { await pool.end(); return; }

  for (const { jo, rows } of plan) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Re-checked inside the transaction: only blank lines may be replaced.
      const [[real]] = await conn.query('SELECT COUNT(*) AS n FROM job_order_processes WHERE job_order_id = ? AND (process_id IS NOT NULL OR item_id IS NOT NULL)', [jo.id]);
      if (real.n) { await conn.rollback(); console.log(`  ${jo.job_order_no}: got processes meanwhile -- left alone`); continue; }
      await conn.query('DELETE FROM job_order_processes WHERE job_order_id = ?', [jo.id]);
      await conn.query(
        `INSERT INTO job_order_processes
           (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, location_id,
            artist_remarks, length, width, uom, qty, total, unit, remarks, memo,
            process_cost, material_cost, total_cost, avg_cost, production_remarks)
         VALUES ?`, [rows]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('JobOrder', ?, 'Updated', 'processes', NULL, ?, ?)`,
        [jo.id, `${rows.length} process line(s) backfilled from the source estimate`, admin?.id || 1]);
      await conn.commit();
    } catch (e) { await conn.rollback(); console.error(`  ${jo.job_order_no}: ${e.message}`); } finally { conn.release(); }
  }
  console.log('Applied.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
