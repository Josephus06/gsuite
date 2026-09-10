const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');
const { computeItemDeliveryGl } = require('../lib/glImpact');
const { assertPeriodOpen } = require('../lib/accountingPeriod');

const router = express.Router();
// Its own permission scope. It used to borrow Sales Orders', which made "may I raise a
// delivery" mean "may I edit a sales order" -- two different jobs, and it left Item Delivery
// impossible to find in the permission grid because it had no page row at all.
//
//   can_add     create a delivery
//   can_edit    record or correct the method, cost and reference
//   can_delete  cancel one, putting the quantity back on the Job Order
const ROUTE = '/item-deliveries';

// GL Impact computation lives in server/src/lib/glImpact.js (computeItemDeliveryGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeItemDeliveryGl;

async function logAudit(conn, { deliveryId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('ItemDelivery', ?, ?, ?, ?, ?, ?)`,
    [deliveryId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Validates the delivery-method fields shared by create and edit.
//
// The cost is allowed through without a method only when it is blank. A figure attached to no
// method is unattributable at month end -- it would land in the "Not specified" bucket and
// quietly inflate a total nobody can trace back to a courier.
async function readDeliveryMethod(body, conn) {
  const q = conn || pool;
  const raw = body.delivery_method_id;
  const methodId = raw === '' || raw === null || raw === undefined ? null : Number(raw);
  if (methodId !== null && !Number.isInteger(methodId)) return { error: 'Invalid delivery method.' };

  let method = null;
  if (methodId !== null) {
    const [[m]] = await q.query('SELECT id, name, is_active FROM delivery_methods WHERE id = ?', [methodId]);
    if (!m) return { error: 'Unknown delivery method.' };
    if (!m.is_active) return { error: `${m.name} is no longer available as a delivery method.` };
    method = m;
  }

  const rawCost = body.delivery_cost;
  let cost = null;
  if (rawCost !== '' && rawCost !== null && rawCost !== undefined) {
    cost = Number(rawCost);
    if (!Number.isFinite(cost) || cost < 0) return { error: 'Delivery cost must be zero or more.' };
    if (cost > 99999999.99) return { error: 'Delivery cost is out of range.' };
    cost = Math.round(cost * 100) / 100;
  }
  if (cost !== null && methodId === null) {
    return { error: 'Choose how this was delivered before recording what it cost.' };
  }

  const ref = body.delivery_reference == null || String(body.delivery_reference).trim() === ''
    ? null : String(body.delivery_reference).trim().slice(0, 80);

  return { methodId, cost, ref, method };
}

// Powers the Item Delivery create form -- only JO lines with something both Built and
// QI'd that hasn't shipped yet show up (min(quantity_built, quantity_inspected) -
// quantity_delivered > 0), matching the real screen excluding lines that haven't
// reached production at all.
// Mirrors the real system's "Production > Item Delivery" ("Saved Item Delivery") list --
// a flat filterable table (no status tabs), same pattern as Assembly Build's list.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      search, customer_id: customerId, as_of: asOf, page = '1', limit = '10',
    } = req.query;

    const where = [];
    const params = [];
    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
    if (asOf) { where.push('del.date_created <= ?'); params.push(asOf); }
    // 'none' rather than an empty string, which would be indistinguishable from "no filter" --
    // and the unrecorded deliveries are exactly the set someone will want to go and fill in.
    if (req.query.delivery_method_id === 'none') where.push('del.delivery_method_id IS NULL');
    else if (req.query.delivery_method_id) {
      where.push('del.delivery_method_id = ?');
      params.push(req.query.delivery_method_id);
    }
    if (search) {
      where.push('(del.delivery_no LIKE ? OR so.sales_order_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM item_deliveries del
       JOIN sales_orders so ON so.id = del.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN delivery_methods dm ON dm.id = del.delivery_method_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT del.id, del.delivery_no, del.date_created, del.status, so.sales_order_no, c.name AS customer_name,
              del.delivery_cost, del.delivery_reference, dm.name AS delivery_method_name,
              (SELECT COALESCE(SUM(qty_delivered), 0) FROM item_delivery_lines WHERE item_delivery_id = del.id) AS total_qty_delivered
       ${baseFrom} ${whereSql}
       ORDER BY del.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

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

router.get('/by-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, delivery_no, date_created, status FROM item_deliveries WHERE sales_order_id = ? ORDER BY id DESC',
      [req.params.salesOrderId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The methods a delivery can be booked against. Two segments, so it can never be read as an
// /:id -- but it is declared above that route anyway, which is the habit that stops the next
// single-segment endpoint being swallowed.
router.get('/meta/delivery-methods', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, code, name, is_third_party FROM delivery_methods
        WHERE is_active = TRUE ORDER BY sort_order, name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query(
      `SELECT del.*, so.sales_order_no, so.contact_email, so.contact_title, so.contact_phone,
              c.name AS customer_name, cc.contact_name, u.display_name AS created_by_name,
              dm.name AS delivery_method_name, dm.is_third_party AS delivery_is_third_party
       FROM item_deliveries del
       JOIN sales_orders so ON so.id = del.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN users u ON u.id = del.created_by_user_id
       LEFT JOIN delivery_methods dm ON dm.id = del.delivery_method_id
       WHERE del.id = ?`,
      [req.params.id]
    );
    if (!d) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT idl.*, jo.job_order_no, jo.description, jo.quantity AS jo_quantity, jo.quantity_inspected,
              jo.quantity_delivered, jo.units, jo.length, jo.width, jo.height,
              jt.display_name AS item_name, jt.cogs_account_id, jt.asset_account_id,
              loc.location_name AS job_location_name,
              (SELECT COALESCE(SUM(total_cost), 0) FROM job_order_processes WHERE job_order_id = jo.id) AS jo_total_cost
       FROM item_delivery_lines idl
       LEFT JOIN job_orders jo ON jo.id = idl.job_order_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       WHERE idl.item_delivery_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeGlImpact(lines);
    res.json({ ...d, lines, gl_impact: glImpact });
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
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { sales_order_id: salesOrderId, date_created: dateCreated, memo, lines } = req.body;
    if (!salesOrderId) return res.status(400).json({ error: 'Sales Order is required.' });
    await assertPeriodOpen(dateCreated, 'non_gl', conn);

    const dm = await readDeliveryMethod(req.body, conn);
    if (dm.error) return res.status(400).json({ error: dm.error });

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
      `INSERT INTO item_deliveries (delivery_no, sales_order_id, date_created, memo, created_by_user_id,
                                   delivery_method_id, delivery_cost, delivery_reference)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?)`,
      [salesOrderId, dateCreated || new Date().toISOString().slice(0, 10), memo || null, req.user.id,
        dm.methodId, dm.cost, dm.ref]
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
    if (dm.method) {
      await logAudit(conn, {
        deliveryId, userId: req.user.id, eventType: 'Created', fieldName: 'delivery_method', newValue: dm.method.name,
      });
    }
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

// Recording how it went out, and what that cost, after the delivery itself was saved.
//
// This is not an afterthought -- it is the normal case. The courier's fare is known when the
// booking is confirmed or when the monthly statement arrives, both of which are after the goods
// have left. Without this route the month-end figure could only ever be as good as what someone
// guessed at the moment of dispatch.
//
// Every change is written to the audit log field by field, because this is the number the
// month-end report adds up: whoever reconciles the courier bill needs to see who changed a fare
// and when, not just its latest value.
router.put('/:id/delivery-method', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[d]] = await conn.query(
      `SELECT del.status, del.delivery_method_id, del.delivery_cost, del.delivery_reference,
              dm.name AS delivery_method_name
         FROM item_deliveries del
         LEFT JOIN delivery_methods dm ON dm.id = del.delivery_method_id
        WHERE del.id = ?`,
      [req.params.id],
    );
    if (!d) return res.status(404).json({ error: 'Not found' });
    // A cancelled delivery never went anywhere, so it has no method and no fare. Letting one be
    // costed would put spend into the month-end total for goods that were never shipped.
    if (d.status === 'cancelled') {
      return res.status(409).json({ error: 'This delivery is cancelled, so it cannot be costed.' });
    }

    const dm = await readDeliveryMethod(req.body, conn);
    if (dm.error) return res.status(400).json({ error: dm.error });

    await conn.beginTransaction();
    await conn.query(
      'UPDATE item_deliveries SET delivery_method_id = ?, delivery_cost = ?, delivery_reference = ? WHERE id = ?',
      [dm.methodId, dm.cost, dm.ref, req.params.id],
    );

    // Compared as strings so 150 and '150.00' do not read as a change every time the form is
    // saved -- the audit log is only useful while it holds real edits.
    const money = (v) => (v === null || v === undefined ? null : Number(v).toFixed(2));
    const changes = [
      ['delivery_method', d.delivery_method_name || null, dm.method ? dm.method.name : null],
      ['delivery_cost', money(d.delivery_cost), money(dm.cost)],
      ['delivery_reference', d.delivery_reference || null, dm.ref],
    ];
    for (const [fieldName, oldValue, newValue] of changes) {
      if (String(oldValue ?? '') === String(newValue ?? '')) continue;
      await logAudit(conn, {
        deliveryId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName, oldValue, newValue,
      });
    }
    await conn.commit();

    const [[row]] = await pool.query(
      `SELECT del.id, del.delivery_method_id, del.delivery_cost, del.delivery_reference,
              dm.name AS delivery_method_name, dm.is_third_party AS delivery_is_third_party
         FROM item_deliveries del
         LEFT JOIN delivery_methods dm ON dm.id = del.delivery_method_id
        WHERE del.id = ?`,
      [req.params.id],
    );
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[d]] = await conn.query('SELECT status, sales_order_id, date_created FROM item_deliveries WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status === 'cancelled') return res.status(409).json({ error: 'This Item Delivery is already cancelled.' });
    await assertPeriodOpen(d.date_created, 'non_gl', conn);

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
