const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getJobLocationScope } = require('../lib/jobLocationVisibility');
const { sendXlsx, day } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/rma-job-orders';

// Production > RMA (asked 2026-10-06): every returned / reworked job in one list --
//   RMA   job orders raised from an RMA Non-Standard Sales Order (NSSO-RMA-#), 1,277 at the time
//   RFQC  rework raised by Quality Inspection for the rejected qty (RFQC-#, off a mother JO)
//   RWIP  rework raised from Production (RWIP-#, off a mother JO)
// The RWIP and RFQC pages still list their own kind; this is the one place to see all three.
// Read-only: each is approved and worked from its own Job Order / Production view.
const TYPE_SQL = `CASE WHEN jo.parent_job_order_id IS NOT NULL AND jo.job_order_no LIKE 'RFQC-%' THEN 'RFQC'
                       WHEN jo.parent_job_order_id IS NOT NULL AND jo.job_order_no LIKE 'RWIP-%' THEN 'RWIP'
                       ELSE 'RMA' END`;
const TYPE_CONDITIONS = {
  RMA: "ns.nsso_no LIKE 'NSSO-RMA-%'",
  RFQC: "(jo.parent_job_order_id IS NOT NULL AND jo.job_order_no LIKE 'RFQC-%')",
  RWIP: "(jo.parent_job_order_id IS NOT NULL AND jo.job_order_no LIKE 'RWIP-%')",
};

// The list's filters, shared with its Excel extract so the file holds exactly what the list shows.
async function listFilter(req) {
  const { search, stage, type, date_from: dateFrom, as_of: asOf } = req.query;
  const where = [TYPE_CONDITIONS[String(type || '').toUpperCase()] || `(${Object.values(TYPE_CONDITIONS).join(' OR ')})`];
  const params = [];
  // A production department sees its own warehouse's jobs, as on the Production list.
  const scopeLocationId = await getJobLocationScope(req.user.id);
  if (scopeLocationId) { where.push('jo.job_location_id = ?'); params.push(scopeLocationId); }
  if (search) {
    where.push('(jo.job_order_no LIKE ? OR pjo.job_order_no LIKE ? OR c.name LIKE ? OR so.sales_order_no LIKE ? OR ns.nsso_no LIKE ?)');
    params.push(...Array(5).fill(`%${search}%`));
  }
  // Same three stages as the RWIP / RFQC lists.
  if (stage === 'pending') where.push("jo.status IN ('Pending RMA Approval', 'Pending Approval')");
  else if (stage === 'open') where.push("jo.status NOT IN ('Pending RMA Approval', 'Pending Approval', 'Cancelled') AND (jo.production_stage IS NULL OR jo.production_stage NOT IN ('completed','invoiced'))");
  else if (stage === 'completed') where.push("jo.production_stage IN ('completed','invoiced')");
  else if (stage === 'cancelled') where.push("jo.status = 'Cancelled'");
  // Period From / As of Date on the Date column (created_at, a DATETIME -- As of runs to the end of its day).
  if (dateFrom) { where.push('jo.created_at >= ?'); params.push(String(dateFrom).slice(0, 10)); }
  if (asOf) { where.push('jo.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(String(asOf).slice(0, 10)); }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

// The customer is the Sales Order's for rework, the NSSO's for an RMA (which has no Sales Order).
const LIST_SELECT = `SELECT jo.id, ${TYPE_SQL} AS rma_type, jo.job_order_no, jo.created_at, jo.quantity, jo.units, jo.status,
              jo.production_stage, jo.description, pjo.job_order_no AS parent_job_order_no,
              so.sales_order_no, ns.nsso_no, c.name AS customer_name,
              jt.display_name AS job_type_name, loc.location_name AS job_location_name,
              CONCAT(rap.first_name, ' ', rap.last_name) AS rma_approved_by_name
       FROM job_orders jo
       LEFT JOIN job_orders pjo ON pjo.id = jo.parent_job_order_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, ns.customer_id)
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN employees rap ON rap.id = jo.rma_approved_by_id`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = await listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY jo.id DESC`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// Same Status wording as the list page's statusLabel().
const STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.', for_revision: 'For Revision', in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process', for_qi: 'For QI', partially_completed: 'Part. Completed', completed: 'Completed', invoiced: 'Invoiced',
};
function statusLabel(r) {
  if (['Pending RMA Approval', 'Pending Approval', 'Cancelled'].includes(r.status)) return r.status;
  return STAGE_LABELS[r.production_stage] || r.status;
}

// Extract: every row under the list's current filters, as a workbook.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = await listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY jo.id DESC`, params);
    await sendXlsx(res, {
      filename: 'rma-job-orders.xlsx',
      sheet: 'RMA Job Orders',
      columns: [
        { header: 'Type', key: 'type', width: 8 },
        { header: 'JO #', key: 'job_order_no', width: 20 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Mother JO', key: 'mother_jo', width: 18 },
        { header: 'SO / NSSO', key: 'source', width: 16 },
        { header: 'Customer', key: 'customer', width: 38 },
        { header: 'Job Type', key: 'job_type', width: 22 },
        { header: 'Description', key: 'description', width: 50 },
        { header: 'Qty', key: 'qty', width: 10 },
        { header: 'Location', key: 'location', width: 20 },
        { header: 'Approved By', key: 'approved_by', width: 24 },
        { header: 'Status', key: 'status', width: 22 },
      ],
      rows: rows.map((r) => ({
        type: r.rma_type, job_order_no: r.job_order_no, date: day(r.created_at), mother_jo: r.parent_job_order_no || '',
        source: r.sales_order_no || r.nsso_no || '', customer: r.customer_name || '', job_type: r.job_type_name || '',
        description: r.description || '', qty: Number(r.quantity || 0), location: r.job_location_name || '',
        approved_by: (r.rma_approved_by_name || '').trim(), status: statusLabel(r) || '',
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
