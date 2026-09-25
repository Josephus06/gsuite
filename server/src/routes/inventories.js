const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { deriveOnHand, movementsSql } = require('../lib/stockLedger');

const router = express.Router();
const ROUTE = '/inventory';

const FIELDS = [
  'item_code', 'display_name', 'sales_description', 'category_id',
  'base_unit_id', 'item_type', 'reorder_point', 'is_active',
  'is_length_based', 'is_width_based', 'last_purchase_price', 'last_purchase_date',
  'average_cost', 'material_cost', 'price_indicator', 'tolerance_pct', 'wastage_allowance_pct', 'markup_pct',
  'selling_price', 'beg_selling_price', 'disc_ceiling_pct', 'disc_supervisor_pct',
  'disc_manager_pct', 'disc_gm_pct',
  'purchase_description', 'purchase_unit_id', 'stock_unit_id', 'sales_unit_id',
  'conversion_factor', 'to_type', 'is_office_supply', 'is_to_item',
  'is_with_jo', 'is_po', 'is_jo',
  'expense_account_id', 'asset_account_id', 'income_account_id', 'cogs_account_id',
];

async function logAudit(conn, { inventoryId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Inventory', ?, ?, ?, ?, ?, ?)`,
    [inventoryId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Costing and Accounting approvals are independent -- a new item is pending both at
// once, so it can appear under BOTH the "For Approval Costing" and "For Approval
// Accounting" tabs simultaneously. Each tab's WHERE clause below reflects that (not a
// simple equality on a single status column).
const STATUS_FILTERS = {
  approved: 'i.is_active = 1 AND i.is_costing_approved = 1 AND i.is_accounting_approved = 1',
  for_approval_costing: 'i.is_active = 1 AND i.is_costing_approved = 0',
  for_approval_accounting: 'i.is_active = 1 AND i.is_accounting_approved = 0',
  inactive: 'i.is_active = 0',
};

// Plain array by default (kept stable for existing consumers that treat this endpoint
// as a flat item picker source: EstimateWizard, JobOrderEdit). Pass `?with_counts=1` to
// get `{ rows, counts }` instead, used by the Inventory list page's status tabs.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      status, search, with_counts: withCounts, item_type: itemType,
      include_jo_services: includeJoServices, include_inactive: includeInactive,
    } = req.query;

    const commonWhere = [];
    const commonParams = [];

    // RETIRED ITEMS ARE HIDDEN BY DEFAULT.
    //
    // This one endpoint is the item picker for every form in the build -- Estimate, Job Order,
    // Purchase Order, Purchase Requisition, Transfer Order, Inventory Adjustment, Landed Cost,
    // Job Type materials, Credit Memo, Delivery Ticket, Web Products. Marking an item inactive is
    // how the business says "stop using this", and until now it carried on being offered
    // everywhere, so the flag meant nothing outside the Inventory list's own tabs.
    //
    // Defaulting to hidden rather than adding an opt-in flag at each call site is deliberate: the
    // next form somebody builds gets the safe behaviour without having to know to ask for it.
    //
    // Two ways back in:
    //   ?status=...            the Inventory / Service Items / Non-Inventories tabs, whose filters
    //                          already pin is_active themselves (including the Inactive tab), so
    //                          this must not fight them.
    //   ?include_inactive=1    for reads of the past rather than data entry -- the Bin Card and
    //                          Stock Ledger pickers, where a discontinued item still has stock on
    //                          a shelf and a history worth reading.
    if (!status && includeInactive !== '1') commonWhere.push('i.is_active = 1');
    if (search) {
      commonWhere.push('(i.item_code LIKE ? OR i.display_name LIKE ? OR i.sales_description LIKE ?)');
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Default (no ?item_type=) returns only items that carry stock. Live keeps its item
    // master in five modules -- inventory, non-inventory, service, landed cost and discount --
    // and gives each its own page; they all live in this table here, told apart by item_type.
    // Only the inventory kinds belong in the Inventory Items list or the Stock Ledger's item
    // picker: a landed cost or a discount has no quantity to report on.
    //
    // This used to exclude 'Service' alone, which was enough while Service was the only
    // non-stock type present. Importing the other three modules (2,114 rows) made that
    // exclusion too narrow and they started appearing in both places.
    //
    // Pass ?item_type=Service (or Non-Inventory / Landed Cost / Discount) to fetch one kind.
    //
    // ?include_jo_services=1 keeps that exclusion but lets back through the Service items that
    // are flagged JO on the Service Items master (is_jo -- 35 of the 100 Service items). Those
    // are the charges a job actually carries: SERVICE LABOR, Layout Fee, DESIGN-Build Up
    // Complicated, Clickbook Layout 20 Pages. They are picked on an Estimate or Job Order
    // process line exactly like a material is, even though they hold no stock -- so the forms
    // that build those lines ask for them, while the Inventory Items list, Bin Card and Stock
    // Ledger pickers do not, because a labour charge has no quantity to report on.
    const NON_STOCK_TYPES = "(i.item_type IS NULL OR i.item_type NOT IN ('Service', 'Non-Inventory', 'Landed Cost', 'Discount'))";
    if (itemType) {
      commonWhere.push('i.item_type = ?');
      commonParams.push(itemType);
    } else if (includeJoServices === '1') {
      commonWhere.push(`(${NON_STOCK_TYPES} OR (i.item_type = 'Service' AND i.is_jo = 1))`);
    } else {
      commonWhere.push(NON_STOCK_TYPES);
    }
    const where = [...commonWhere];
    if (status && STATUS_FILTERS[status]) { where.push(STATUS_FILTERS[status]); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // The stock / purchase / sales units and the expense account are joined here as well as on
    // the detail route, because the Non-Inventories list shows all four unit columns and the
    // expense account the way live's does.
    const baseFrom = `FROM inventories i
       LEFT JOIN inventory_categories c ON c.id = i.category_id
       LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
       LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
       LEFT JOIN units_of_measure pu ON pu.id = i.purchase_unit_id
       LEFT JOIN units_of_measure slu ON slu.id = i.sales_unit_id
       LEFT JOIN chart_of_accounts ea ON ea.id = i.expense_account_id`;

    const [rows] = await pool.query(
      `SELECT i.*, c.name AS category_name, u.code AS base_unit_code, u.title AS base_unit_title,
              su.code AS stock_unit_code, pu.code AS purchase_unit_code, slu.code AS sales_unit_code,
              -- The purchase unit's TITLE as well as its code. Forms that record what a quantity
              -- was ordered in store the title ('Square Foot', 'Piece'), and without this the
              -- Purchase Requisition had only the base unit's title to fall back on.
              pu.title AS purchase_unit_title, su.title AS stock_unit_title,
              ea.account_name AS expense_account_name,
              COALESCE((SELECT SUM(il.qty_on_hand) FROM inventory_locations il WHERE il.inventory_id = i.id), 0) AS total_qty_on_hand
       ${baseFrom} ${whereSql}
       ORDER BY i.id DESC`,
      commonParams
    );

    if (!withCounts) return res.json(rows);

    const counts = {};
    for (const key of Object.keys(STATUS_FILTERS)) {
      const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count ${baseFrom} WHERE ${STATUS_FILTERS[key]}${commonWhere.length ? ` AND ${commonWhere.join(' AND ')}` : ''}`,
        commonParams
      );
      counts[key] = count;
    }

    res.json({ rows, counts });
  } catch (err) {
    next(err);
  }
});

// Closing balances for a HANDFUL of items at one location, for an Item picker to show while
// somebody is choosing what to add to a document or report on.
//
// Item ids are required and capped, deliberately. deriveOnHand sums the whole movement union, and
// asking it for all 6,547 items takes 15 seconds -- far too slow to sit in front of a page load.
// For the ten rows the picker actually has on screen it is about 40ms, so the picker asks per page
// as the user turns through it.
//
// Same helper the Reallocate screen and Production use, and it agrees with this report's own
// closing balance to the fourth decimal -- verified against SIGN-ACRYLIC-CLEAR at Warehouse -
// Central, 674.7119 from both. A second way of computing "what is on the shelf" would be free to
// disagree with the report it sits next to.
//
// Lives here rather than under the Bin Card because the Purchase Requisition picker wants the same
// figures, and its users have no reason to hold Bin Card permission. Anyone who can open an item
// picker can already read /inventory.
router.get('/balances', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const ids = String(req.query.item_ids || '').split(',')
      .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
    if (!ids.length) return res.json([]);

    // No location means the whole company, matching what the report itself does when its Location
    // is left empty.
    const locationId = Number(req.query.location_id) || null;

    const [items] = await pool.query(
      `SELECT i.id, i.conversion_factor, bu.title AS base_unit_title, su.title AS stock_unit_title
         FROM inventories i
         LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
         LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
        WHERE i.id IN (?)`,
      [ids],
    );

    const byPair = await deriveOnHand(pool, ids);
    const totalFor = (itemId) => {
      if (locationId) return Number(byPair.get(`${itemId}|${locationId}`) || 0);
      let sum = 0;
      for (const [pair, bal] of byPair) {
        if (pair.slice(0, pair.indexOf('|')) === String(itemId)) sum += Number(bal) || 0;
      }
      return sum;
    };

    res.json(items.map((i) => {
      const base = totalFor(i.id);
      const factor = Number(i.conversion_factor) > 0 ? Number(i.conversion_factor) : 1;
      return {
        item_id: i.id,
        balance_base: base,
        balance_stock: base / factor,
        base_unit_title: i.base_unit_title,
        stock_unit_title: i.stock_unit_title,
      };
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[item]] = await pool.query(
      `SELECT i.*, c.name AS category_name,
              bu.code AS base_unit_code, bu.title AS base_unit_title,
              pu.code AS purchase_unit_code, pu.title AS purchase_unit_title,
              su.code AS stock_unit_code, su.title AS stock_unit_title,
              slu.code AS sales_unit_code, slu.title AS sales_unit_title,
              ea.account_code AS expense_account_code, ea.account_name AS expense_account_name,
              aa.account_code AS asset_account_code, aa.account_name AS asset_account_name,
              ia.account_code AS income_account_code, ia.account_name AS income_account_name,
              ca.account_code AS cogs_account_code, ca.account_name AS cogs_account_name,
              cu.display_name AS costing_approved_by_name, au.display_name AS accounting_approved_by_name
       FROM inventories i
       LEFT JOIN inventory_categories c ON c.id = i.category_id
       LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
       LEFT JOIN units_of_measure pu ON pu.id = i.purchase_unit_id
       LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
       LEFT JOIN units_of_measure slu ON slu.id = i.sales_unit_id
       LEFT JOIN chart_of_accounts ea ON ea.id = i.expense_account_id
       LEFT JOIN chart_of_accounts aa ON aa.id = i.asset_account_id
       LEFT JOIN chart_of_accounts ia ON ia.id = i.income_account_id
       LEFT JOIN chart_of_accounts ca ON ca.id = i.cogs_account_id
       LEFT JOIN users cu ON cu.id = i.costing_approved_by
       LEFT JOIN users au ON au.id = i.accounting_approved_by
       WHERE i.id = ?`,
      [req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Not found' });

    const [priceTiers] = await pool.query('SELECT * FROM inventory_price_tiers WHERE inventory_id = ? ORDER BY min_qty', [req.params.id]);
    const [stock] = await pool.query(
      `SELECT il.*, l.location_name FROM inventory_locations il
       JOIN locations l ON l.id = il.location_id
       WHERE il.inventory_id = ? ORDER BY l.location_name`,
      [req.params.id]
    );
    // Warehouse Stocks: every location this item has ever moved through, with its on-hand as the
    // stock ledger's running total -- the Bin Card's closing balance and Production's On Hand,
    // because it is the same deriveOnHand. Not inventory_locations, which the migration never filled
    // and transfers write unscaled (lib/stockLedger.js). A location that used the item and is now
    // empty still shows, at zero. Committed / In Transit are read from the snapshot where it has a
    // row, since the ledger records movements, not reservations. `stock` is left as it was: the
    // edit screen reads it.
    const onHand = await deriveOnHand(pool, [Number(req.params.id)]);
    const locIds = [...onHand.keys()].map((k) => Number(k.split('|')[1]));
    const snapByLoc = new Map(stock.map((s) => [Number(s.location_id), s]));
    const [locRows] = locIds.length
      ? await pool.query('SELECT id, location_name FROM locations WHERE id IN (?)', [locIds])
      : [[]];
    const locName = new Map(locRows.map((l) => [Number(l.id), l.location_name]));
    const conv = Number(item.conversion_factor) || 1;
    const stockByLocation = locIds.map((locId) => {
      const base = Number(onHand.get(`${req.params.id}|${locId}`) || 0);
      const snap = snapByLoc.get(locId);
      return {
        location_id: locId,
        location_name: locName.get(locId) || `Location #${locId}`,
        qty_on_hand: Number(base.toFixed(4)),
        // The same balance in the Stock Unit (rolls, sheets), where the item has one.
        qty_on_hand_stock_unit: conv > 1 ? Number((base / conv).toFixed(4)) : null,
        qty_committed: Number(snap?.qty_committed || 0),
        qty_in_transit: Number(snap?.qty_in_transit || 0),
      };
    }).sort((a, b) => a.location_name.localeCompare(b.location_name));

    const [supplierPrices] = await pool.query(
      `SELECT isp.*, s.name AS supplier_name
       FROM inventory_supplier_prices isp
       JOIN suppliers s ON s.id = isp.supplier_id
       WHERE isp.inventory_id = ? ORDER BY isp.last_purchase_date DESC, isp.id DESC`,
      [req.params.id]
    );
    const [subItems] = await pool.query(
      `SELECT isi.*, ci.item_code, ci.display_name, ci.sales_description
       FROM inventory_sub_items isi
       JOIN inventories ci ON ci.id = isi.child_inventory_id
       WHERE isi.parent_inventory_id = ? ORDER BY isi.id`,
      [req.params.id]
    );
    const [[subItemOf]] = await pool.query(
      `SELECT isi.parent_inventory_id, pi.item_code, pi.display_name
       FROM inventory_sub_items isi
       JOIN inventories pi ON pi.id = isi.parent_inventory_id
       WHERE isi.child_inventory_id = ? LIMIT 1`,
      [req.params.id]
    );
    const [unitOfMeasures] = await pool.query(
      'SELECT * FROM inventory_unit_of_measures WHERE inventory_id = ? ORDER BY id',
      [req.params.id]
    );

    res.json({ ...item, priceTiers, stock, stock_by_location: stockByLocation, supplierPrices, subItems, subItemOf: subItemOf || null, unitOfMeasures });
  } catch (err) {
    next(err);
  }
});

