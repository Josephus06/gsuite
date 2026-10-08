const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { getJobLocationScope, isJobLocationVisible } = require('../lib/jobLocationVisibility');
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
              so.sales_order_no, ns.nsso_no, c.id AS customer_id, c.name AS customer_name,
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

// The Returned Material Authorization slip (asked 2026-10-08, in the live system's format) for an
// NSJO-RMA, an RFQC or an RWIP. Read by whoever can open any of those lists, Job Orders or
// Production -- the slip is printed from the JO's own screen, which both modules reach.
const PRINT_ROUTES = ['/rma-job-orders', '/rwip-job-orders', '/rfqc-job-orders', '/job-orders', '/production'];
router.get('/:id/print', requireAuth, async (req, res, next) => {
  try {
    let allowed = false;
    for (const r of PRINT_ROUTES) { if (await userCan(req.user.id, r, 'can_view')) { allowed = true; break; } }
    if (!allowed) return res.status(403).json({ error: 'You do not have permission to perform this action' });

    const [[jo]] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.units, jo.job_location_id, jo.reason, jo.action_to_be_taken,
              jo.created_at, jo.parent_job_order_id, ${TYPE_SQL} AS rma_type,
              c.name AS customer_name, COALESCE((SELECT ca.address_line FROM customer_addresses ca WHERE ca.customer_id = c.id ORDER BY ca.is_default DESC, ca.id LIMIT 1),
                NULLIF(c.address, ''), NULLIF(c.bill_to_address, ''),
                NULLIF(jo.shipping_address, ''), nsso.shipping_address) AS customer_address,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name, CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
              oloc.location_name AS office_location_name, loc.location_name AS job_location_name,
              COALESCE(nsso.nsso_no, so.sales_order_no, pnsso.nsso_no, pso.sales_order_no) AS so_no, nsso.date_created AS nsso_date,
              pjo.job_order_no AS parent_job_order_no, rc.name AS reason_code_name,
              CONCAT(rap.first_name, ' ', rap.last_name) AS approved_by_name,
              (SELECT u.display_name FROM audit_logs a JOIN users u ON u.id = a.set_by_user_id
                WHERE a.auditable_type = 'JobOrder' AND a.auditable_id = jo.id AND a.event_type = 'Created'
                ORDER BY a.id LIMIT 1) AS created_by_name,
              COALESCE(CONCAT(npe.first_name, ' ', npe.last_name), ncu.display_name) AS nsso_requested_by
         FROM job_orders jo
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN non_standard_sales_orders nsso ON nsso.id = jo.nsso_id
         LEFT JOIN sales_orders nsso_so ON nsso_so.id = nsso.nested_sales_order_id
         LEFT JOIN estimates nsest ON nsest.id = nsso.nested_estimate_id
         -- A rework JO raised before the SO / NSSO was copied onto it reads them off its mother JO.
         LEFT JOIN job_orders pjo ON pjo.id = jo.parent_job_order_id
         LEFT JOIN sales_orders pso ON pso.id = pjo.sales_order_id
         LEFT JOIN non_standard_sales_orders pnsso ON pnsso.id = pjo.nsso_id
         LEFT JOIN estimates pnsest ON pnsest.id = pnsso.nested_estimate_id
         LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, nsso.customer_id, nsso_so.customer_id, nsest.customer_id,
                                                  pso.customer_id, pnsso.customer_id, pnsest.customer_id)
         LEFT JOIN employees sr ON sr.id = jo.sales_rep_id
         LEFT JOIN employees ar ON ar.id = jo.artist_id
         LEFT JOIN locations loc ON loc.id = jo.job_location_id
         LEFT JOIN locations oloc ON oloc.id = COALESCE(so.office_location_id, nsso.office_location_id, pso.office_location_id, pnsso.office_location_id)
         LEFT JOIN reasons rc ON rc.id = jo.reason_code_id
         LEFT JOIN employees rap ON rap.id = jo.rma_approved_by_id
         LEFT JOIN employees npe ON npe.id = nsso.prepared_by_id
         LEFT JOIN users ncu ON ncu.id = nsso.created_by_user_id
        WHERE jo.id = ?`,
      [req.params.id],
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    const isRework = !!jo.parent_job_order_id && /^(RFQC|RWIP)-/.test(jo.job_order_no || '');
    if (!isRework && !/^NSJO-RMA-/.test(jo.job_order_no || '') && !/^NSSO-RMA-/.test(jo.so_no || '')) {
      return res.status(400).json({ error: 'The RMA slip is for NSJO-RMA, RFQC and RWIP job orders only.' });
    }
    if (!isJobLocationVisible(jo, await getJobLocationScope(req.user.id))) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT jop.line_no, pr.process_name, i.display_name AS item_name, jop.qty, jop.process_qty
         FROM job_order_processes jop
         LEFT JOIN processes pr ON pr.id = jop.process_id
         LEFT JOIN inventories i ON i.id = jop.item_id
        WHERE jop.job_order_id = ? ORDER BY jop.line_no, jop.id`,
      [jo.id],
    );
    res.json({
      ...jo,
      // An imported RMA carries no reason of its own; the live slip printed the job description there.
      reason_text: [jo.reason_code_name, jo.reason].filter(Boolean).join(' - ') || (isRework ? '' : jo.description) || '',
      requested_by: jo.created_by_name || jo.nsso_requested_by || '',
      date: jo.nsso_date || jo.created_at,
      lines: lines.map((l) => ({ ...l, qty: l.qty ?? l.process_qty })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
