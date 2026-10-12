// The RWIP and RFQC Job Orders lists (routes/rwipJobOrders.js, routes/rfqcJobOrders.js): both browse
// rework job orders -- job_orders with a parent and an RWIP- / RFQC- number -- with the same filters
// as the NSSO list (2026-10-12): General Searching, Location (the office of the order behind it --
// the Sales Order's, else the NSSO's, else its mother JO's; the pages start on Head Office), Date (As of, or a From-To
// period), Sales Rep, Customer and Status, and an Excel Extract of exactly what the list shows.
const pool = require('../db');
const { getJobLocationScope } = require('./jobLocationVisibility');
const { sendXlsx, day } = require('./xlsxExport');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const FROM = `FROM job_orders jo
       LEFT JOIN job_orders pjo ON pjo.id = jo.parent_job_order_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN non_standard_sales_orders nso ON nso.id = jo.nsso_id
       LEFT JOIN sales_orders pso ON pso.id = pjo.sales_order_id
       LEFT JOIN non_standard_sales_orders pnso ON pnso.id = pjo.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, (SELECT COALESCE(nx.customer_id, ex.customer_id, sx.customer_id) FROM non_standard_sales_orders nx LEFT JOIN estimates ex ON ex.id = nx.nested_estimate_id LEFT JOIN sales_orders sx ON sx.id = nx.nested_sales_order_id WHERE nx.id = jo.nsso_id))
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN locations oloc ON oloc.id = COALESCE(so.office_location_id, nso.office_location_id, pso.office_location_id, pnso.office_location_id)
       LEFT JOIN employees rap ON rap.id = jo.rma_approved_by_id
       LEFT JOIN employees sr ON sr.id = COALESCE(jo.sales_rep_id, so.sales_rep_id, nso.sales_rep_id, pso.sales_rep_id, pnso.sales_rep_id)`;
const SELECT = `SELECT jo.id, jo.job_order_no, jo.created_at, jo.quantity, jo.units, jo.status, jo.production_stage,
              jo.description, jo.parent_job_order_id, pjo.job_order_no AS parent_job_order_no,
              so.sales_order_no, c.id AS customer_id, c.name AS customer_name,
              jt.display_name AS job_type_name, loc.location_name AS job_location_name,
              oloc.location_name AS office_location_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(rap.first_name, ' ', rap.last_name) AS rma_approved_by_name`;

async function listFilter(req, prefix) {
  const { search, stage } = req.query;
  const where = ['jo.parent_job_order_id IS NOT NULL', `jo.job_order_no LIKE '${prefix}-%'`];
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
  if (Number(req.query.location_id) > 0) { where.push('COALESCE(so.office_location_id, nso.office_location_id, pso.office_location_id, pnso.office_location_id) = ?'); params.push(Number(req.query.location_id)); }
  if (Number(req.query.sales_rep_id) > 0) { where.push('COALESCE(jo.sales_rep_id, so.sales_rep_id, nso.sales_rep_id, pso.sales_rep_id, pnso.sales_rep_id) = ?'); params.push(Number(req.query.sales_rep_id)); }
  if (Number(req.query.customer_id) > 0) { where.push('c.id = ?'); params.push(Number(req.query.customer_id)); }
  // The Date column is created_at, a DATETIME -- so an upper bound runs to the end of that day.
  const { date_mode: mode, date_from: from, date_to: to, as_of: asOf } = req.query;
  if (mode === 'range') {
    if (ISO_DAY.test(from || '')) { where.push('jo.created_at >= ?'); params.push(from); }
    if (ISO_DAY.test(to || '')) { where.push('jo.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to); }
  } else {
    // As of. (date_from on its own is the older RWIP page's Period From -- still honoured.)
    if (ISO_DAY.test(from || '')) { where.push('jo.created_at >= ?'); params.push(from); }
    if (ISO_DAY.test(asOf || '')) { where.push('jo.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(asOf); }
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

async function listRows(req, prefix) {
  const { whereSql, params } = await listFilter(req, prefix);
  const [rows] = await pool.query(`${SELECT} ${FROM} ${whereSql} ORDER BY jo.id DESC`, params);
  return rows;
}

// The Sales Rep and Customer filters' choices: only those on this kind of rework job order.
async function filterOptions(req, prefix) {
  const { whereSql, params } = await listFilter({ user: req.user, query: {} }, prefix);
  const [reps] = await pool.query(
    `SELECT DISTINCT sr.id, CONCAT(sr.first_name, ' ', sr.last_name) AS name ${FROM} ${whereSql} AND sr.id IS NOT NULL ORDER BY name`, params);
  const [customers] = await pool.query(
    `SELECT DISTINCT c.id, c.name ${FROM} ${whereSql} AND c.id IS NOT NULL ORDER BY c.name`, params);
  return { reps, customers };
}

const STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.', for_revision: 'For Revision', in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process', for_qi: 'For QI', partially_completed: 'Part. Completed', completed: 'Completed', invoiced: 'Invoiced',
};
function statusLabel(r) {
  if (r.status === 'Pending RMA Approval' || r.status === 'Cancelled') return r.status;
  return STAGE_LABELS[r.production_stage] || r.status;
}

async function sendExtract(res, rows, prefix) {
  await sendXlsx(res, {
    filename: `${prefix.toLowerCase()}-job-orders.xlsx`,
    sheet: `${prefix} Job Orders`,
    columns: [
      { header: `${prefix} #`, key: 'job_order_no', width: 18 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Mother JO', key: 'mother_jo', width: 18 },
      { header: 'Sales Order', key: 'so_no', width: 14 },
      { header: 'Location', key: 'location', width: 18 },
      { header: 'Customer', key: 'customer', width: 38 },
      { header: 'Sales Rep', key: 'sales_rep', width: 24 },
      { header: 'Job Type', key: 'job_type', width: 22 },
      { header: 'Description', key: 'description', width: 50 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Approved By', key: 'approved_by', width: 24 },
      { header: 'Status', key: 'status', width: 20 },
    ],
    rows: rows.map((r) => ({
      job_order_no: r.job_order_no, date: day(r.created_at), mother_jo: r.parent_job_order_no || '',
      so_no: r.sales_order_no || '', location: r.office_location_name || '', customer: r.customer_name || '',
      sales_rep: (r.sales_rep_name || '').trim(), job_type: r.job_type_name || '',
      description: r.description || '', qty: Number(r.quantity || 0),
      approved_by: (r.rma_approved_by_name || '').trim(), status: statusLabel(r) || '',
    })),
  });
}

module.exports = { listRows, filterOptions, sendExtract, statusLabel };
