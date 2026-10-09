const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');

const router = express.Router();

// Sales > Pending Billing: every Job Order production has COMPLETED that is not yet (fully)
// invoiced -- work done and waiting for its bill.
//
// "Completed" is production_stage 'completed' (all of it) or 'partially_completed' (the QI'd part);
// the status sync keeps that stage in step with the source. "Invoiced" is counted from the
// invoice LINES that name the JO (not cancelled), NOT job_orders.quantity_invoiced -- that counter
// was never filled in for migrated JOs (117k fully-billed JOs read 0 there).
//
// Non-standard JOs (NSJO: internal, sample, RMA work) are left out unless asked for: they are
// mostly not billed to a customer. Price per unit is the SO line's (the NSSO line's for an NSJO),
// so Unbilled Amount = uninvoiced qty x that line's gross per unit.
const ROUTE = '/reports/pending-billing';

// How much of each JO has been invoiced, worked out per SALES ORDER (2026-10-09). The migration hung
// a multi-JO order's invoice lines on one of its JOs -- INV-80490 billed JO-69846-2-2's 50
// certificates but names JO-69846-1-2 -- so counting only the lines that name a JO listed ~30,000
// JOs whose order was already fully billed. Now:
//   1. a line that names a JO counts for it, up to that JO's quantity;
//   2. what is left -- a line naming no JO, or more than its JO's quantity -- goes to the order's
//      other JOs: first to one whose outstanding quantity is exactly that amount, then in JO order.
// Every live JO on the order takes its share, completed or not, so billing a JO still in production
// is not handed to a completed sibling.
async function invoicedByJobOrder(jos) {
  const joIds = jos.map((j) => j.id);
  const soIds = [...new Set(jos.map((j) => j.sales_order_id).filter(Boolean))];
  const [[siblings], [lines]] = await Promise.all([
    pool.query(
      `SELECT id, sales_order_id, quantity FROM job_orders
        WHERE sales_order_id IN (?) AND (status IS NULL OR status <> 'Cancelled')`, [soIds.concat(0)]),
    pool.query(
      `SELECT l.id, l.job_order_id, l.quantity, si.invoice_no, si.sales_order_id
         FROM sales_invoice_lines l JOIN sales_invoices si ON si.id = l.sales_invoice_id
        WHERE si.status <> 'cancelled' AND (l.job_order_id IN (?) OR si.sales_order_id IN (?))`,
      [joIds, soIds.concat(0)]),
  ]);
  const jo = new Map();
  for (const j of [...siblings, ...jos]) {
    if (!jo.has(Number(j.id))) jo.set(Number(j.id), { so: j.sales_order_id ? Number(j.sales_order_id) : null, qty: Number(j.quantity || 0), got: 0, invoices: new Set() });
  }
  const pool_ = new Map(); // so id -> [{ qty, invoice_no }]
  const toPool = (so, qty, invoiceNo) => {
    if (!so || qty <= 0.0001) return;
    if (!pool_.has(so)) pool_.set(so, []);
    pool_.get(so).push({ qty, invoice_no: invoiceNo });
  };
  for (const l of lines) {
    const q = Number(l.quantity || 0);
    const j = l.job_order_id ? jo.get(Number(l.job_order_id)) : null;
    if (!j) { toPool(l.sales_order_id ? Number(l.sales_order_id) : null, q, l.invoice_no); continue; }
    const take = Math.min(q, Math.max(j.qty - j.got, 0));
    if (take > 0) { j.got += take; j.invoices.add(l.invoice_no); }
    toPool(j.so || (l.sales_order_id ? Number(l.sales_order_id) : null), q - take, l.invoice_no);
  }
  const bySo = new Map();
  for (const [id, j] of jo) { if (j.so) { if (!bySo.has(j.so)) bySo.set(j.so, []); bySo.get(j.so).push([id, j]); } }
  for (const [so, chunks] of pool_) {
    const mine = (bySo.get(so) || []).sort((a, b) => a[0] - b[0]);
    for (const c of chunks) {
      const exact = mine.find(([, j]) => Math.abs(j.qty - j.got - c.qty) < 0.0001);
      for (const [, j] of exact ? [exact] : mine) {
        if (c.qty <= 0.0001) break;
        const take = Math.min(c.qty, Math.max(j.qty - j.got, 0));
        if (take <= 0) continue;
        j.got += take; c.qty -= take; j.invoices.add(c.invoice_no);
      }
    }
  }
  return new Map(joIds.map((id) => {
    const j = jo.get(Number(id));
    return [Number(id), { qty: j.got, invoice_nos: j.invoices.size ? [...j.invoices].sort().join(', ') : null }];
  }));
}

