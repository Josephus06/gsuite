// Import the source's Non-Standard Sales Orders (samples, internal, RMA) with their lines, Job
// Orders and each Job Order's process/material lines -- what production and billing continue from.
// Builds, inspections and deliveries follow with import-production-stages.js --nsso-file, and the
// invoices with import-invoices-by-number.js (which attaches an invoice to its NSSO).
//
// Source reads (all read-only):
//   get_transactions {UserPK_TransH, Module_TransH:'NONSALESORDER'}  the header
//   get_estimate {pk}                -> data[1] its ledger-job lines (price, VAT, sample, allowance)
//   get_job_orders_for_cert {soPK}   -> its Job Orders
//   get_job_order {pk}               -> JO header (status, customer, artist) + data[2] processes
//
// An NSSO already in T1S (by number) is skipped; a Job Order already in T1S (by number) is linked,
// never duplicated. Job Order status/stage follow the source exactly as the 2026 match applies them.
//
//   node src/db/import-nsso-chain.js --file=nsso-numbers.txt --dry-run
//   node src/db/import-nsso-chain.js NSSO-SAM-2434,NSSO-INT-1920
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1];
const listArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
const NUMBERS = [...new Set((fileArg ? fs.readFileSync(fileArg, 'utf8') : listArg).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
const CONCURRENCY = 3;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const decOrNull = (v) => { const n = Number(v); return v === null || v === undefined || v === '' || v === '-' || !Number.isFinite(n) ? null : n; };
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');
const norm = (s) => clean(s).toLowerCase();
const key = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const day = (v) => { const s = v ? String(v).slice(0, 10) : ''; return s >= '1990-01-01' ? s : null; };

const TYPE = { sample: 'sample', internal: 'internal', rma: 'rma', 'rma - installation': 'rma_installation', 'rma installation': 'rma_installation' };
function nssoStatus(s) {
  const u = (s || '').toUpperCase();
  if (u.includes('CANCEL')) return 'cancelled';
  if (u.includes('BILLED') || u.includes('PAID')) return 'billed';
  if (u.includes('PENDING BILLING') && u.includes('PARTIAL')) return 'pending_billing_partially_delivered';
  if (u.includes('PENDING BILLING')) return 'pending_billing';
  if (u.includes('PARTIALLY DELIVERED')) return 'partially_delivered';
  if (u.includes('PENDING DELIVERY')) return 'pending_delivery';
  if (u.includes('IN-PROCESS') || u.includes('IN PROCESS')) return 'jo_in_process';
  if (u.includes('PENDING FOR JO')) return 'pending_for_jo';
  return 'pending_approval';
}
// The Job Order's T1S status / sub_status / production_stage from the source's Status + SubStatus --
// the same mapping the 2026 header match applied to Sales Order JOs.
const JO_SUB = { 'for design supervisor': 'For Design Supervisor', 'for artist bom': 'For Artist', 'for approval': 'Sales Approval', pending: 'Pending' };
function joState(status, sub) {
  const st = clean(status);
  if (/cancel/i.test(st)) return { status: 'Cancelled', sub_status: 'Pending', production_stage: null };
  if (/planned/i.test(st)) return { status: 'Planned - Pending for BOM', sub_status: JO_SUB[norm(sub)] || 'Pending', production_stage: null };
  if (/pending rma/i.test(st)) return { status: 'Pending RMA Approval', sub_status: 'Pending', production_stage: null };
  const stage = /completed/i.test(st) && !/partial/i.test(st) ? 'completed'
    : /partial/i.test(st) ? 'partially_completed'
      : /quality/i.test(st) ? 'for_qi'
        : 'in_process';
  return { status: 'Released', sub_status: 'Approved', production_stage: stage };
}

async function main() {
  if (!NUMBERS.length) { console.error('Give NSSO numbers: NSSO-SAM-1,NSSO-INT-2 or --file=path'); process.exit(2); }
  console.log(`${DRY_RUN ? 'DRY RUN -- ' : ''}${NUMBERS.length} NSSO number(s). Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  let t = await L.login();

  // ---- local lookups (by name/code, as the other importers resolve them) ----
  const [custs] = await pool.query('SELECT id, name, customer_code FROM customers');
  const custByName = new Map(); const custByCode = new Map();
  for (const c of custs) { if (!custByName.has(norm(c.name))) custByName.set(norm(c.name), c.id); if (c.customer_code) custByCode.set(norm(c.customer_code), c.id); }
  const [emps] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));
  const [divs] = await pool.query('SELECT id, name FROM sales_divisions');
  const divByName = new Map(divs.map((d) => [key(d.name), d.id]));
  const [locs] = await pool.query('SELECT id, location_name, location_code FROM locations');
  const locByName = new Map(); for (const l of locs) for (const k of [l.location_name, l.location_code]) if (k && !locByName.has(key(k))) locByName.set(key(k), l.id);
  const [jts] = await pool.query('SELECT id, display_name FROM job_types');
  const jtByName = new Map(jts.map((j) => [norm(j.display_name), j.id]));
  const [[vat]] = await pool.query("SELECT id FROM taxes WHERE code = 'VAT12' LIMIT 1");
  const [procs] = await pool.query('SELECT id, process_name FROM processes');
  const procByName = new Map(procs.map((p) => [norm(p.process_name), p.id]));
  const [invs] = await pool.query('SELECT id, item_code, display_name, sales_description FROM inventories');
  const invByKey = new Map(); for (const it of invs) for (const k of [it.item_code, it.display_name, it.sales_description]) if (k && !invByKey.has(norm(k))) invByKey.set(norm(k), it.id);
  // Source employees, for the NSSO's sales rep (its header carries only the employee key).
  const liveEmps = L.listRows(await L.api(t, 'get_employees', { limit: 5000, offset: 0 }));
  const empNameByPk = new Map(liveEmps.map((e) => [e.SysPK_Empl, clean(e.Name_Empl || `${e.FirstName_Empl || ''} ${e.LastName_Empl || ''}`)]));

  async function resolveJobType(name) {
    const k = norm(name);
    if (!k) return null;
    if (jtByName.has(k)) return jtByName.get(k);
    if (DRY_RUN) return null;
    const [r] = await pool.query('INSERT INTO job_types (display_name, gp_rate_head, gp_rate_branch, is_active) VALUES (?, 0, 0, 1)', [clean(name)]);
    jtByName.set(k, r.insertId);
    return r.insertId;
  }
  async function customerFor(pk, fallbackName) {
    if (fallbackName && custByName.has(norm(fallbackName))) return custByName.get(norm(fallbackName));
    if (!pk) return null;
    const c = L.listRows(await L.api(t, 'get_customers', { where: { SysPK_Cust: pk }, limit: 1 }))[0];
    if (!c) return null;
    return custByName.get(norm(c.Name_Cust)) || custByCode.get(norm(c.UserPK_Cust)) || null;
  }

  const out = { imported: 0, exists: 0, notFound: 0, lines: 0, jos: 0, josLinked: 0, procs: 0, noCustomer: [], failed: [] };
  let cursor = 0, sinceLogin = 0;
  async function worker() {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= NUMBERS.length) return;
      const no = NUMBERS[i];
      if ((sinceLogin += 1) >= 300) { sinceLogin = 0; t = await L.login(); }
      try {
        const [[dup]] = await pool.query('SELECT id FROM non_standard_sales_orders WHERE nsso_no = ?', [no]);
        if (dup) { out.exists += 1; continue; }
        const h = L.listRows(await L.api(t, 'get_transactions', { where: { UserPK_TransH: no, Module_TransH: 'NONSALESORDER' }, limit: 1 }))[0];
        if (!h) { out.notFound += 1; continue; }
        const est = await L.api(t, 'get_estimate', { pk: h.SysPK_TransH });
        const lines = (est.data?.[1] || []).filter((l) => !l.IsCancelled_LdgrJob);
        const joList = L.listRows(await L.api(t, 'get_job_orders_for_cert', { soPK: h.SysPK_TransH }));
        const joByPk = new Map(joList.map((j) => [j.SysPK_TransH, j]));
        // Each JO's detail: its status, the customer/artist, and its process lines.
        const joDetail = new Map();
        for (const j of joList) {
          const d = await L.api(t, 'get_job_order', { pk: j.SysPK_TransH });
          joDetail.set(j.SysPK_TransH, { head: Array.isArray(d.data) ? d.data[0] : null, procs: Array.isArray(d.data?.[2]) ? d.data[2] : [] });
        }
        const firstHead = [...joDetail.values()].map((x) => x.head).find(Boolean) || {};
        const customerId = await customerFor(h.SysFK_Cust_TransH, firstHead.Name_Cust);
        if (h.SysFK_Cust_TransH && !customerId) out.noCustomer.push(no);
        const repId = empByName.get(norm(empNameByPk.get(h.SysFK_Empl_TransH))) || null;
        const divisionId = divByName.get(key(h.DepartmentName_TransH)) || null;
        const locationId = locByName.get(key(h.LocationName_TransH)) || null;
        const type = TYPE[norm(h.Type_TransH)] || (no.includes('-RMA-') ? 'rma' : no.includes('-SAM-') ? 'sample' : 'internal');
        if (DRY_RUN) { out.imported += 1; out.lines += lines.length; out.jos += joList.length; continue; }

        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [r] = await conn.query(
            `INSERT INTO non_standard_sales_orders
               (nsso_no, type, date_created, customer_id, contact_email, contact_title, contact_phone, sales_rep_id, sales_division_id,
                office_location_id, contract_description, memo, production_lead_time, status, subtotal, net_of_tax, tax_total, total_amount,
                total_allowance, total_sample, approved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [no, type, day(h.DateCreated_TransH), customerId, clean(firstHead.Email_ContactP).slice(0, 255) || null,
              clean(firstHead.Title_ContactP).slice(0, 100) || null, clean(firstHead.ContactNo_ContactP).slice(0, 100) || null,
              repId, divisionId, locationId, clean(h.ContractDescription_TransH || h.Particulars_TransH).slice(0, 500) || null,
              clean(h.Memo_TransH).slice(0, 1000) || null, clean(h.Leadtime_TransH) || '', nssoStatus(h.Status_TransH),
              num(h.SubTotal_TransH), num(h.SubTotalVatEx_TransH), num(h.TaxAmount_TransH), num(h.TotalAmount_TransH),
              num(h.TotalAllowance_TransH), num(h.TotalSample_TransH), h.ApprovedBy_TransH ? day(h.DateCreated_TransH) : null]);
          const nssoId = r.insertId;
          let lineNo = 0;
          for (const l of lines) {
            lineNo += 1;
            const jobTypeId = await resolveJobType(l.transactionledgerjob_job?.DisplayName_Job);
            const [lr] = await conn.query(
              `INSERT INTO non_standard_sales_order_lines
                 (nsso_id, line_no, job_type_id, job_location_id, description, quantity, units, price_per_unit, subtotal,
                  disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, gross_amount, length, width, height, uom,
                  delivery_date, sample_qty, sample_amount, allowance_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [nssoId, lineNo, jobTypeId, locByName.get(key(l.transactionledgerjob_location?.Name_Loc)) || null,
                clean(l.Description_LdgrJob), num(l.Qty_LdgrJob), l.UnitOfMeasure_LdgrJob || null, num(l.Price_LdgrJob),
                num(l.SubTotal_LdgrJob), num(l.DiscountPercent_LdgrJob), num(l.DiscountAmount_LdgrJob), num(l.VatExAmount_LdgrJob),
                num(l.TaxAmount_LdgrJob) && vat ? vat.id : null, num(l.TaxAmount_LdgrJob), num(l.GrossAmount_LdgrJob),
                decOrNull(l.Length_LdgrJob), decOrNull(l.Width_LdgrJob), decOrNull(l.Height_LdgrJob), l.Unit_LdgrJob || null,
                day(l.DeliveryDate_LdgrJob), num(l.SampleQty_LdgrJob), num(l.SampleAmount_LdgrJob), num(l.AllowanceAmount_LdgrJob)]);
            out.lines += 1;
            const liveJo = l.SysFK_TransHJO_LdgrJob ? joByPk.get(l.SysFK_TransHJO_LdgrJob) : null;
            if (!liveJo) continue;
            const det = joDetail.get(liveJo.SysPK_TransH) || {};
            const jh = det.head || {};
            const [[existing]] = await conn.query('SELECT id FROM job_orders WHERE job_order_no = ?', [liveJo.UserPK_TransH]);
            let joId;
            if (existing) {
              joId = existing.id;
              await conn.query('UPDATE job_orders SET nsso_id = COALESCE(nsso_id, ?), nsso_line_id = COALESCE(nsso_line_id, ?) WHERE id = ?', [nssoId, lr.insertId, joId]);
              out.josLinked += 1;
            } else {
              const st = joState(jh.Status_TransH, jh.SubStatus_TransH);
              const [jr] = await conn.query(
                `INSERT INTO job_orders (job_order_no, nsso_id, nsso_line_id, job_type_id, job_location_id, sales_rep_id, description,
                   quantity, units, length, width, height, status, sub_status, production_stage, delivery_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [liveJo.UserPK_TransH, nssoId, lr.insertId, jobTypeId, locByName.get(key(jh.joloc_name)) || null, repId,
                  clean(jh.JobDescription_TransH || l.Description_LdgrJob), num(jh.Quantity_TransH) || num(l.Qty_LdgrJob),
                  jh.UOM_TransH || l.UnitOfMeasure_LdgrJob || null, decOrNull(jh.Length_TransH), decOrNull(jh.Width_TransH),
                  decOrNull(jh.Height_TransH), st.status, st.sub_status, st.production_stage, day(jh.DeliveryDate_TransH)]);
              joId = jr.insertId;
              out.jos += 1;
              const rows = (det.procs || []).map((P, idx) => [
                joId, idx + 1, procByName.get(norm(P.Name_Proc)) ?? null, num(P.ProcessQty_LdgrInvty), P.UOM_Proc || null,
                P.Category_LdgrInvty || null, P.Parts_LdgrInvty || null,
                invByKey.get(norm(P.UserPK_Invty)) ?? invByKey.get(norm(P.SalesDescription_Invty)) ?? null,
                locByName.get(key(P.Name_Loc)) ?? null, P.ArtistRemarks_LdgrInvty || null, num(P.Length_LdgrInvty), num(P.Width_LdgrInvty),
                P.UnitOfMeasure_LdgrInvty || null, num(P.Qty_LdgrInvty), num(P.TotalAmountOut_LdgrInvty) || num(P.SubTotalAmountOut_LdgrInvty),
                P.Unit_LdgrInvty || null, P.SalesRemarks_LdgrInvty || null, P.Particulars_LdgrInvty || null,
                num(P.ProcessCost_LdgrInvty), num(P.MaterialCost_LdgrInvty),
                num(P.MaterialTransCost_LdgrInvty) + num(P.ProcessTransCost_LdgrInvty), num(P.Cost_LdgrInvty), P.ProductionRemarks_LdgrInvty || null,
              ]);
              if (rows.length) {
                await conn.query(
                  `INSERT INTO job_order_processes
                     (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, location_id,
                      artist_remarks, length, width, uom, qty, total, unit, remarks, memo,
                      process_cost, material_cost, total_cost, avg_cost, production_remarks)
                   VALUES ?`, [rows]);
                out.procs += rows.length;
              }
            }
            await conn.query('UPDATE non_standard_sales_order_lines SET created_job_order_id = ? WHERE id = ?', [joId, lr.insertId]);
          }
          await conn.commit();
          out.imported += 1;
        } catch (e) { await conn.rollback(); out.failed.push(`${no}: ${e.message}`); }
        finally { conn.release(); }
      } catch (e) { out.failed.push(`${no}: ${e.message}`); }
      if ((out.imported + out.exists) % 100 === 0 && out.imported) console.log(`  ...${out.imported} imported, ${out.jos} JOs`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`${DRY_RUN ? 'WOULD IMPORT' : 'Imported'} ${out.imported} NSSO(s) | ${out.lines} line(s) | ${out.jos} new JO(s), ${out.josLinked} existing JO(s) linked | ${out.procs} process line(s)`);
  console.log(`already in T1S ${out.exists} | not in source ${out.notFound}`);
  if (out.noCustomer.length) console.log(`\nCustomer not resolved (imported with none) ${out.noCustomer.length}: ${out.noCustomer.slice(0, 20).join(', ')}`);
  if (out.failed.length) console.log(`\nFailed (${out.failed.length}):\n  ` + out.failed.slice(0, 30).join('\n  '));
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
