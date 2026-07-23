const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getArtistEmployeeScope } = require('../lib/artistVisibility');

const router = express.Router();
const ROUTE = '/reports/artist-incentive';

// A Non-Standard Job Order carries its artist incentive per materials line, worked out
// when the order was saved (5% of that line's Process Price -- see ARTIST_INCENTIVE_RATE
// in nonStandardJobOrders.js). Reading the stored figure rather than recomputing means a
// later change to the rate cannot restate what past work already earned.
//
// A Job Order earns a flat 7.50 per unit of layout work -- NOT a percentage. It has no
// per-line price to take a percentage of (its process lines record process_cost only, and
// its layout is described by a PMS Job Type carrying minutes, not pesos), so the incentive
// is a fixed amount rather than a rate.
//
// Scaled by layout_qty -- the number of files/designs the artist laid out -- because that
// is how the rest of the system measures the same effort (planned end = the layout job
// type's minutes_consume x layout_qty). layout_qty defaults to 1, so for the ordinary
// single-layout job this is simply 7.50 per Job Order.
const JO_INCENTIVE_AMOUNT = 7.5;
// Matches COMPLETED_STATUS in nonStandardJobOrders.js -- an NSTDJO only earns once Sales
// have signed it off.
const COMPLETED_STATUS = 'COMPLETED';

function jobOrderIncentiveExpression() {
  return `ROUND(${JO_INCENTIVE_AMOUNT} * COALESCE(NULLIF(jo.layout_qty, 0), 1), 2)`;
}

// Both sides are filtered on the date the artist actually finished the layout
// (layout_ended_at), not when the work was planned or the order raised -- an incentive is
// earned when the work is done.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from = '', to = '', artist_id: artistId = '' } = req.query;

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

    const [joRows] = await pool.query(
      `SELECT 'JO' AS source, jo.id, jo.job_order_no AS doc_no, jo.description,
              jo.layout_ended_at AS actual_end, jo.artist_id AS artist_employee_id,
              CONCAT(e.first_name, ' ', e.last_name) AS artist_name,
              c.name AS customer_name,
              pjt.display_name AS layout_job_type_name,
              COALESCE(NULLIF(jo.layout_qty, 0), 1) AS layout_qty,
              CONCAT(${JO_INCENTIVE_AMOUNT}, ' x ', COALESCE(NULLIF(jo.layout_qty, 0), 1)) AS incentive_basis,
              ${jobOrderIncentiveExpression()} AS incentive_amount
         FROM job_orders jo
         LEFT JOIN employees e ON e.id = jo.artist_id
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
        WHERE ${joWhere.join(' AND ')}`,
      joParams,
    );

    const [nRows] = await pool.query(
      `SELECT 'NSTDJO' AS source, n.id, n.nstdjo_no AS doc_no, n.description,
              n.layout_ended_at AS actual_end, n.artist_employee_id,
              CONCAT(e.first_name, ' ', e.last_name) AS artist_name,
              c.name AS customer_name,
              pjt.display_name AS layout_job_type_name,
              COALESCE(NULLIF(n.layout_qty, 0), 1) AS layout_qty,
              '5% per line' AS incentive_basis,
              ROUND(COALESCE((
                SELECT SUM(m.artist_incentive) FROM non_standard_job_order_materials m
                 WHERE m.non_standard_job_order_id = n.id
              ), 0), 2) AS incentive_amount
         FROM non_standard_job_orders n
         LEFT JOIN employees e ON e.id = n.artist_employee_id
         LEFT JOIN customers c ON c.id = n.customer_id
         LEFT JOIN pms_job_types pjt ON pjt.id = n.layout_job_type_id
        WHERE ${nWhere.join(' AND ')}`,
      nParams,
    );

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
      filters: { from, to, artist_id: artistId },
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
