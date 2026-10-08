const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { deriveOnHand } = require('../lib/stockLedger');
const { normalisePoStatus, isApproved } = require('../lib/poStatus');

const router = express.Router();
const ROUTE = '/purchasing/replenishment';

// Purchasing > Inventory Replenishment -- the Purchasing Supervisor's list of stocked items to buy.
//
// Only INVENTORY-type items: those are the ones the company keeps on the shelf. A JIT (just in
// time) item is bought for the job that needs it and never stocked, so it has no replenishment to
// plan; Non-Inventory, Service and the rest hold no stock at all.
//
// For each INVENTORY item, all in its BASE unit:
//   Required   what the job orders in production still need of it -- each process line's material
//              total less what has already been completed against it, on job orders Pending for
//              Scheduling, In Process or Partially Completed (not cancelled). Same figure the
//              Production screen's Back Order is worked from.
//   On Hand    the stock ledger's balance across every warehouse (lib/stockLedger.js deriveOnHand,
//              the Bin Card's closing balance).
//   On Order   what approved purchase orders have not delivered yet (qty less received, scaled from
//              the purchase unit by the item's conversion factor). Orders still awaiting approval
//              are shown beside it but not counted -- they may yet be refused.
//   To Order   Required + Reorder Point - On Hand - On Order. Listed when above zero.
const DEMAND_STAGES = ['pending_for_scheduling', 'in_process', 'partially_completed'];

