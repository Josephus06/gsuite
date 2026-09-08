const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { periodStart, money } = require('../lib/fixedAssets');

const router = express.Router();

// The fixed asset roll forward: beginning balance, additions, disposals, depreciation, ending
// balance, for a date range and broken down by asset class. This is the schedule auditors ask for,
// and the reason it is worth generating rather than assembling by hand is that all five columns
// have to reconcile -- beginning + additions - disposals = ending, for cost and for accumulated
// depreciation independently.
//
// Everything is derived from the same documents the general ledger reads, so the report and the
// Trial Balance cannot disagree: cost from asset_cost_lines, depreciation from posted runs,
// disposals from posted disposal documents.
const ROUTE = '/reports/fixed-asset-roll-forward';

function monthEnd(period) {
  const [y, m] = String(period).slice(0, 7).split('-').map(Number);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

router.get('/fixed-asset-roll-forward', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const fromPeriod = periodStart(req.query.from || new Date().toISOString().slice(0, 7));
    const toPeriod = periodStart(req.query.to || req.query.from || new Date().toISOString().slice(0, 7));
    if (toPeriod < fromPeriod) return res.status(400).json({ error: 'The end of the range is before its start.' });
    const fromDate = fromPeriod;          // first day of the opening month
    const toDate = monthEnd(toPeriod);    // last day of the closing month
    const classFilter = req.query.asset_class_id || null;

    const params = [];
    let classSql = '';
    if (classFilter) { classSql = 'AND a.asset_class_id = ?'; params.push(classFilter); }

    // COST -------------------------------------------------------------------------------------
    // Opening cost is everything capitalised before the window, less anything disposed of before
    // it. A cost line carries its own incurred date, which is what makes an improvement land in
    // the month it happened rather than the month the asset was bought.
    const [costRows] = await pool.query(
      `SELECT c.id AS class_id, c.name AS class_name,
              COALESCE(SUM(CASE WHEN cl.incurred_date < ? THEN cl.amount ELSE 0 END), 0) AS opening_cost,
              COALESCE(SUM(CASE WHEN cl.incurred_date >= ? AND cl.incurred_date <= ? THEN cl.amount ELSE 0 END), 0) AS additions
         FROM assets a
         JOIN asset_classes c ON c.id = a.asset_class_id
         JOIN asset_cost_lines cl ON cl.asset_id = a.id
        WHERE a.is_capitalized = TRUE ${classSql}
        GROUP BY c.id, c.name`,
      [fromDate, fromDate, toDate, ...params],
    );

    // DISPOSALS --------------------------------------------------------------------------------
    const [disposalRows] = await pool.query(
      `SELECT c.id AS class_id, c.name AS class_name,
              COALESCE(SUM(CASE WHEN d.disposal_date < ? THEN d.cost_at_disposal ELSE 0 END), 0) AS disposed_cost_before,
              COALESCE(SUM(CASE WHEN d.disposal_date >= ? AND d.disposal_date <= ? THEN d.cost_at_disposal ELSE 0 END), 0) AS disposed_cost,
              COALESCE(SUM(CASE WHEN d.disposal_date < ? THEN d.accumulated_at_disposal ELSE 0 END), 0) AS disposed_accum_before,
              COALESCE(SUM(CASE WHEN d.disposal_date >= ? AND d.disposal_date <= ? THEN d.accumulated_at_disposal ELSE 0 END), 0) AS disposed_accum,
              COALESCE(SUM(CASE WHEN d.disposal_date >= ? AND d.disposal_date <= ? THEN d.proceeds ELSE 0 END), 0) AS proceeds,
              COALESCE(SUM(CASE WHEN d.disposal_date >= ? AND d.disposal_date <= ? THEN d.gain_loss ELSE 0 END), 0) AS gain_loss,
              SUM(CASE WHEN d.disposal_date >= ? AND d.disposal_date <= ? THEN 1 ELSE 0 END) AS disposal_count
         FROM asset_disposals d
         JOIN assets a ON a.id = d.asset_id
         JOIN asset_classes c ON c.id = a.asset_class_id
        WHERE d.status = 'posted' ${classSql}
        GROUP BY c.id, c.name`,
      [fromDate, fromDate, toDate, fromDate, fromDate, toDate, fromDate, toDate, fromDate, toDate, fromDate, toDate, ...params],
    );

    // DEPRECIATION -----------------------------------------------------------------------------
    const [depRows] = await pool.query(
      `SELECT c.id AS class_id, c.name AS class_name,
              COALESCE(SUM(CASE WHEN r.period_month < ? THEN l.amount ELSE 0 END), 0) AS opening_accum,
              COALESCE(SUM(CASE WHEN r.period_month >= ? AND r.period_month <= ? THEN l.amount ELSE 0 END), 0) AS depreciation
         FROM asset_depreciation_lines l
         JOIN asset_depreciation_runs r ON r.id = l.run_id
         JOIN assets a ON a.id = l.asset_id
         JOIN asset_classes c ON c.id = a.asset_class_id
        WHERE r.status = 'posted' ${classSql}
        GROUP BY c.id, c.name`,
      [fromPeriod, fromPeriod, toPeriod, ...params],
    );

    // Assemble one row per class that appears anywhere.
    const byClass = new Map();
    const ensure = (id, name) => {
      if (!byClass.has(id)) {
        byClass.set(id, {
          class_id: id, class_name: name,
          opening_cost: 0, additions: 0, disposed_cost: 0, ending_cost: 0,
          opening_accumulated: 0, depreciation: 0, disposed_accumulated: 0, ending_accumulated: 0,
          opening_nbv: 0, ending_nbv: 0, proceeds: 0, gain_loss: 0, disposal_count: 0,
        });
      }
      return byClass.get(id);
    };

    for (const r of costRows) {
      const g = ensure(r.class_id, r.class_name);
      g.opening_cost = money(r.opening_cost);
      g.additions = money(r.additions);
    }
    for (const r of disposalRows) {
      const g = ensure(r.class_id, r.class_name);
      // Cost disposed of BEFORE the window has already left the balance, so it reduces the opening.
      g.opening_cost = money(g.opening_cost - Number(r.disposed_cost_before));
      g.disposed_cost = money(r.disposed_cost);
      g.opening_accumulated = money(g.opening_accumulated - Number(r.disposed_accum_before));
      g.disposed_accumulated = money(r.disposed_accum);
      g.proceeds = money(r.proceeds);
      g.gain_loss = money(r.gain_loss);
      g.disposal_count = Number(r.disposal_count) || 0;
    }
    for (const r of depRows) {
      const g = ensure(r.class_id, r.class_name);
      g.opening_accumulated = money(g.opening_accumulated + Number(r.opening_accum));
      g.depreciation = money(r.depreciation);
    }

    const rows = [...byClass.values()].map((g) => {
      g.ending_cost = money(g.opening_cost + g.additions - g.disposed_cost);
      g.ending_accumulated = money(g.opening_accumulated + g.depreciation - g.disposed_accumulated);
      g.opening_nbv = money(g.opening_cost - g.opening_accumulated);
      g.ending_nbv = money(g.ending_cost - g.ending_accumulated);
      return g;
    }).sort((a, b) => a.class_name.localeCompare(b.class_name));

    const totals = rows.reduce((t, g) => {
      for (const k of ['opening_cost', 'additions', 'disposed_cost', 'ending_cost', 'opening_accumulated',
        'depreciation', 'disposed_accumulated', 'ending_accumulated', 'opening_nbv', 'ending_nbv',
        'proceeds', 'gain_loss', 'disposal_count']) {
        t[k] = money((t[k] || 0) + g[k]);
      }
      return t;
    }, {});

    res.json({ from: fromPeriod, to: toPeriod, from_date: fromDate, to_date: toDate, rows, totals });
  } catch (err) { next(err); }
});

