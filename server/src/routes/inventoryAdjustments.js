const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/inventory-adjustments';

const STATUS_VALUES = ['pending_approval', 'approved', 'cancelled'];

// Shared line-row select: UOM reflects whichever unit is toggled (Stock Unit / Base
// Unit) via unit_used, falling back to Base Unit if the item has no Stock Unit set.
// est_unit_cost (== inventories.average_cost) is priced per Stock/Purchase Unit (e.g.
// pesos per ROLL, matching how Purchase Order Rate is entered) -- est_unit_cost_base
// divides that down by the item's conversion_factor to get the per-Base-Unit price
// (pesos per SQFT), for display next to Qty on Hand/New Qty which are always Base Unit.
const LINE_SELECT = `
  SELECT l.*, i.item_code, i.display_name AS item_name, i.asset_account_id,
         CASE WHEN l.unit_used = 'base' THEN bu.title ELSE COALESCE(su.title, bu.title) END AS uom_title,
         l.est_unit_cost / COALESCE(NULLIF(i.conversion_factor, 0), 1) AS est_unit_cost_base,
         loc.location_name, d.name AS department_name
  FROM inventory_adjustment_lines l
  LEFT JOIN inventories i ON i.id = l.item_id
  LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
  LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
  LEFT JOIN locations loc ON loc.id = l.location_id
  LEFT JOIN departments d ON d.id = l.department_id
`;

// GL Impact: the adjustment-account leg (credited on an increase, debited on a
// decrease) was already correct -- this adds the missing counter-leg, each line's own
// item asset account, for the opposite direction and the same amount (new_qty -
// qty_on_hand, in Base Unit, times the per-Base-Unit cost -- the exact figure
// `recomputeTotal` already sums into `estimated_total_value`, so this always ties out
// to the header total exactly). Real system's sandbox confirms this asset/adjustment-
// account pairing (IA-330: Dr Raw Materials Inventory - Dpod 142.50 / Cr Direct
// Materials 142.50 for a +150 qty increase) -- direction here matches that example.
async function computeGlImpact(adj, lines) {
  if (!adj.adjustment_account_id || !adj.adjustment_account_code) return [];

  const itemAccountAmounts = new Map(); // account_id -> signed amount (positive = qty increase)
  let adjustmentTotal = 0;
  for (const l of lines) {
    const amount = (Number(l.new_qty) - Number(l.qty_on_hand)) * Number(l.est_unit_cost_base || 0);
    if (!amount || !l.asset_account_id) continue;
    itemAccountAmounts.set(l.asset_account_id, (itemAccountAmounts.get(l.asset_account_id) || 0) + amount);
    adjustmentTotal += amount;
  }
  if (!itemAccountAmounts.size) return [];

  const [itemAccts] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [[...itemAccountAmounts.keys()]]);
  const rows = [];
  for (const acct of itemAccts) {
    const amount = Number((itemAccountAmounts.get(acct.id) || 0).toFixed(2));
    if (!amount) continue;
    rows.push({
      account_code: acct.account_code, account_name: acct.account_name,
      debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0,
    });
  }
  const total = Number(adjustmentTotal.toFixed(2));
  if (total) {
    rows.push({
      account_code: adj.adjustment_account_code, account_name: adj.adjustment_account_name,
      debit: total < 0 ? -total : 0, credit: total > 0 ? total : 0,
    });
  }
  return rows;
}

