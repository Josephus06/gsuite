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

// Matches COMPLETED_STATUS in nonStandardJobOrders.js -- an NSTDJO only earns once Sales
// have signed it off.
const COMPLETED_STATUS = 'COMPLETED';

// Both sides are filtered on the date the artist actually finished the layout
// (layout_ended_at), not when the work was planned or the order raised -- an incentive is
// earned when the work is done.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from = '', to = '', artist_id: artistId = '', source = '' } = req.query;
    // Extract one document type only. Anything other than the two known values is treated
    // as "both" rather than rejected -- a stale bookmark should show the whole report, not
    // an error page.
    const wantJo = source !== 'NSTDJO';
    const wantNstdjo = source !== 'JO';

    // What makes an incentive earned differs by source:
    //  - a Job Order counts as soon as the artist stops the timer on their Assigned JO
    //    (layout_ended_at), which is the end of their involvement in it;
    //  - a Non-Standard Job Order counts only once Sales have signed it off and the order
    //    is COMPLETED -- it can still be bounced around before that.
    // Both are dated by the actual end date, so an order completed later still lands in
    // the period the work was actually finished.
    const joWhere = ['jo.artist_id IS NOT NULL', 'jo.layout_ended_at IS NOT NULL'];
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

    res.json({
      rows,
      summary,
      grand_total: Number(rows.reduce((sum, r) => sum + r.incentive_amount, 0).toFixed(2)),
      jo_incentive_amount: JO_INCENTIVE_AMOUNT,
      filters: { from, to, artist_id: artistId, source },
    });
  } catch (err) { next(err); }
});

// Artists to populate the filter -- only those who actually have finished layout work,
// so the dropdown isn't the whole employee list.
router.get('/artists', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name
         FROM employees e
        WHERE e.id IN (SELECT artist_id FROM job_orders WHERE artist_id IS NOT NULL AND layout_ended_at IS NOT NULL)
           OR e.id IN (SELECT artist_employee_id FROM non_standard_job_orders WHERE artist_employee_id IS NOT NULL AND layout_ended_at IS NOT NULL)
        ORDER BY e.first_name, e.last_name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