// Every transaction this item appears on, newest first: the stock ledger's movements (Receiving
// Report, Vendor Return, Item Fulfillment, Item Receipt, Assembly Build, approved Inventory
// Adjustment -- lib/stockLedger.js, so In/Out match the Bin Card exactly, in Base Unit), plus the
// two documents that ask for stock without moving it: Purchase Orders and Transfer Orders, shown
// with their own quantity and unit and no In/Out. `type` narrows to one kind; paged because a
// common material has thousands of rows.
const TXN_TYPES = ['Receiving Report', 'Vendor Return', 'Item Fulfillment', 'Item Receipt', 'Assembly Build',
  'Inventory Adjustment', 'Purchase Order', 'Transfer Order'];
router.get('/:id/transactions', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 25));
    const type = TXN_TYPES.includes(req.query.type) ? req.query.type : null;
    const ids = [id];
    const union = `
      SELECT m.trans_date, m.trans_no, m.trans_type, m.ref_no, m.sort_id AS doc_id,
             m.from_location_name, m.to_location_name, m.qty_in, m.qty_out,
             NULL AS doc_qty, m.doc_uom, NULL AS status, m.sort_ts
        FROM (${movementsSql(true)}) m
      UNION ALL
      SELECT po.date_created, po.po_no, 'Purchase Order', NULL, po.id,
             NULL, loc.location_name, NULL, NULL,
             pol.qty, COALESCE(pol.unit_title, pol.purchase_unit), po.status, po.created_at
        FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id = pol.purchase_order_id
        LEFT JOIN locations loc ON loc.id = pol.location_id
       WHERE pol.item_id = ?
      UNION ALL
      SELECT t.date_created, t.to_no, 'Transfer Order', NULL, t.id,
             wl.location_name, tl.location_name, NULL, NULL,
             tol.qty, COALESCE(NULLIF(tol.unit, ''), tol.uom), t.status, t.created_at
        FROM transfer_order_lines tol
        JOIN transfer_orders t ON t.id = tol.transfer_order_id
        LEFT JOIN locations wl ON wl.id = t.withdraw_from_location_id
        LEFT JOIN locations tl ON tl.id = t.transfer_to_location_id
       WHERE tol.item_id = ?`;
    const params = [ids, ids, ids, ids, ids, ids, id, id];
    const filter = type ? 'WHERE x.trans_type = ?' : '';
    const fParams = type ? [type] : [];

    // The counts and the page are independent, so they run side by side: on the heaviest item in
    // the catalogue (a service line on ~190k Assembly Build lines) that halves the wait.
    const [[counts], [rows]] = await Promise.all([
      pool.query(`SELECT x.trans_type, COUNT(*) AS n FROM (${union}) x GROUP BY x.trans_type`, params),
      pool.query(
        `SELECT * FROM (${union}) x ${filter}
          ORDER BY x.trans_date DESC, x.sort_ts DESC, x.trans_no DESC
          LIMIT ? OFFSET ?`,
        [...params, ...fParams, pageSize, (page - 1) * pageSize],
      ),
    ]);
    const total = counts.filter((c) => !type || c.trans_type === type).reduce((s, c) => s + Number(c.n), 0);
    res.json({
      rows, total, page, page_size: pageSize,
      counts: Object.fromEntries(counts.map((c) => [c.trans_type, Number(c.n)])),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'Inventory' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// New items always start pending both approvals -- is_costing_approved/
// is_accounting_approved are never accepted from the client here.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const body = { ...req.body };
    const values = FIELDS.map((f) => (body[f] === undefined ? null : body[f]));
    const [result] = await pool.query(
      `INSERT INTO inventories (${FIELDS.join(', ')}, is_costing_approved, is_accounting_approved) VALUES (${FIELDS.map(() => '?').join(', ')}, FALSE, FALSE)`,
      values
    );
    const [[row]] = await pool.query('SELECT * FROM inventories WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Item code already in use' });
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[before]] = await pool.query('SELECT id FROM inventories WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const body = { ...req.body };
    const values = FIELDS.map((f) => (body[f] === undefined ? null : body[f]));

    await pool.query(
      `UPDATE inventories SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );

    const [[row]] = await pool.query('SELECT * FROM inventories WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Costing can only be approved once Sales/Pricing has actually been filled in.
router.put('/:id/approve-costing', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[item]] = await conn.query('SELECT * FROM inventories WHERE id = ?', [req.params.id]);
    if (!item) { conn.release(); return res.status(404).json({ error: 'Not found' }); }
    if (item.is_costing_approved) { conn.release(); return res.status(400).json({ error: 'Costing is already approved.' }); }
    if (item.selling_price === null || item.selling_price === undefined || Number(item.selling_price) <= 0) {
      conn.release();
      return res.status(400).json({ error: 'Sales/Pricing must be filled in (Selling Price) before costing can be approved.' });
    }

    await conn.beginTransaction();
    await conn.query(
      'UPDATE inventories SET is_costing_approved = TRUE, costing_approved_at = NOW(), costing_approved_by = ? WHERE id = ?',
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { inventoryId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'is_costing_approved', oldValue: '0', newValue: '1' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventories WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Accounting can only be approved once all three chart-of-accounts links are set.
router.put('/:id/approve-accounting', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[item]] = await conn.query('SELECT * FROM inventories WHERE id = ?', [req.params.id]);
    if (!item) { conn.release(); return res.status(404).json({ error: 'Not found' }); }
    if (item.is_accounting_approved) { conn.release(); return res.status(400).json({ error: 'Accounting is already approved.' }); }
    // Expense is commonly left blank even on real Approved items -- Asset/COGS/Income
    // are the three that actually gate approval (see schema.sql's cogs_account_id note).
    if (!item.asset_account_id || !item.cogs_account_id || !item.income_account_id) {
      conn.release();
      return res.status(400).json({ error: 'Asset, COGS, and Income accounts must all be set before accounting can be approved.' });
    }

    await conn.beginTransaction();
    await conn.query(
      'UPDATE inventories SET is_accounting_approved = TRUE, accounting_approved_at = NOW(), accounting_approved_by = ? WHERE id = ?',
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { inventoryId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'is_accounting_approved', oldValue: '0', newValue: '1' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventories WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM inventory_price_tiers WHERE inventory_id = ?', [req.params.id]);
    await conn.query('DELETE FROM inventory_locations WHERE inventory_id = ?', [req.params.id]);
    await conn.query('DELETE FROM inventory_supplier_prices WHERE inventory_id = ?', [req.params.id]);
    await conn.query('DELETE FROM inventory_sub_items WHERE parent_inventory_id = ? OR child_inventory_id = ?', [req.params.id, req.params.id]);
    await conn.query('DELETE FROM inventories WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This item is referenced by other data and cannot be deleted.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

router.post('/:id/price-tiers', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { min_qty, max_qty, unit_price } = req.body;
    const [result] = await pool.query(
      `INSERT INTO inventory_price_tiers (inventory_id, min_qty, max_qty, unit_price) VALUES (?, ?, ?, ?)`,
      [req.params.id, min_qty, max_qty || null, unit_price]
    );
    const [[row]] = await pool.query('SELECT * FROM inventory_price_tiers WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/price-tiers/:tierId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM inventory_price_tiers WHERE id = ? AND inventory_id = ?', [req.params.tierId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.put('/:id/stock/:locationId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { qty_on_hand, qty_committed, qty_in_transit } = req.body;
    await pool.query(
      `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand, qty_committed, qty_in_transit)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE qty_on_hand = VALUES(qty_on_hand), qty_committed = VALUES(qty_committed), qty_in_transit = VALUES(qty_in_transit)`,
      [req.params.id, req.params.locationId, qty_on_hand || 0, qty_committed || 0, qty_in_transit || 0]
    );
    const [[row]] = await pool.query(
      'SELECT * FROM inventory_locations WHERE inventory_id = ? AND location_id = ?',
      [req.params.id, req.params.locationId]
    );
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/supplier-prices', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { supplier_id, price, last_purchase_date, ref_no } = req.body;
    const [result] = await pool.query(
      `INSERT INTO inventory_supplier_prices (inventory_id, supplier_id, price, last_purchase_date, ref_no) VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, supplier_id, price, last_purchase_date || null, ref_no || null]
    );
    const [[row]] = await pool.query(
      `SELECT isp.*, s.name AS supplier_name FROM inventory_supplier_prices isp
       JOIN suppliers s ON s.id = isp.supplier_id WHERE isp.id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/supplier-prices/:priceId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM inventory_supplier_prices WHERE id = ? AND inventory_id = ?', [req.params.priceId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/sub-items', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { child_inventory_id, qty } = req.body;
    if (Number(child_inventory_id) === Number(req.params.id)) {
      return res.status(400).json({ error: 'An item cannot be a sub-item of itself.' });
    }
    const [result] = await pool.query(
      `INSERT INTO inventory_sub_items (parent_inventory_id, child_inventory_id, qty) VALUES (?, ?, ?)`,
      [req.params.id, child_inventory_id, qty || 1]
    );
    const [[row]] = await pool.query(
      `SELECT isi.*, ci.item_code, ci.display_name, ci.sales_description
       FROM inventory_sub_items isi JOIN inventories ci ON ci.id = isi.child_inventory_id WHERE isi.id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/sub-items/:subItemId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM inventory_sub_items WHERE id = ? AND parent_inventory_id = ?', [req.params.subItemId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Lightweight endpoint for the Estimate wizard's per-process-line Unit dropdown -- fetches
// just this item's usable unit codes, not the full inventory record (priceTiers/stock/
// supplierPrices/subItems the GET /:id route also returns, none of which the wizard needs).
router.get('/:id/unit-of-measures', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM inventory_unit_of_measures WHERE inventory_id = ? ORDER BY id', [req.params.id]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/unit-of-measures', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    const [result] = await pool.query(
      'INSERT INTO inventory_unit_of_measures (inventory_id, code) VALUES (?, ?)',
      [req.params.id, code]
    );
    const [[row]] = await pool.query('SELECT * FROM inventory_unit_of_measures WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/unit-of-measures/:uomId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM inventory_unit_of_measures WHERE id = ? AND inventory_id = ?', [req.params.uomId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
