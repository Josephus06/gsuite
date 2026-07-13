const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/purchase-requisitions';

async function logAudit(conn, { prId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('PurchaseRequisition', ?, ?, ?, ?, ?, ?)`,
    [prId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// A PR line's own progress, mirroring the real "Item Status" column -- OPEN until a
// Purchase Order picks it up, FULLY ORDERED once po_qty catches the full requested qty,
// FULLY RECEIVED once received_qty does too. No Purchase Order module exists in this
// build yet, so every line starts (and stays) OPEN until that's built.
function lineItemStatus(l) {
  const qty = Number(l.qty || 0);
  const poQty = Number(l.po_qty || 0);
  const receivedQty = Number(l.received_qty || 0);
  if (qty > 0 && receivedQty >= qty) return 'FULLY RECEIVED';
  if (qty > 0 && poQty >= qty) return 'FULLY ORDERED';
  return 'OPEN';
}
function aggregateItemStatus(lines) {
  if (!lines.length) return 'OPEN';
  const statuses = lines.map(lineItemStatus);
  if (statuses.every((s) => s === 'FULLY RECEIVED')) return 'FULLY RECEIVED';
  if (statuses.every((s) => s === 'FULLY ORDERED' || s === 'FULLY RECEIVED')) return 'FULLY ORDERED';
  return 'OPEN';
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, department_id: departmentId, status } = req.query;
    const where = [];
    const params = [];
    if (departmentId) { where.push('pr.department_id = ?'); params.push(departmentId); }
    if (status) { where.push('pr.status = ?'); params.push(status); }
    if (search) { where.push('pr.pr_no LIKE ?'); params.push(`%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT pr.id, pr.pr_no, pr.date_created, pr.status,
              d.name AS department_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              u.display_name AS prepared_by_name
       FROM purchase_requisitions pr
       LEFT JOIN departments d ON d.id = pr.department_id
       LEFT JOIN employees e ON e.id = pr.requestor_id
       LEFT JOIN users u ON u.id = pr.prepared_by_user_id
       ${whereSql}
       ORDER BY pr.id DESC`,
      params
    );

    for (const r of rows) {
      const [lines] = await pool.query('SELECT qty, po_qty, received_qty FROM purchase_requisition_lines WHERE purchase_requisition_id = ?', [r.id]);
      r.item_status = aggregateItemStatus(lines);
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[pr]] = await pool.query(
      `SELECT pr.*, d.name AS department_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              u.display_name AS prepared_by_name
       FROM purchase_requisitions pr
       LEFT JOIN departments d ON d.id = pr.department_id
       LEFT JOIN employees e ON e.id = pr.requestor_id
       LEFT JOIN users u ON u.id = pr.prepared_by_user_id
       WHERE pr.id = ?`,
      [req.params.id]
    );
    if (!pr) return res.status(404).json({ error: 'Not found' });

    // Qty on Hand is a company-wide figure here (a PR isn't raised against one specific
    // warehouse) -- summed live across every location rather than snapshotted, so it
    // never goes stale the way Transfer Order's line snapshot originally did.
    const [lines] = await pool.query(
      `SELECT prl.*, i.item_code, i.display_name AS item_name, jo.job_order_no,
              COALESCE((SELECT SUM(qty_on_hand) FROM inventory_locations WHERE inventory_id = prl.item_id), 0) AS qty_on_hand
       FROM purchase_requisition_lines prl
       LEFT JOIN inventories i ON i.id = prl.item_id
       LEFT JOIN job_orders jo ON jo.id = prl.job_order_id
       WHERE prl.purchase_requisition_id = ? ORDER BY prl.line_no`,
      [req.params.id]
    );
    lines.forEach((l) => { l.item_status = lineItemStatus(l); });

    res.json({ ...pr, item_status: aggregateItemStatus(lines), lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/purchase-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT po.id, po.po_no, po.date_created, po.status, po.total_amount, s.name AS supplier_name
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
       JOIN purchase_requisition_lines prl ON prl.id = pol.purchase_requisition_line_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE prl.purchase_requisition_id = ?
       ORDER BY po.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'PurchaseRequisition' AND a.auditable_id = ?
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
    const {
      date_created: dateCreated, date_needed: dateNeeded, department_id: departmentId,
      requestor_id: requestorId, memo, lines,
    } = req.body;

    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one material with a Qty greater than 0.' });

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO purchase_requisitions
         (pr_no, date_created, date_needed, department_id, requestor_id, prepared_by_user_id, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), dateNeeded || null, departmentId || null, requestorId || null, req.user.id, memo || null, req.user.id]
    );
    const prId = result.insertId;
    await conn.query('UPDATE purchase_requisitions SET pr_no = ? WHERE id = ?', [`PR-${prId}`, prId]);

    let lineNo = 1;
    for (const l of submitted) {
      await conn.query(
        `INSERT INTO purchase_requisition_lines (purchase_requisition_id, line_no, item_id, purchase_description, job_order_id, qty, purchase_unit, unit_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [prId, lineNo++, l.item_id, l.purchase_description || null, l.job_order_id || null, l.qty, l.purchase_unit || null, l.unit_title || null]
      );
    }
    await logAudit(conn, { prId, userId: req.user.id, eventType: 'Created', fieldName: 'pr_no', newValue: `PR-${prId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_requisitions WHERE id = ?', [prId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[pr]] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending_request') return res.status(409).json({ error: 'Only a Pending Request PR can be edited.' });

    const {
      date_created: dateCreated, date_needed: dateNeeded, department_id: departmentId,
      requestor_id: requestorId, memo, lines,
    } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one material with a Qty greater than 0.' });

    await conn.beginTransaction();
    await conn.query(
      `UPDATE purchase_requisitions SET date_created = ?, date_needed = ?, department_id = ?, requestor_id = ?, memo = ?, updated_at = NOW() WHERE id = ?`,
      [dateCreated, dateNeeded || null, departmentId || null, requestorId || null, memo || null, req.params.id]
    );
    await conn.query('DELETE FROM purchase_requisition_lines WHERE purchase_requisition_id = ?', [req.params.id]);
    let lineNo = 1;
    for (const l of submitted) {
      await conn.query(
        `INSERT INTO purchase_requisition_lines (purchase_requisition_id, line_no, item_id, purchase_description, job_order_id, qty, purchase_unit, unit_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.params.id, lineNo++, l.item_id, l.purchase_description || null, l.job_order_id || null, l.qty, l.purchase_unit || null, l.unit_title || null]
      );
    }
    await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'lines' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_requisitions WHERE id = ?', [req.params.id]);
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
    const [[pr]] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status === 'cancelled') return res.status(409).json({ error: 'This PR is already cancelled.' });

    await conn.beginTransaction();
    await conn.query(
      "UPDATE purchase_requisitions SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: pr.status, newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_requisitions WHERE id = ?', [req.params.id]);
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
    const [[pr]] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending_request') {
      return res.status(409).json({ error: 'Only a Pending Request PR can be deleted -- cancel it instead.' });
    }

    await conn.beginTransaction();
    await conn.query('DELETE FROM purchase_requisition_lines WHERE purchase_requisition_id = ?', [req.params.id]);
    await conn.query('DELETE FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
