// Migrates the source's RWIP (rework-in-process) job orders -- and with --include-rfqc its RFQC
// (QC rework) ones -- that the sales import never brought across.
//
// On the source they are JOBORDER transactions numbered RWIP-n / RFQC-n, raised off a mother JO.
// The list comes from its RWIP-RFQC report (rwip_rfqc_report, every one ever raised, with the
// mother JO number); each one's header and process lines from get_job_order, the same detail the
// JO process import reads. Here they become job_orders rows linked to the mother through
// parent_job_order_id, exactly what lib/reworkJobOrder.js creates in-app:
//
//   number      jo_upk (RWIP-1281)               mother   parent JO by number (jo_jo_upk)
//   header      the mother's SO / line / job type / contact / sales rep, then the source's own
//               description, qty, unit, L x W x H, memo, delivery date + time, job location,
//               reason (Reason_TransH, linked to a Reasons code of the same name when one exists)
//               and action to be taken (ActionsToBeTaken_TransH)
//   approved by ApprovedBy_TransH, matched to a user by display name
//   status      Pending RMA Approval -> Pending RMA Approval (no stage)
//               JO IN-PROCESS -> Released / Approved / in_process
//               Released      -> Released / Approved / pending_for_scheduling
//               COMPLETED     -> Released / Approved / completed
//               Cancelled     -> Cancelled
//   processes   get_job_order data[2], mapped as import-jo-processes.js maps a JO's lines
//
// SAFETY. A number that already exists here is never touched: either a previous run imported it
// (skipped, so re-running resumes) or it was raised in this app and happens to share a source
// number -- those are listed as collisions for someone to decide on. A rework whose mother JO is
// not here is skipped and listed. Nothing is deleted.
//
//   node src/db/import-rwip.js --dry-run
//   node src/db/import-rwip.js
//   node src/db/import-rwip.js --include-rfqc
const pool = require('../db');
require('dotenv').config();
const { login, api } = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_RFQC = process.argv.includes('--include-rfqc');
const PAGE = 200;
const DETAIL_GAP_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const normWs = (s) => norm(s).replace(/\s+/g, ' ');
const num = (v) => { if (v === null || v === undefined || v === 'null' || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const day = (v) => { const s = (v || '').toString().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= '1990-01-01' ? s : null; };
// The source stores a time of day as 1970-01-01T05:00:00.000Z -- UTC; its screens show it in
// Manila time (+8), so that one reads 13:00.
function manilaTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const m = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${String(m.getUTCHours()).padStart(2, '0')}:${String(m.getUTCMinutes()).padStart(2, '0')}:00`;
}
const STATUS = {
  'pending rma approval': ['Pending RMA Approval', null, null],
  'jo in-process': ['Released', 'Approved', 'in_process'],
  released: ['Released', 'Approved', 'pending_for_scheduling'],
  completed: ['Released', 'Approved', 'completed'],
  cancelled: ['Cancelled', null, null],
};

async function fetchReport(token) {
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  const rows = [];
  for (let off = 0; off < 100000; off += PAGE) {
    const r = await api(token, 'rwip_rfqc_report', {
      filterdate: { filter: 'as of', date1: { hide: false, date: today }, date2: { hide: true, date: today } },
      searchkey: '', office_location: '', job_location: '', department: '', sales_rep: '', customer: '', status: '',
      limit: PAGE, offset: off,
    });
    if (!r?.success) throw new Error('rwip_rfqc_report failed');
    const page = r.data?.[0] || [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// A throttled reply is 200 with an empty header; a real one carries dozens of fields.
async function fetchDetail(ctx, pk) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const d = await api(ctx.token, 'get_job_order', { pk });
      if (Array.isArray(d?.data) && d.data[0] && Object.keys(d.data[0]).length >= 5) return d;
    } catch { /* retried below */ }
    await sleep(1200 * (attempt + 1));
    ctx.token = await login();
  }
  return null;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing written.' : 'APPLYING.', INCLUDE_RFQC ? '(RWIP + RFQC)' : '(RWIP only; --include-rfqc for RFQC too)');

  const ctx = { token: await login() };
  const report = (await fetchReport(ctx.token))
    .filter((r) => /^RWIP-/i.test(r.rjo_upk) || (INCLUDE_RFQC && /^RFQC-/i.test(r.rjo_upk)));
  console.log(`source rework job orders: ${report.length}`);

  // --- local lookups ---
  const [existingRows] = await pool.query(
    `SELECT jo.job_order_no, p.job_order_no AS parent_no FROM job_orders jo
       LEFT JOIN job_orders p ON p.id = jo.parent_job_order_id
      WHERE jo.job_order_no LIKE 'RWIP-%' OR jo.job_order_no LIKE 'RFQC-%'`
  );
  const existing = new Map(existingRows.map((r) => [norm(r.job_order_no), r.parent_no]));
  const [procs] = await pool.query('SELECT id, process_name FROM processes');
  const procByName = new Map(procs.map((p) => [norm(p.process_name), p.id]));
  const [invs] = await pool.query('SELECT id, item_code, display_name, sales_description FROM inventories');
  const invByKey = new Map();
  for (const it of invs) for (const k of [it.item_code, it.display_name, it.sales_description]) if (k && !invByKey.has(norm(k))) invByKey.set(norm(k), it.id);
  const [locs] = await pool.query('SELECT id, location_name, location_code FROM locations');
  const locByName = new Map();
  for (const l of locs) for (const k of [l.location_name, l.location_code]) if (k && !locByName.has(normWs(k))) locByName.set(normWs(k), l.id);
  const [users] = await pool.query('SELECT id, display_name FROM users');
  const userByName = new Map(users.map((u) => [normWs(u.display_name), u.id]));
  const [reasons] = await pool.query('SELECT id, name, reason_type FROM reasons');
  const reasonByName = new Map();
  for (const r of reasons) {
    const k = normWs(r.name);
    // Prefer the code filed under the rework's own type when two types share a name.
    if (!reasonByName.has(k) || /rwip|rfqc/i.test(r.reason_type || '')) reasonByName.set(k, r.id);
  }

  const imported = [];
  const already = [];
  const collisions = [];
  const noMother = [];
  const failed = [];
  let lines = 0;
  let unresolvedProc = 0;
  let unresolvedItem = 0;

  for (const [i, row] of report.entries()) {
    const no = row.rjo_upk;
    const motherNo = row.jo_upk;
    if (existing.has(norm(no))) {
      const parentHere = existing.get(norm(no));
      if (norm(parentHere) === norm(motherNo)) already.push(no);
      else collisions.push(`${no}: source reworks ${motherNo}, the one here reworks ${parentHere || '(no mother)'}`);
      continue;
    }
    const [[mother]] = await pool.query('SELECT * FROM job_orders WHERE job_order_no = ?', [motherNo]);
    if (!mother) { noMother.push(`${no} (mother ${motherNo})`); continue; }
    if (DRY_RUN) { imported.push(no); continue; }

    const detail = await fetchDetail(ctx, row.rjo_pk);
    await sleep(DETAIL_GAP_MS);
    if (!detail) { failed.push(`${no}: source detail did not load`); continue; }
    const h = detail.data[0];
    const L = Array.isArray(detail.data[2]) ? detail.data[2] : [];
    const [status, subStatus, stage] = STATUS[norm(h.Status_TransH || row.Status_TransH)] || ['Pending RMA Approval', null, null];
    const approvedBy = h.ApprovedBy_TransH ? (userByName.get(normWs(h.ApprovedBy_TransH)) || null) : null;
    const createdAt = day(h.DateCreated_TransH || row.rjo_date);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO job_orders (job_order_no, parent_job_order_id, sales_order_id, nsso_id, sales_order_line_id, job_type_id, job_location_id,
           description, quantity, units, length, width, height, memo, contact_email, contact_title, contact_phone, shipping_address,
           sales_rep_id, delivery_date, delivery_time, reason_code_id, reason, action_to_be_taken,
           status, sub_status, production_stage, rma_approved_by_id, is_on_hold, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        // The mother's NSSO as well: a rework of an NSJO otherwise has no order at all (RWIP-1286).
        [no, mother.id, mother.sales_order_id, mother.nsso_id || null, mother.sales_order_line_id, mother.job_type_id,
         locByName.get(normWs(h.joloc_name)) || mother.job_location_id,
         trunc(h.JobDescription_TransH, 500) || mother.description,
         num(h.Quantity_TransH) ?? 0, trunc(h.Unit_TransH, 30) || mother.units,
         num(h.Length_TransH), num(h.Width_TransH), num(h.Height_TransH),
         trunc(h.Memo_TransH, 500), mother.contact_email, mother.contact_title, mother.contact_phone, mother.shipping_address,
         mother.sales_rep_id, day(h.DeliveryDate_TransH), manilaTime(h.DeliveryTime_TransH),
         h.Reason_TransH ? (reasonByName.get(normWs(h.Reason_TransH)) || null) : null,
         trunc(h.Reason_TransH, 500), trunc(h.ActionsToBeTaken_TransH, 500),
         status, subStatus, stage, approvedBy, Number(h.IsOnHold_TransH) === 1 ? 1 : 0,
         createdAt ? `${createdAt} 00:00:00` : new Date()]
      );
      const id = r.insertId;
      const procRows = L.map((x, n) => {
        const procId = procByName.get(norm(x.Name_Proc)) ?? null;
        const itemId = invByKey.get(norm(x.UserPK_Invty)) ?? invByKey.get(norm(x.SalesDescription_Invty)) ?? null;
        if (x.Name_Proc && !procId) unresolvedProc += 1;
        if ((x.UserPK_Invty || x.SalesDescription_Invty) && !itemId) unresolvedItem += 1;
        return [
          id, n + 1, procId, num(x.ProcessQty_LdgrInvty), x.UOM_Proc || null,
          x.Category_LdgrInvty || null, x.Parts_LdgrInvty || null, itemId, locByName.get(normWs(x.Name_Loc)) ?? null,
          x.ArtistRemarks_LdgrInvty || null, num(x.Length_LdgrInvty), num(x.Width_LdgrInvty),
          x.UnitOfMeasure_LdgrInvty || null, num(x.Qty_LdgrInvty), num(x.QtyOutTemp_LdgrInvty) ?? num(x.Qty_LdgrInvty),
          x.Unit_LdgrInvty || null, x.SalesRemarks_LdgrInvty || null, x.Particulars_LdgrInvty || null,
          num(x.ProcessCost_LdgrInvty), num(x.MaterialCost_LdgrInvty),
          (num(x.MaterialTransCost_LdgrInvty) || 0) + (num(x.ProcessTransCost_LdgrInvty) || 0),
          num(x.Cost_LdgrInvty), x.ProductionRemarks_LdgrInvty || null,
        ];
      });
      if (procRows.length) {
        await conn.query(
          `INSERT INTO job_order_processes
             (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, location_id,
              artist_remarks, length, width, uom, qty, total, unit, remarks, memo,
              process_cost, material_cost, total_cost, avg_cost, production_remarks)
           VALUES ?`, [procRows]
        );
      }
      await conn.commit();
      imported.push(no);
      lines += procRows.length;
    } catch (e) {
      await conn.rollback();
      failed.push(`${no}: ${e.message}`);
    } finally {
      conn.release();
    }
    if ((i + 1) % 100 === 0) console.log(`  ...${i + 1}/${report.length}`);
  }

  console.log(`\n${DRY_RUN ? 'would import' : 'imported'}: ${imported.length}${DRY_RUN ? '' : ` (${lines} process lines)`}`);
  console.log(`already here from an earlier run: ${already.length}`);
  if (!DRY_RUN) console.log(`unresolved process names: ${unresolvedProc}, unresolved items: ${unresolvedItem} (left empty)`);
  const list = (title, arr) => {
    if (!arr.length) return;
    console.log(`\n${title}: ${arr.length}`);
    arr.slice(0, 40).forEach((x) => console.log(`  ${x}`));
    if (arr.length > 40) console.log(`  ... and ${arr.length - 40} more`);
  };
  list('NUMBER ALREADY USED HERE by a different rework (left alone)', collisions);
  list('mother JO not in this database (skipped)', noMother);
  list('failed', failed);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
