const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getArtistEmployeeScope } = require('../lib/artistVisibility');

const router = express.Router();
const ROUTE = '/reports/artist-incentive';

// How both incentives are calculated now lives in lib/artistIncentive.js, shared with the
// artist's own Assigned JO worklist -- the two must never quote different figures for the
// same job, which a second copy of these rules is exactly how you get.
const {
  JO_INCENTIVE_AMOUNT, NSTDJO_INCENTIVE_BASIS,
  jobOrderIncentiveExpression, nstdjoIncentiveExpression, joIncentiveBasis,
} = require('../lib/artistIncentive');
const { buildArtistIncentiveWorkbook } = require('../lib/artistIncentiveWorkbook');

// Matches COMPLETED_STATUS in nonStandardJobOrders.js -- an NSTDJO only earns once Sales
// have signed it off.
const COMPLETED_STATUS = 'COMPLETED';

// account_type on the USER account, not a field on the employee record -- the same value the
// Job Order assignment picker filters by (routes/employees.js, ?account_type=Artist).
const ARTIST_ACCOUNT_TYPE = 'Artist';

// Both sides are filtered on the date the artist actually finished the layout
// (layout_ended_at), not when the work was planned or the order raised -- an incentive is
// earned when the work is done.
//
// The report itself, separated from how it is delivered. The JSON the screen reads and the
// workbook the Download button produces are built from the SAME object -- an export running
// its own copy of this query is how the file and the screen it claims to copy drift apart.
async function buildReport(req) {
  const { from = '', to = '', artist_id: artistId = '', source = '' } = req.query;
  // Extract one document type only. Anything other than the two known values is treated
  // as "both" rather than rejected -- a stale bookmark should show the whole report, not
  // an error page.
  const wantJo = source !== 'NSTDJO';
  const wantNstdjo = source !== 'JO';

  // An incentive is earned when SALES SIGN THE WORK OFF, not when the artist puts their
  // pen down. Both sources are held to that:
  //  - a Job Order once it has cleared Sales Approval, which moves its Sub Status to
  //    'Approved' (see PUT /job-orders/:id/approve-sales);
  //  - a Non-Standard Job Order once the order is COMPLETED, which is what Sales signing
  //    it off does there.
  // Both still need the artist to have finished (layout_ended_at) and are dated by that
  // end, so an order approved later still lands in the period the work was done.
  //
  // The JO rule used to be layout_ended_at alone, which credited work Sales had not yet
  // accepted -- and would still have credited it had Sales sent it back. Note the effect:
  // a finished-but-unapproved JO now drops out of the report until it is approved.
  const joWhere = ['jo.artist_id IS NOT NULL', 'jo.layout_ended_at IS NOT NULL', "jo.sub_status = 'Approved'"];
  const nWhere = ['n.artist_employee_id IS NOT NULL', 'n.layout_ended_at IS NOT NULL', 'n.status = ?'];
  const joParams = [];
  const nParams = [COMPLETED_STATUS];
  if (from) { joWhere.push('DATE(jo.layout_ended_at) >= ?'); joParams.push(from); nWhere.push('DATE(n.layout_ended_at) >= ?'); nParams.push(from); }
  if (to) { joWhere.push('DATE(jo.layout_ended_at) <= ?'); joParams.push(to); nWhere.push('DATE(n.layout_ended_at) <= ?'); nParams.push(to); }
  if (artistId) { joWhere.push('jo.artist_id = ?'); joParams.push(artistId); nWhere.push('n.artist_employee_id = ?'); nParams.push(artistId); }

  // An Artist only ever sees their own incentives; everyone else with access to the
  // report sees all of them.
  const artistEmployeeId = await getArtistEmployeeScope(req.user.id);
  if (artistEmployeeId) {
    joWhere.push('jo.artist_id = ?'); joParams.push(artistEmployeeId);
    nWhere.push('n.artist_employee_id = ?'); nParams.push(artistEmployeeId);
  }

  // A Job Order's own sales_rep_id is the authority, but it is not always populated on
  // older rows -- fall back to the Sales Order it came from, which always carries one.
  const [joRows] = wantJo ? await pool.query(
    `SELECT 'JO' AS source, jo.id, jo.job_order_no AS doc_no, jo.description,
            jo.layout_ended_at AS actual_end, jo.artist_id AS artist_employee_id,
            CONCAT(e.first_name, ' ', e.last_name) AS artist_name,
            CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
            c.name AS customer_name,
            pjt.display_name AS layout_job_type_name,
            COALESCE(NULLIF(jo.layout_qty, 0), 1) AS layout_qty,
            ${joIncentiveBasis('jo')} AS incentive_basis,
            ${jobOrderIncentiveExpression('jo')} AS incentive_amount
       FROM job_orders jo
       LEFT JOIN employees e ON e.id = jo.artist_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN employees sr ON sr.id = COALESCE(jo.sales_rep_id, so.sales_rep_id)
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
      WHERE ${joWhere.join(' AND ')}`,
    joParams,
  ) : [[]];

  const [nRows] = wantNstdjo ? await pool.query(
    `SELECT 'NSTDJO' AS source, n.id, n.nstdjo_no AS doc_no, n.description,
            n.layout_ended_at AS actual_end, n.artist_employee_id,
            CONCAT(e.first_name, ' ', e.last_name) AS artist_name,
            CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
            c.name AS customer_name,
            pjt.display_name AS layout_job_type_name,
            COALESCE(NULLIF(n.layout_qty, 0), 1) AS layout_qty,
            '${NSTDJO_INCENTIVE_BASIS}' AS incentive_basis,
            ${nstdjoIncentiveExpression('n')} AS incentive_amount
       FROM non_standard_job_orders n
       LEFT JOIN employees e ON e.id = n.artist_employee_id
       LEFT JOIN employees sr ON sr.id = n.sales_rep_id
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
      WHERE ${nWhere.join(' AND ')}`,
    nParams,
  ) : [[]];

  const rows = [...joRows, ...nRows]
    .map((r) => ({ ...r, incentive_amount: Number(r.incentive_amount || 0) }))
    .sort((a, b) => new Date(b.actual_end) - new Date(a.actual_end));

  // Per-artist subtotals, so the report reads as a payout sheet rather than a log.
  const byArtist = new Map();
  for (const row of rows) {
    const key = String(row.artist_employee_id);
    if (!byArtist.has(key)) {
      byArtist.set(key, {
        artist_employee_id: row.artist_employee_id, artist_name: row.artist_name,
        jo_count: 0, nstdjo_count: 0, jo_amount: 0, nstdjo_amount: 0, total: 0,
      });
    }
    const bucket = byArtist.get(key);
    if (row.source === 'JO') { bucket.jo_count += 1; bucket.jo_amount += row.incentive_amount; }
    else { bucket.nstdjo_count += 1; bucket.nstdjo_amount += row.incentive_amount; }
    bucket.total += row.incentive_amount;
  }
  const summary = [...byArtist.values()]
    .map((b) => ({
      ...b,
      jo_amount: Number(b.jo_amount.toFixed(2)),
      nstdjo_amount: Number(b.nstdjo_amount.toFixed(2)),
      total: Number(b.total.toFixed(2)),
    }))
    .sort((a, b) => b.total - a.total);

  return {
    rows,
    summary,
    grand_total: Number(rows.reduce((sum, r) => sum + r.incentive_amount, 0).toFixed(2)),
    jo_incentive_amount: JO_INCENTIVE_AMOUNT,
    filters: { from, to, artist_id: artistId, source },
  };
}

