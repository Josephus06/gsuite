const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');

const router = express.Router();
// Reached from a Sales Order's Item Delivery button, not its own page in the nav --
// reuses Sales Orders' permission scope, same treatment as Item Fulfillment/Receipt
// reusing Transfer Orders' and Quality Inspection reusing Production's.
const ROUTE = '/sales-orders';

async function logAudit(conn, { deliveryId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('ItemDelivery', ?, ?, ?, ?, ?, ?)`,
    [deliveryId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Powers the Item Delivery create form -- only JO lines with something both Built and
// QI'd that hasn't shipped yet show up (min(quantity_built, quantity_inspected) -
// quantity_delivered > 0), matching the real screen excluding lines that haven't
// reached production at all.
router.get('/for-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.id, so.sales_order_no, c.name AS customer_name
       FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id WHERE so.id = ?`,
      [req.params.salesOrderId]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT jo.id AS job_order_id, jo.job_order_no, jo.description, jo.quantity_built, jo.quantity_inspected,
              jo.quantity_delivered, jo.units, jo.length, jo.width, jo.height,
              jt.display_name AS item_name,
              loc.location_name AS job_location_name
       FROM sales_order_lines sol
       JOIN job_orders jo ON jo.id = sol.job_order_id
       LEFT JOIN job_types jt ON jt.id = sol.job_type_id
       LEFT JOIN locations loc ON loc.id = sol.job_location_id
       WHERE sol.sales_order_id = ?
         AND LEAST(jo.quantity_built, jo.quantity_inspected) - jo.quantity_delivered > 0
       ORDER BY sol.line_no`,
      [req.params.salesOrderId]
    );

    res.json({ ...so, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query(
      `SELECT del.*, so.sales_order_no, c.name AS customer_name, u.display_name AS created_by_name
       FROM item_deliveries del
       JOIN sales_orders so ON so.id = del.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN users u ON u.id = del.created_by_user_id
       WHERE del.id = ?`,
      [req.params.id]
    );
    if (!d) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT idl.*, jo.job_order_no, jo.description, jo.quantity_inspected, jo.quantity_delivered, jo.units
       FROM item_delivery_lines idl
       LEFT JOIN job_orders jo ON jo.id = idl.job_order_id
       WHERE idl.item_delivery_id = ?`,
      [req.params.id]
    );

    res.json({ ...d, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'ItemDelivery' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Saving is what actually marks a JO's units as shipped -- each line's Qty to Deliver is
// capped at that JO's own min(quantity_built, quantity_inspected) minus whatever's
// already been delivered, so you can never deliver more than what's both been built and
// cleared inspection.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { sales_order_id: salesOrderId, date_created: dateCreated, memo, lines } = req.body;
    if (!salesOrderId) return res.status(400).json({ error: 'Sales Order is required.' });

    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.qty_to_deliver || 0) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Deliver for at least one item.' });

    const [jos] = await conn.query(
      `SELECT jo.id, jo.job_order_no, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered
       FROM job_orders jo JOIN sales_order_lines sol ON sol.job_order_id = jo.id
       WHERE sol.sales_order_id = ?`,
      [salesOrderId]
    );
    const byId = new Map(jos.map((j) => [j.id, j]));

    for (const s of submitted) {
      const jo = byId.get(Number(s.job_order_id));
      if (!jo) return res.status(400).json({ error: 'Unknown Job Order.' });
      const cap = Math.min(Number(jo.quantity_built), Number(jo.quantity_inspected)) - Number(jo.quantity_delivered || 0);
      const qtyToDeliver = Number(s.qty_to_deliver);
      if (qtyToDeliver > cap) {
        return res.status(409).json({ error: `Qty to Deliver for ${jo.job_order_no} exceeds what's both Built and QI'd and not yet delivered (${cap}).` });
      }
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO item_deliveries (delivery_no, sales_order_id, date_created, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?)`,
      [salesOrderId, dateCreated || new Date().toISOString().slice(0, 10), memo || null, req.user.id]
    );
    const deliveryId = result.insertId;
    await conn.query('UPDATE item_deliveries SET delivery_no = ? WHERE id = ?', [`ID-${deliveryId}`, deliveryId]);

    for (const s of submitted) {
      const qtyToDeliver = Number(s.qty_to_deliver);
      await conn.query('UPDATE job_orders SET quantity_delivered = quantity_delivered + ?, updated_at = NOW() WHERE id = ?', [qtyToDeliver, s.job_order_id]);
      await conn.query(
        `INSERT INTO item_delivery_lines (item_delivery_id, job_order_id, qty_delivered, memo)
         VALUES (?, ?, ?, ?)`,
        [deliveryId, s.job_order_id, qtyToDeliver, s.memo || null]
      );
    }

    // A Sales Order's status is only ever as advanced as its *least* advanced line --
    // one line being fully delivered doesn't mean the order is "Partially Delivered" if
    // another line hasn't even gotten a Job Order yet; that pulls the whole order back
    // to "In Process" instead. See computeSalesOrderStatus for the full hierarchy.
    const [freshLines] = await conn.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
       FROM sales_order_lines sol
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
      [salesOrderId]
    );
    const newStatus = computeSalesOrderStatus(freshLines);
    await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, salesOrderId]);
    await logAudit(conn, { deliveryId, userId: req.user.id, eventType: 'Created', fieldName: 'delivery_no', newValue: `ID-${deliveryId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM item_deliveries WHERE id = ?', [deliveryId]);
    res.status(201).json(row);
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
    const [[d]] = await conn.query('SELECT status, sales_order_id FROM item_deliveries WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status === 'cancelled') return res.status(409).json({ error: 'This Item Delivery is already cancelled.' });

    const [lines] = await conn.query('SELECT job_order_id, qty_delivered FROM item_delivery_lines WHERE item_delivery_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      await conn.query('UPDATE job_orders SET quantity_delivered = quantity_delivered - ? WHERE id = ?', [l.qty_delivered, l.job_order_id]);
    }
    await conn.query(
      "UPDATE item_deliveries SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );

    const [[so]] = await conn.query('SELECT status FROM sales_orders WHERE id = ?', [d.sales_order_id]);
    if (so && so.status !== 'cancelled') {
      const [freshLines] = await conn.query(
        `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
         FROM sales_order_lines sol
         LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
        [d.sales_order_id]
      );
      const newStatus = computeSalesOrderStatus(freshLines);
      if (newStatus !== so.status) {
        await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, d.sales_order_id]);
      }
    }
    await logAudit(conn, { deliveryId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'saved', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM item_deliveries WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