async function logAudit(conn, { adjustmentId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('InventoryAdjustment', ?, ?, ?, ?, ?, ?)`,
    [adjustmentId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const where = [];
    const params = [];
    if (status && STATUS_VALUES.includes(status)) { where.push('ia.status = ?'); params.push(status); }
    if (search) {
      where.push('(ia.adjustment_no LIKE ? OR ia.memo LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT ia.* FROM inventory_adjustments ia ${whereSql} ORDER BY ia.id DESC`,
      params
    );

    const [countRows] = await pool.query(
      'SELECT status, COUNT(*) AS count FROM inventory_adjustments GROUP BY status'
    );
    const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, counts });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[adj]] = await pool.query(
      `SELECT ia.*, coa.account_code AS adjustment_account_code, coa.account_name AS adjustment_account_name,
              CONCAT(cu.display_name) AS created_by_name, CONCAT(au.display_name) AS approved_by_name
       FROM inventory_adjustments ia
       LEFT JOIN chart_of_accounts coa ON coa.id = ia.adjustment_account_id
       LEFT JOIN users cu ON cu.id = ia.created_by_user_id
       LEFT JOIN users au ON au.id = ia.approved_by_user_id
       WHERE ia.id = ?`,
      [req.params.id]
    );
    if (!adj) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `${LINE_SELECT} WHERE l.inventory_adjustment_id = ? ORDER BY l.line_no`,
      [req.params.id]
    );
    const glImpact = adj.status === 'approved' ? await computeGlImpact(adj, lines) : [];

    res.json({ ...adj, gl_impact: glImpact, lines });
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
       WHERE a.auditable_type = 'InventoryAdjustment' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, adjustment_account_id: adjustmentAccountId, memo } = req.body;
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO inventory_adjustments (adjustment_no, date_created, adjustment_account_id, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), adjustmentAccountId || null, memo || null, req.user.id]
    );
    await conn.query('UPDATE inventory_adjustments SET adjustment_no = ? WHERE id = ?', [`IA-${result.insertId}`, result.insertId]);
    await logAudit(conn, { adjustmentId: result.insertId, userId: req.user.id, eventType: 'Created', fieldName: 'adjustment_no', newValue: `IA-${result.insertId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[adj]] = await pool.query('SELECT status FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) return res.status(404).json({ error: 'Not found' });
    if (adj.status !== 'pending_approval') {
      return res.status(409).json({ error: 'Only a Pending Approval adjustment can be edited.' });
    }
    const { date_created: dateCreated, adjustment_account_id: adjustmentAccountId, memo } = req.body;
    await pool.query(
      'UPDATE inventory_adjustments SET date_created = ?, adjustment_account_id = ?, memo = ?, updated_at = NOW() WHERE id = ?',
      [dateCreated, adjustmentAccountId || null, memo || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// (new_qty - qty_on_hand) is a Base Unit delta, but est_unit_cost is priced per
// Stock/Purchase Unit -- has to come down to a per-Base-Unit price (/ conversion_factor)
// before multiplying, same as est_unit_cost_base above.
async function recomputeTotal(conn, adjustmentId) {
  const [[{ total }]] = await conn.query(
    `SELECT COALESCE(SUM((l.new_qty - l.qty_on_hand) * (l.est_unit_cost / COALESCE(NULLIF(i.conversion_factor, 0), 1))), 0) AS total
     FROM inventory_adjustment_lines l
     LEFT JOIN inventories i ON i.id = l.item_id
     WHERE l.inventory_adjustment_id = ?`,
    [adjustmentId]
  );
  await conn.query('UPDATE inventory_adjustments SET estimated_total_value = ?, updated_at = NOW() WHERE id = ?', [total, adjustmentId]);
}

// Adding a line snapshots the item's current Qty on Hand / Value at that location --
// matching the real form's behavior of pulling live values in at add-time, not
// re-querying them live forever after.
router.post('/:id/lines', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    if (adj.status !== 'pending_approval') { return res.status(409).json({ error: 'Only a Pending Approval adjustment can be edited.' }); }

    const { item_id: itemId, location_id: locationId, department_id: departmentId, unit_used: unitUsed } = req.body;
    if (!itemId) { return res.status(400).json({ error: 'Item is required.' }); }

    await conn.beginTransaction();
    const [[item]] = await conn.query('SELECT average_cost, base_unit_id, conversion_factor FROM inventories i WHERE i.id = ?', [itemId]);
    const [[unit]] = await conn.query('SELECT title FROM units_of_measure WHERE id = ?', [item?.base_unit_id]);
    // average_cost is priced per Stock/Purchase Unit -- current_value has to multiply a
    // per-Base-Unit price against qtyOnHand (Base Unit), so divide it down first.
    const estUnitCost = Number(item?.average_cost || 0);
    const conversionFactor = Number(item?.conversion_factor) || 1;
    let qtyOnHand = 0;
    if (locationId) {
      const [[stock]] = await conn.query('SELECT qty_on_hand FROM inventory_locations WHERE inventory_id = ? AND location_id = ?', [itemId, locationId]);
      qtyOnHand = Number(stock?.qty_on_hand || 0);
    }

    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ?',
      [req.params.id]
    );
    const [result] = await conn.query(
      `INSERT INTO inventory_adjustment_lines
         (inventory_adjustment_id, line_no, item_id, location_id, department_id, qty_on_hand, unit, unit_used, current_value, adjust_qty_by, new_qty, est_unit_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [req.params.id, nextLine, itemId, locationId || null, departmentId || null, qtyOnHand, unit?.title || null, unitUsed === 'base' ? 'base' : 'stock', qtyOnHand * (estUnitCost / conversionFactor), qtyOnHand, estUnitCost]
    );
    await recomputeTotal(conn, req.params.id);
    await conn.commit();

    const [[row]] = await pool.query(`${LINE_SELECT} WHERE l.id = ?`, [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    if (adj.status !== 'pending_approval') { return res.status(409).json({ error: 'Only a Pending Approval adjustment can be edited.' }); }

    const [[line]] = await conn.query(
      'SELECT item_id, location_id, department_id, qty_on_hand, est_unit_cost, adjust_qty_by, unit_used, memo FROM inventory_adjustment_lines WHERE id = ? AND inventory_adjustment_id = ?',
      [req.params.lineId, req.params.id]
    );
    if (!line) { return res.status(404).json({ error: 'Line not found' }); }

    const locationId = req.body.location_id !== undefined ? (req.body.location_id || null) : line.location_id;
    const departmentId = req.body.department_id !== undefined ? (req.body.department_id || null) : line.department_id;
    const locationChanged = Number(locationId || 0) !== Number(line.location_id || 0);

    let qtyOnHand = Number(line.qty_on_hand || 0);
    let estUnitCost = Number(line.est_unit_cost || 0);
    if (locationChanged) {
      if (locationId) {
        const [[item]] = await conn.query('SELECT average_cost FROM inventories WHERE id = ?', [line.item_id]);
        const [[stock]] = await conn.query('SELECT qty_on_hand FROM inventory_locations WHERE inventory_id = ? AND location_id = ?', [line.item_id, locationId]);
        qtyOnHand = Number(stock?.qty_on_hand || 0);
        estUnitCost = Number(item?.average_cost || 0);
      } else {
        qtyOnHand = 0;
      }
    }

    // Only fields actually present in the request are changed -- everything else falls
    // back to what's already saved. The frontend fires one PUT per field edited (Unit
    // Used, Adjust Qty By, Location, ... can each be committed independently in quick
    // succession), so treating every field as "must be in this request or it resets to a
    // default" let concurrent edits clobber each other (e.g. picking Base Unit right
    // before blurring Adjust Qty By could silently revert Unit Used back to Stock).
    const adjustQtyBy = req.body.adjust_qty_by !== undefined ? Number(req.body.adjust_qty_by || 0) : Number(line.adjust_qty_by || 0);
    const memo = req.body.memo !== undefined ? (req.body.memo || null) : line.memo;
    const unitUsed = req.body.unit_used !== undefined ? (req.body.unit_used === 'base' ? 'base' : 'stock') : (line.unit_used || 'stock');
    // Qty on Hand/New Qty are always tracked in Base Unit (matches Bin Card and every
    // other stock-moving feature); est_unit_cost (average_cost) is priced per Stock/
    // Purchase Unit. Adjust Qty By is only already in Base Unit when Unit Used = Base
    // Unit -- when it's Stock Unit (the default -- e.g. "1" meaning 1 ROLL), it has to be
    // scaled up by conversion_factor before it's added, the same Purchase Unit -> Base
    // Unit scaling Purchase Order receiving/return apply. current_value needs the same
    // factor applied the other way (cost per Base Unit) since it multiplies against a
    // Base Unit qty.
    const [[itemConv]] = await conn.query('SELECT conversion_factor FROM inventories WHERE id = ?', [line.item_id]);
    const conversionFactor = Number(itemConv?.conversion_factor) || 1;
    const newQty = qtyOnHand + adjustQtyBy * (unitUsed === 'stock' ? conversionFactor : 1);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE inventory_adjustment_lines
       SET location_id = ?, department_id = ?, qty_on_hand = ?, est_unit_cost = ?, current_value = ?,
           adjust_qty_by = ?, new_qty = ?, memo = ?, unit_used = ?
       WHERE id = ?`,
      [locationId, departmentId, qtyOnHand, estUnitCost, qtyOnHand * (estUnitCost / conversionFactor), adjustQtyBy, newQty, memo, unitUsed, req.params.lineId]
    );
    await recomputeTotal(conn, req.params.id);
    await conn.commit();

    const [[row]] = await pool.query(`${LINE_SELECT} WHERE l.id = ?`, [req.params.lineId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    if (adj.status !== 'pending_approval') { return res.status(409).json({ error: 'Only a Pending Approval adjustment can be edited.' }); }

    await conn.beginTransaction();
    await conn.query('DELETE FROM inventory_adjustment_lines WHERE id = ? AND inventory_adjustment_id = ?', [req.params.lineId, req.params.id]);
    await recomputeTotal(conn, req.params.id);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Approving is what actually moves the needle: each line's New Qty is written into
// inventory_locations.qty_on_hand (upserting the row if one doesn't exist yet).
router.put('/:id/approve', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    if (adj.status !== 'pending_approval') { return res.status(409).json({ error: 'Only a Pending Approval adjustment can be approved.' }); }

    const [lines] = await conn.query('SELECT item_id, location_id, new_qty FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ?', [req.params.id]);
    if (lines.length === 0) { return res.status(409).json({ error: 'Add at least one material line before approving.' }); }
    if (lines.some((l) => !l.location_id)) { return res.status(409).json({ error: 'Every line needs a Location before this can be approved.' }); }

    await conn.beginTransaction();
    for (const line of lines) {
      await conn.query(
        `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE qty_on_hand = VALUES(qty_on_hand)`,
        [line.item_id, line.location_id, line.new_qty]
      );
    }
    await conn.query(
      "UPDATE inventory_adjustments SET status = 'approved', approved_by_user_id = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { adjustmentId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: 'pending_approval', newValue: 'approved' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    if (adj.status !== 'pending_approval') { return res.status(409).json({ error: 'Only a Pending Approval adjustment can be cancelled.' }); }

    await conn.beginTransaction();
    await conn.query("UPDATE inventory_adjustments SET status = 'cancelled', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { adjustmentId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'pending_approval', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
