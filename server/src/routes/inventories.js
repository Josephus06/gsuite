const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

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
    const { status, search, with_counts: withCounts, item_type: itemType } = req.query;

    const commonWhere = [];
    const commonParams = [];
    if (search) {
      commonWhere.push('(i.item_code LIKE ? OR i.display_name LIKE ? OR i.sales_description LIKE ?)');
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Default (no ?item_type=) excludes Service Items -- they get their own Master
    // Lists > Service Items page. Pass ?item_type=Service to fetch just those instead.
    if (itemType) {
      commonWhere.push('i.item_type = ?');
      commonParams.push(itemType);
    } else {
      commonWhere.push("(i.item_type IS NULL OR i.item_type != 'Service')");
    }
    const where = [...commonWhere];
    if (status && STATUS_FILTERS[status]) { where.push(STATUS_FILTERS[status]); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM inventories i
       LEFT JOIN inventory_categories c ON c.id = i.category_id
       LEFT JOIN units_of_measure u ON u.id = i.base_unit_id`;

    const [rows] = await pool.query(
      `SELECT i.*, c.name AS category_name, u.code AS base_unit_code, u.title AS base_unit_title,
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

    res.json({ ...item, priceTiers, stock, supplierPrices, subItems, subItemOf: subItemOf || null, unitOfMeasures });
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