// Batched rather than one big query with per-row subqueries (that took ~30 s): pick the completed
// JOs first -- a few thousand at most -- then read their invoices, QIs, deliveries and order lines
// in one keyed query each (indexes added by register-pending-billing-page.js).
async function loadRows(req) {
  const { search, sales_rep_id: rep, customer_id: customerId, from, to, delivered, include_nsjo: includeNsjo } = req.query;
  const where = ["jo.production_stage IN ('completed', 'partially_completed')", "(jo.status IS NULL OR jo.status <> 'Cancelled')"];
  const params = [];
  if (!(includeNsjo === '1' || includeNsjo === 'true')) where.push('jo.nsso_id IS NULL');
  const scope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
  if (scope) { where.push('COALESCE(so.sales_rep_id, ns.sales_rep_id, jo.sales_rep_id) IN (?)'); params.push(scope.length ? scope : [0]); }
  if (rep) { where.push('COALESCE(so.sales_rep_id, ns.sales_rep_id, jo.sales_rep_id) = ?'); params.push(rep); }
  if (customerId) { where.push('COALESCE(so.customer_id, ns.customer_id) = ?'); params.push(customerId); }
  if (search) {
    where.push('(jo.job_order_no LIKE ? OR so.sales_order_no LIKE ? OR ns.nsso_no LIKE ? OR c.name LIKE ? OR jo.description LIKE ?)');
    const q = `%${String(search).trim()}%`; params.push(q, q, q, q, q);
  }
  if (delivered === 'yes') where.push('jo.quantity_delivered > 0');
  if (delivered === 'no') where.push('COALESCE(jo.quantity_delivered, 0) = 0');
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.quantity_inspected, jo.quantity_delivered,
            jo.production_stage, jo.delivery_date, jo.units, jo.nsso_id, jo.sales_order_line_id, jo.nsso_line_id,
            so.id AS sales_order_id, so.sales_order_no, so.date_created AS so_date, ns.nsso_no, ns.type AS nsso_type,
            COALESCE(so.customer_id, ns.customer_id) AS customer_id, c.name AS customer_name,
            CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
            CASE WHEN jo.production_stage = 'completed' THEN jo.quantity ELSE COALESCE(jo.quantity_inspected, 0) END AS completed_qty
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, ns.customer_id)
       LEFT JOIN employees sr ON sr.id = COALESCE(so.sales_rep_id, ns.sales_rep_id, jo.sales_rep_id)
      WHERE ${where.join(' AND ')}`, params);
  if (!jos.length) return [];
  const ids = jos.map((j) => j.id);
  const byJo = (rows) => new Map(rows.map((r) => [Number(r.job_order_id), r]));
  const [invM, [qis], [dels], [solRows], [nslRows]] = await Promise.all([
    invoicedByJobOrder(jos),
    pool.query(`SELECT job_order_id, MAX(date_created) d FROM quality_inspections
                 WHERE job_order_id IN (?) AND (status IS NULL OR status <> 'cancelled') GROUP BY job_order_id`, [ids]),
    pool.query(`SELECT dl.job_order_id, MAX(d.date_created) d FROM item_delivery_lines dl JOIN item_deliveries d ON d.id = dl.item_delivery_id
                 WHERE dl.job_order_id IN (?) AND (d.status IS NULL OR d.status <> 'cancelled') GROUP BY dl.job_order_id`, [ids]),
    pool.query('SELECT id, sales_order_id, line_no, job_order_id, quantity, gross_amount FROM sales_order_lines WHERE sales_order_id IN (?)',
      [[...new Set(jos.map((j) => j.sales_order_id).filter(Boolean))].concat(0)]),
    pool.query('SELECT id, quantity, gross_amount FROM non_standard_sales_order_lines WHERE id IN (?)',
      [[...new Set(jos.map((j) => j.nsso_line_id).filter(Boolean))].concat(0)]),
  ]);
  const qiM = byJo(qis); const delM = byJo(dels);
  const solById = new Map(solRows.map((l) => [Number(l.id), l]));
  const solByJo = new Map(solRows.filter((l) => l.job_order_id).map((l) => [Number(l.job_order_id), l]));
  const solBySoLine = new Map(solRows.map((l) => [`${l.sales_order_id}|${l.line_no}`, l]));
  const nslById = new Map(nslRows.map((l) => [Number(l.id), l]));
  const perUnit = (l) => (l && Number(l.quantity) ? Number(l.gross_amount || 0) / Number(l.quantity) : 0);
  const today = new Date(new Date().toLocaleDateString('en-CA'));
  const out = [];
  for (const j of jos) {
    // The SO line: the JO's own link, else the line that names the JO, else the line number in
    // the JO number (JO-<so>-<line>-<n>) -- every completed sales JO resolves one of these ways.
    const lineNo = Number(String(j.job_order_no || '').split('-')[2]);
    const sol = solById.get(Number(j.sales_order_line_id)) || solByJo.get(Number(j.id)) || solBySoLine.get(`${j.sales_order_id}|${lineNo}`);
    const unit = j.nsso_id ? perUnit(nslById.get(Number(j.nsso_line_id))) : perUnit(sol);
    const i = invM.get(Number(j.id));
    const invoiced = Number(i?.qty || 0);
    const uninvoiced = Number(j.completed_qty || 0) - invoiced;
    if (uninvoiced <= 0.0001) continue;
    const completed = qiM.get(Number(j.id))?.d || null;
    const done = completed || j.so_date;
    const doneDay = done ? String(done instanceof Date ? done.toISOString() : done).slice(0, 10) : null;
    if (from && (!doneDay || doneDay < from)) continue;
    if (to && (!doneDay || doneDay > to)) continue;
    out.push({
      ...j, unit_gross: unit, invoiced_qty: invoiced, invoice_nos: i?.invoice_nos || null,
      completed_date: completed, last_delivery_date: delM.get(Number(j.id))?.d || null,
      uninvoiced_qty: Number(uninvoiced.toFixed(4)),
      unbilled_amount: Number((uninvoiced * unit).toFixed(2)),
      days_pending: doneDay ? Math.max(0, Math.floor((today - new Date(doneDay)) / 86400000)) : null,
    });
  }
  out.sort((a, b) => String(a.completed_date || a.so_date || '').localeCompare(String(b.completed_date || b.so_date || '')) || String(a.job_order_no).localeCompare(String(b.job_order_no)));
  return out;
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await loadRows(req);
    const totals = rows.reduce((t, r) => ({
      jobs: t.jobs + 1, qty: t.qty + r.uninvoiced_qty, amount: t.amount + r.unbilled_amount,
      over30: t.over30 + (r.days_pending > 30 ? r.unbilled_amount : 0),
    }), { jobs: 0, qty: 0, amount: 0, over30: 0 });
    totals.amount = Number(totals.amount.toFixed(2)); totals.over30 = Number(totals.over30.toFixed(2));
    res.json({ rows, totals });
  } catch (err) {
    next(err);
  }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await loadRows(req);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pending Billing');
    ws.columns = [
      { header: 'Job Order', key: 'job_order_no', width: 20 },
      { header: 'SO / NSSO', key: 'order', width: 16 },
      { header: 'Customer', key: 'customer_name', width: 36 },
      { header: 'Sales Rep', key: 'sales_rep_name', width: 24 },
      { header: 'Description', key: 'description', width: 44 },
      { header: 'Completed', key: 'completed_date', width: 12 },
      { header: 'Days Pending', key: 'days_pending', width: 10 },
      { header: 'Qty', key: 'quantity', width: 9 },
      { header: 'Completed Qty', key: 'completed_qty', width: 11 },
      { header: 'Delivered Qty', key: 'quantity_delivered', width: 11 },
      { header: 'Invoiced Qty', key: 'invoiced_qty', width: 11 },
      { header: 'To Bill Qty', key: 'uninvoiced_qty', width: 11 },
      { header: 'Unit Price (Gross)', key: 'unit_gross', width: 14 },
      { header: 'Unbilled Amount', key: 'unbilled_amount', width: 15 },
      { header: 'Invoices so far', key: 'invoice_nos', width: 24 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({ ...r, order: r.sales_order_no || r.nsso_no || '', completed_date: r.completed_date ? String(r.completed_date).slice(0, 10) : '',
        unit_gross: Number(Number(r.unit_gross || 0).toFixed(2)) });
    }
    const total = ws.addRow({ job_order_no: 'Total', uninvoiced_qty: rows.reduce((s, r) => s + r.uninvoiced_qty, 0), unbilled_amount: rows.reduce((s, r) => s + r.unbilled_amount, 0) });
    total.font = { bold: true };
    for (const k of ['unit_gross', 'unbilled_amount']) ws.getColumn(k).numFmt = '#,##0.00';
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pending-billing-${new Date().toLocaleDateString('en-CA')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