// The workbook names the artist it was filtered to, not the raw id -- a file called
// "artist 7" is no use to whoever opens it a month later. Read from employees rather than
// off the rows so the caption is still right when that artist earned nothing in the period,
// which is exactly when someone checks.
async function artistLabel(artistId) {
  if (!artistId) return 'All artists';
  const [[row]] = await pool.query(
    "SELECT CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = ?",
    [artistId],
  );
  return row?.name || `Employee ${artistId}`;
}

// A filename that says what is inside it, because these get saved and mailed on. Slashes and
// the rest are already impossible here -- every part is a date or a fixed word.
function workbookFilename(filters, layout) {
  const range = [filters.from, filters.to].filter(Boolean).join('_to_') || 'all-dates';
  return `artist-incentive_${range}${layout === 'per-artist' ? '_per-artist' : ''}.xlsx`;
}

// One route, three representations. `format=xlsx` downloads the report; `layout` picks
// between the single Detail sheet and a sheet per artist. Anything else is the JSON the
// screen has always read, so an old client keeps working untouched.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const report = await buildReport(req);

    if (String(req.query.format || '').toLowerCase() === 'xlsx') {
      const layout = String(req.query.layout || '') === 'per-artist' ? 'per-artist' : 'all';
      report.filters.artist_label = await artistLabel(report.filters.artist_id);
      const workbook = buildArtistIncentiveWorkbook(report, layout);
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',
        `attachment; filename="${workbookFilename(report.filters, layout)}"`);
      // Written straight to the response: a payout period can run to thousands of rows and
      // there is no reason to hold the whole file in memory to hand it over.
      await workbook.xlsx.write(res);
      return res.end();
    }

    return res.json(report);
  } catch (err) { return next(err); }
});

