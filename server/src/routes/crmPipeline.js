const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveScope } = require('./dashboard');

const router = express.Router();

// Replaces the old manually-tracked Opportunities pipeline (prospecting/qualified/
// proposal/... with a hand-typed estimated_value) with one derived entirely from real
// documents: every deal already leaves a trail through estimates -> sales_orders ->
// job_orders, so there's nothing to duplicate-enter. One row per estimate (the natural
// "one deal" unit); its stage and dollar value come from whichever document it's
// actually progressed to, not a guess.
const STAGE_LABELS = {
  estimate_pending: 'Estimate - Pending Approval',
  estimate_approved: 'Estimate - Approved',
  sales_order: 'Sales Order',
  in_production: 'In Production',
  delivery: 'Delivery',
  billing: 'Billing',
  won: 'Won (Billed)',
  lost: 'Lost',
};
const OPEN_STAGES = ['estimate_pending', 'estimate_approved', 'sales_order', 'in_production', 'delivery', 'billing'];

function deriveStage(row) {
  if (row.estimate_status === 'cancelled' || row.estimate_status === 'disapproved') return 'lost';
  if (!row.sales_order_id) return row.estimate_status === 'approved' ? 'estimate_approved' : 'estimate_pending';
  if (row.so_status === 'cancelled') return 'lost';
  if (row.so_status === 'billed') return 'won';
  if (row.so_status === 'pending_billing' || row.so_status === 'pending_billing_partially_delivered') return 'billing';
  if (row.so_status === 'pending_delivery' || row.so_status === 'partially_delivered') return 'delivery';
  if (row.so_status === 'jo_in_process') return 'in_production';
  return 'sales_order'; // pending_for_jo
}

async function fetchPipeline(scope) {
  const scoped = scope.employeeIds && scope.employeeIds.length;
  const where = scoped ? `WHERE e.sales_rep_id IN (${scope.employeeIds.map(() => '?').join(', ')})` : '';
  const params = scoped ? scope.employeeIds : [];

  const [rows] = await pool.query(
    `SELECT e.id AS estimate_id, e.estimate_no, e.date_created, e.status AS estimate_status,
            e.total_amount AS estimate_amount, e.customer_id, c.name AS customer_name,
            e.sales_rep_id, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
            so.id AS sales_order_id, so.sales_order_no, so.status AS so_status, so.total_amount AS so_amount,
            (SELECT COUNT(*) FROM job_orders jo WHERE jo.sales_order_id = so.id) AS job_order_count
     FROM estimates e
     LEFT JOIN customers c ON c.id = e.customer_id
     LEFT JOIN employees sr ON sr.id = e.sales_rep_id
     LEFT JOIN (
       SELECT so1.* FROM sales_orders so1
       INNER JOIN (SELECT estimate_id, MAX(id) AS max_id FROM sales_orders GROUP BY estimate_id) latest
         ON latest.estimate_id = so1.estimate_id AND latest.max_id = so1.id
     ) so ON so.estimate_id = e.id
     ${where}
     ORDER BY e.date_created DESC, e.id DESC`,
    params
  );

  return rows.map((r) => ({
    ...r,
    stage: deriveStage(r),
    value: Number(r.so_amount ?? r.estimate_amount ?? 0),
    current_doc_no: r.sales_order_no || r.estimate_no,
  }));
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { customer_id: customerId } = req.query;
    const scope = await resolveScope(req.user.id);
    let rows = await fetchPipeline(scope);
    if (customerId) rows = rows.filter((r) => String(r.customer_id) === String(customerId));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/meta/stages', requireAuth, (req, res) => {
  res.json({ labels: STAGE_LABELS, openStages: OPEN_STAGES });
});

module.exports = router;