// Two guards on what counts as demand, because the job order data carries both of these:
//
//   * A WINDOW on the sales order's date (default 120 days, ?days=0 for all). Job orders the
//     source never closed sit "In Process" for years -- 2021-2023 ones included -- and would
//     have the supervisor buying for jobs long finished. The sales order's date, not
//     job_orders.created_at: imported job orders carry the day they were imported there.
//   * A material total of 100,000,000 or more is a placeholder, not a quantity (one line carries
//     1,000,000,000 SQFT), and is left out; the count of such lines is returned so it is visible.
//     (repair-backfilled-jo-totals.js fixes the larger problem of peso amounts stored as totals.)
const DEFAULT_DAYS = 120;
const PLACEHOLDER_TOTAL = 100000000;
function demandScope(days) {
  const where = [
    "jo.production_stage IN (?)",
    "LOWER(COALESCE(jo.status, '')) NOT LIKE '%cancel%'",
    `COALESCE(jop.total, 0) < ${PLACEHOLDER_TOTAL}`,
  ];
  const params = [DEMAND_STAGES];
  if (days > 0) {
    where.push('COALESCE(so.date_created, DATE(jo.created_at)) >= CURDATE() - INTERVAL ? DAY');
    params.push(days);
  }
  return { where: where.join(' AND '), params };
}
const daysOf = (q) => (q.days === undefined || q.days === '' ? DEFAULT_DAYS : Math.max(0, Number(q.days) || 0));

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const showAll = req.query.all === '1';
    const days = daysOf(req.query);
    const scope = demandScope(days);

    const [demandRows] = await pool.query(
      `SELECT jop.item_id,
              SUM(GREATEST(COALESCE(jop.total, 0) - COALESCE(jop.total_completed, 0), 0)) AS required,
              COUNT(DISTINCT jo.id) AS jo_count
         FROM job_order_processes jop
         JOIN job_orders jo ON jo.id = jop.job_order_id
         JOIN inventories i ON i.id = jop.item_id
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
        WHERE i.item_type = 'INVENTORY' AND ${scope.where}
        GROUP BY jop.item_id`,
      scope.params
    );
    const [[{ n: placeholders }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM job_order_processes jop
         JOIN job_orders jo ON jo.id = jop.job_order_id
         JOIN inventories i ON i.id = jop.item_id
        WHERE i.item_type = 'INVENTORY' AND jo.production_stage IN (?) AND jop.total >= ?`,
      [DEMAND_STAGES, PLACEHOLDER_TOTAL]
    );
    const demand = new Map(demandRows.filter((d) => Number(d.required) > 0).map((d) => [Number(d.item_id), d]));

    // Items in play: anything production still needs, plus anything with a reorder point to keep up.
    const [items] = await pool.query(
      `SELECT i.id, i.item_code, i.display_name, i.reorder_point, i.conversion_factor,
              c.name AS category_name, bu.code AS base_unit, pu.code AS purchase_unit
         FROM inventories i
         LEFT JOIN inventory_categories c ON c.id = i.category_id
         LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
         LEFT JOIN units_of_measure pu ON pu.id = i.purchase_unit_id
        WHERE i.item_type = 'INVENTORY' AND i.is_active = 1
          AND (i.reorder_point > 0 ${demand.size ? 'OR i.id IN (?)' : ''})`,
      demand.size ? [[...demand.keys()]] : []
    );
    const meta = { stages: DEMAND_STAGES, days, placeholders_excluded: Number(placeholders) };
    if (!items.length) return res.json({ rows: [], ...meta });
    const ids = items.map((i) => i.id);

    const [onHandMap, [poLines]] = await Promise.all([
      deriveOnHand(pool, ids),
      pool.query(
        `SELECT pol.item_id, pol.qty, pol.received_qty, po.status
           FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
          WHERE pol.item_id IN (?) AND pol.qty > COALESCE(pol.received_qty, 0)`,
        [ids]
      ),
    ]);

    const onHand = new Map();
    for (const [pair, bal] of onHandMap) {
      const itemId = Number(pair.slice(0, pair.indexOf('|')));
      onHand.set(itemId, (onHand.get(itemId) || 0) + Number(bal || 0));
    }
    const onOrder = new Map();
    const pendingApproval = new Map();
    const factorOf = new Map(items.map((i) => [i.id, Number(i.conversion_factor) > 0 ? Number(i.conversion_factor) : 1]));
    for (const l of poLines) {
      const st = normalisePoStatus(l.status);
      if (st === 'cancelled' || st === 'fully_received') continue;
      const open = (Number(l.qty) - Number(l.received_qty || 0)) * (factorOf.get(Number(l.item_id)) || 1);
      const target = isApproved(l.status) ? onOrder : (['pending_approval', 'pending_approval_gm'].includes(st) ? pendingApproval : null);
      if (target) target.set(Number(l.item_id), (target.get(Number(l.item_id)) || 0) + open);
    }

    const r4 = (v) => Number(Number(v || 0).toFixed(4));
    const rows = items.map((i) => {
      const d = demand.get(i.id);
      const required = Number(d?.required || 0);
      const reorder = Number(i.reorder_point || 0);
      const have = onHand.get(i.id) || 0;
      const ordered = onOrder.get(i.id) || 0;
      const toOrder = required + reorder - have - ordered;
      const factor = factorOf.get(i.id);
      return {
        item_id: i.id, item_code: i.item_code, display_name: i.display_name, category_name: i.category_name,
        base_unit: i.base_unit, purchase_unit: i.purchase_unit || i.base_unit, conversion_factor: factor,
        required: r4(required), jo_count: Number(d?.jo_count || 0), reorder_point: r4(reorder),
        on_hand: r4(have), on_order: r4(ordered), pending_approval: r4(pendingApproval.get(i.id) || 0),
        to_order: r4(Math.max(toOrder, 0)),
        // In the unit it is bought in, rounded up -- a third of a roll is still a roll to order.
        to_order_purchase_unit: toOrder > 0 ? Math.ceil(r4(toOrder / factor)) : 0,
      };
    }).filter((r) => showAll || r.to_order > 0)
      .sort((a, b) => b.to_order - a.to_order || String(a.item_code).localeCompare(String(b.item_code)));

    res.json({ rows, ...meta });
  } catch (err) { next(err); }
});

// The job orders behind one item's Required figure, for the row's drill-down.
router.get('/:itemId/job-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scope = demandScope(daysOf(req.query));
    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.production_stage, jo.delivery_date, loc.location_name, so.date_created AS so_date,
              SUM(GREATEST(COALESCE(jop.total, 0) - COALESCE(jop.total_completed, 0), 0)) AS required
         FROM job_order_processes jop
         JOIN job_orders jo ON jo.id = jop.job_order_id
         LEFT JOIN locations loc ON loc.id = COALESCE(jop.location_id, jo.job_location_id)
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
        WHERE jop.item_id = ? AND ${scope.where}
        GROUP BY jo.id, loc.location_name, so.date_created
       HAVING required > 0
        ORDER BY jo.delivery_date IS NULL, jo.delivery_date, jo.id`,
      [req.params.itemId, ...scope.params]
    );
    res.json(rows.map((r) => ({ ...r, required: Number(Number(r.required).toFixed(4)) })));
  } catch (err) { next(err); }
});

module.exports = router;
