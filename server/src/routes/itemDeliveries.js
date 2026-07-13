const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');

const router = express.Router();
// Reached from a Sales Order's Item Delivery button, not its own page in the nav --
// reuses Sales Orders' permission scope, same treatment as Item Fulfillment/Receipt
// reusing Transfer Orders' and Quality Inspection reusing Production's.
const ROUTE = '/sales-orders';

// GL Impact: recognizing cost-of-sale at delivery time, the mirror image of Assembly
// Build's cost-absorption entry -- reverse-engineered directly from the real system's
// sandbox (Item Delivery > GL Impact tab): debit Cost of Goods Sold (the delivered
// line's Job Type's own cogs_account_id) and credit Finished Goods Inventory (that same
// Job Type's asset_account_id, the exact account Assembly Build debited when the cost
// first went INTO inventory), for the delivered quantity's share of that Job Order's
// total built cost.
//
// item_delivery_lines only stores job_order_id + qty_delivered -- no per-process link
// and no cost snapshot at all (unlike assembly_build_lines) -- so cost is derived live:
// (SUM of that JO's job_order_processes.total_cost) / jo.quantity gives a per-unit cost,
// multiplied by this line's qty_delivered. This assumes cost is spread evenly across the
// JO's full required quantity, which is the only basis available; if a JO's per-unit
// cost genuinely varies within its own run this would be an approximation, not exact.
async function computeGlImpact(lines) {
  const accountIds = [...new Set(lines.flatMap((l) => [l.cogs_account_id, l.asset_account_id]).filter(Boolean))];
  if (!accountIds.length) return [];
  const [coaRows] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [accountIds]);
  const coaById = new Map(coaRows.map((c) => [c.id, c]));

  const debits = new Map();
  const credits = new Map();
  for (const l of lines) {
    if (!l.cogs_account_id || !l.asset_account_id) continue;
    const joQuantity = Number(l.jo_quantity) || 0;
    if (!joQuantity) continue;
    const unitCost = (Number(l.jo_total_cost) || 0) / joQuantity;
    const amount = unitCost * (Number(l.qty_delivered) || 0);
    if (!amount) continue;
    debits.set(l.cogs_account_id, (debits.get(l.cogs_account_id) || 0) + amount);
    credits.set(l.asset_account_id, (credits.get(l.asset_account_id) || 0) + amount);
  }

  const rows = [];
  for (const [id, amt] of debits) {
    const acct = coaById.get(id);
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: Number(amt.toFixed(2)), credit: 0 });
  }
  for (const [id, amt] of credits) {
    const acct = coaById.get(id);
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: Number(amt.toFixed(2)) });
  }
  return rows;
}

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

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query(
      `SELECT del.*, so.sales_order_no, so.contact_email, so.contact_title, so.contact_phone,
              c.name AS customer_name, cc.contact_name, u.display_name AS created_by_name
       FROM item_deliveries del
       JOIN sales_orders so ON so.id = del.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN users u ON u.id = del.created_by_user_id
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