// Artists to populate the filter: EVERY artist, not only the ones who have earned something.
//
// Deriving this list from earnings was wrong twice over. It made the filter useless as a
// payout tool -- "did this artist earn anything this period?" is a question you ask *about*
// an artist, and an empty answer for a real artist is information, not an error -- and it
// made the dropdown a running commentary on the data instead of a stable list, so an office
// with many artists saw three names and reasonably concluded the report was broken.
//
// An artist is someone whose linked user account is of type 'Artist', the same definition
// the Job Order assignment picker uses (GET /employees?account_type=Artist). Sharing that
// definition is the point: the people you can assign layout work to are exactly the people
// you can then filter the incentives by. It also drops anyone who merely *holds* a job order
// without being an artist -- a System Admin who was assigned one, say.
//
// The second arm keeps anyone who actually has incentive rows, whatever their account type
// is now. Without it a filter can miss someone the report body still shows: account types
// change, and an artist who has since moved on or been made a supervisor keeps the work they
// did. A name in the body that cannot be selected in the filter is the mismatch this whole
// endpoint has already been fixed for once.
router.get('/artists', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // Scoped the same way the body is: an Artist may only see their own incentives, so
    // listing everyone else in their filter is both a dead end and other people's names.
    const artistEmployeeId = await getArtistEmployeeScope(req.user.id);
    const scope = artistEmployeeId ? 'AND e.id = ?' : '';
    const params = [ARTIST_ACCOUNT_TYPE, COMPLETED_STATUS];
    if (artistEmployeeId) params.push(artistEmployeeId);
    const [rows] = await pool.query(
      `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name
         FROM employees e
        WHERE (e.id IN (SELECT u.employee_id FROM users u
                         WHERE u.account_type = ? AND u.employee_id IS NOT NULL)
            OR e.id IN (SELECT artist_id FROM job_orders
                         WHERE artist_id IS NOT NULL AND layout_ended_at IS NOT NULL
                           AND sub_status = 'Approved')
            OR e.id IN (SELECT artist_employee_id FROM non_standard_job_orders
                         WHERE artist_employee_id IS NOT NULL AND layout_ended_at IS NOT NULL
                           AND status = ?))
          ${scope}
        ORDER BY e.first_name, e.last_name`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