// The per-asset detail behind one class on the roll forward, so a figure can be traced to the
// machines that produced it rather than taken on trust.
router.get('/fixed-asset-detail', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const toPeriod = periodStart(req.query.to || new Date().toISOString().slice(0, 7));
    const params = [toPeriod];
    let classSql = '';
    if (req.query.asset_class_id) { classSql = 'AND a.asset_class_id = ?'; params.push(req.query.asset_class_id); }

    const [rows] = await pool.query(
      `SELECT a.id, a.reference_no, a.in_service_date, a.useful_life_months, a.salvage_value,
              ai.display_name AS item_name, c.name AS class_name,
              (SELECT COALESCE(SUM(cl.amount), 0) FROM asset_cost_lines cl WHERE cl.asset_id = a.id) AS cost,
              (SELECT COALESCE(SUM(l.amount), 0) FROM asset_depreciation_lines l
                 JOIN asset_depreciation_runs r ON r.id = l.run_id
                WHERE l.asset_id = a.id AND r.status = 'posted' AND r.period_month <= ?) AS accumulated,
              d.disposal_no, d.disposal_date
         FROM assets a
         JOIN asset_classes c ON c.id = a.asset_class_id
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN asset_disposals d ON d.asset_id = a.id AND d.status = 'posted'
        WHERE a.is_capitalized = TRUE ${classSql}
        ORDER BY c.name, ai.display_name, a.reference_no`,
      params,
    );
    res.json(rows.map((r) => ({
      ...r,
      cost: money(r.cost),
      accumulated: money(r.accumulated),
      net_book_value: money(Number(r.cost) - Number(r.accumulated)),
    })));
  } catch (err) { next(err); }
});

module.exports = router;
