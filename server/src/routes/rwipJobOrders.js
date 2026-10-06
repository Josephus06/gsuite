const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getJobLocationScope } = require('../lib/jobLocationVisibility');
const { sendXlsx, day } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/rwip-job-orders';

// The list's filters, shared with its Excel extract so the file holds exactly what the list shows.
async function listFilter(req) {
  const { search, stage, date_from: dateFrom, as_of: asOf } = req.query;
  const where = ['jo.parent_job_order_id IS NOT NULL', "jo.job_order_no LIKE 'RWIP-%'"];
  const params = [];
  // A rework job order sits in the same warehouse as the job it came from, so the department
  // restriction applies here exactly as it does on the Production list.
  const scopeLocationId = await getJobLocationScope(req.user.id);
  if (scopeLocationId) { where.push('jo.job_location_id = ?'); params.push(scopeLocationId); }
  if (search) {
    where.push('(jo.job_order_no LIKE ? OR pjo.job_order_no LIKE ? OR c.name LIKE ? OR so.sales_order_no LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  // "pending" = still awaiting RMA approval; "open" = approved but not yet completed; "completed".
  if (stage === 'pending') where.push("jo.status = 'Pending RMA Approval'");
  else if (stage === 'open') where.push("jo.status <> 'Pending RMA Approval' AND jo.status <> 'Cancelled' AND (jo.production_stage IS NULL OR jo.production_stage NOT IN ('completed','invoiced'))");
  else if (stage === 'completed') where.push("jo.production_stage IN ('completed','invoiced')");
  // Period From / As of Date: inclusive bounds on the Date column (created_at, a DATETIME -- so
  // As of runs to the end of that day, not its midnight).
  if (dateFrom) { where.push('jo.created_at >= ?'); params.push(String(dateFrom).slice(0, 10)); }
  if (asOf) { where.push('jo.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(String(asOf).slice(0, 10)); }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

const LIST_SELECT = `SELECT jo.id, jo.job_order_no, jo.created_at, jo.quantity, jo.units, jo.status, jo.production_stage,
              jo.description, jo.parent_job_order_id, pjo.job_order_no AS parent_job_order_no,
              so.sales_order_no, c.id AS customer_id, c.name AS customer_name,
              jt.display_name AS job_type_name, loc.location_name AS job_location_name,
              CONCAT(rap.first_name, ' ', rap.last_name) AS rma_approved_by_name
       FROM job_orders jo
       LEFT JOIN job_orders pjo ON pjo.id = jo.parent_job_order_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN employees rap ON rap.id = jo.rma_approved_by_id`;

// Lists every RWIP (rework-in-progress) job order -- job_orders rows with a parent_job_order_id.
// Read-only browse; RWIPs are created/approved/completed from the Production JO view.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = await listFilter(req);
    const [rows] = await pool.query(
      `${LIST_SELECT}
       ${whereSql}
       ORDER BY jo.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Same Status wording as the list page's statusLabel().
const STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.', for_revision: 'For Revision', in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process', for_qi: 'For QI', partially_completed: 'Part. Completed', completed: 'Completed', invoiced: 'Invoiced',
};
function statusLabel(r) {
  if (r.status === 'Pending RMA Approval' || r.status === 'Cancelled') return r.status;
  return STAGE_LABELS[r.production_stage] || r.status;
}

// Extract: every RWIP under the list's current filters, as a workbook.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = await listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY jo.id DESC`, params);
    await sendXlsx(res, {
      filename: 'rwip-job-orders.xlsx',
      sheet: 'RWIP Job Orders',
      columns: [
        { header: 'RWIP #', key: 'job_order_no', width: 18 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Mother JO', key: 'mother_jo', width: 18 },
        { header: 'Sales Order', key: 'so_no', width: 14 },
        { header: 'Customer', key: 'customer', width: 38 },
        { header: 'Job Type', key: 'job_type', width: 22 },
        { header: 'Description', key: 'description', width: 50 },
        { header: 'Qty', key: 'qty', width: 10 },
        { header: 'Approved By', key: 'approved_by', width: 24 },
        { header: 'Status', key: 'status', width: 20 },
      ],
      rows: rows.map((r) => ({
        job_order_no: r.job_order_no, date: day(r.created_at), mother_jo: r.parent_job_order_no || '',
        so_no: r.sales_order_no || '', customer: r.customer_name || '', job_type: r.job_type_name || '',
        description: r.description || '', qty: Number(r.quantity || 0),
        approved_by: (r.rma_approved_by_name || '').trim(), status: statusLabel(r) || '',
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
