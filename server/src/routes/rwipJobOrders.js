const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getJobLocationScope } = require('../lib/jobLocationVisibility');

const router = express.Router();
const ROUTE = '/rwip-job-orders';

// Lists every RWIP (rework-in-progress) job order -- job_orders rows with a parent_job_order_id.
// Read-only browse; RWIPs are created/approved/completed from the Production JO view.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, stage } = req.query;
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

    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.created_at, jo.quantity, jo.units, jo.status, jo.production_stage,
              jo.description, jo.parent_job_order_id, pjo.job_order_no AS parent_job_order_no,
              so.sales_order_no, c.name AS customer_name,
              jt.display_name AS job_type_name, loc.location_name AS job_location_name,
              CONCAT(rap.first_name, ' ', rap.last_name) AS rma_approved_by_name
       FROM job_orders jo
       LEFT JOIN job_orders pjo ON pjo.id = jo.parent_job_order_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN employees rap ON rap.id = jo.rma_approved_by_id
       WHERE ${where.join(' AND ')}
       ORDER BY jo.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
