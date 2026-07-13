const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/transfer-orders';

// qty_on_hand is joined live from the withdraw-from location rather than read off the
// line's own stored column -- that column is only a creation-time snapshot, so it goes
// stale the moment stock moves afterward (e.g. an Inventory Adjustment approved after
// the TO was raised). Aliasing il.qty_on_hand AS qty_on_hand after l.* overrides the
// stale value with the live one.
const LINE_SELECT = `
  SELECT l.*, i.item_code, i.display_name AS item_name,
         jo.job_order_no, il.qty_on_hand AS qty_on_hand
  FROM transfer_order_lines l
  JOIN transfer_orders t ON t.id = l.transfer_order_id
  LEFT JOIN inventories i ON i.id = l.item_id
  LEFT JOIN job_orders jo ON jo.id = l.job_order_id
  LEFT JOIN inventory_locations il ON il.inventory_id = l.item_id AND il.location_id = t.withdraw_from_location_id
`;

async function logAudit(conn, { toId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('TransferOrder', ?, ?, ?, ?, ?, ?)`,
    [toId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// The Transfer Order's status is entirely derived from its lines' own running totals --
// never set directly except for the one manual, terminal exception ('cancelled'). Sums
// (not per-line comparisons) are what distinguish "partially fulfilled" from "pending
// receipt / partially fulfilled": some lines can already be fully received while others
// still haven't been fulfilled at all, and it's the aggregate position across the whole
// order that decides which of the real system's six tabs a TO sits in.
function computeTOStatus(lines) {
  const totalTarget = lines.reduce((s, l) => s + Number(l.adjusted_qty ?? l.qty), 0);
  const totalFulfilled = lines.reduce((s, l) => s + Number(l.fulfilled || 0), 0);
  const totalReceived = lines.reduce((s, l) => s + Number(l.received || 0), 0);
  if (totalFulfilled <= 0) return 'pending_fulfillment';
  if (totalFulfilled < totalTarget) return totalReceived > 0 ? 'pending_receipt_partially_fulfilled' : 'partially_fulfilled';
  return totalReceived < totalFulfilled ? 'pending_receipt' : 'received';
}

const OPEN_TO_STATUSES = ['pending_fulfillment', 'partially_fulfilled', 'pending_receipt_partially_fulfilled'];

router.get('/status-counts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT status, COUNT(*) AS count FROM transfer_orders GROUP BY status');
    const counts = {};
    rows.forEach((r) => { counts[r.status] = r.count; });
    res.json(counts);
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (search) {
      where.push('(t.to_no LIKE ? OR jo.job_order_no LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT t.*, wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              jo.job_order_no, CONCAT(e.first_name, ' ', e.last_name) AS requestor_name
       FROM transfer_orders t
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN job_orders jo ON jo.id = t.job_order_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       ${whereSql}
       ORDER BY t.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT t.*, wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              jo.job_order_no, CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              cu.display_name AS created_by_name, fu.display_name AS fulfilled_by_name
       FROM transfer_orders t
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN job_orders jo ON jo.id = t.job_order_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users fu ON fu.id = t.fulfilled_by_user_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(`${LINE_SELECT} WHERE l.transfer_order_id = ? ORDER BY l.line_no`, [req.params.id]);
    res.json({ ...row, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/item-fulfillments', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [fulfillments] = await pool.query(
      `SELECT f.*, u.display_name AS created_by_name FROM item_fulfillments f
       LEFT JOIN users u ON u.id = f.created_by_user_id
       WHERE f.transfer_order_id = ? ORDER BY f.id DESC`,
      [req.params.id]
    );
    for (const f of fulfillments) {
      const [lines] = await pool.query(
        `SELECT ifl.*, i.item_code, i.display_name AS item_name
         FROM item_fulfillment_lines ifl LEFT JOIN inventories i ON i.id = ifl.item_id
         WHERE ifl.item_fulfillment_id = ?`,
        [f.id]
      );
      f.lines = lines;
      f.status = lines.every((l) => Number(l.received || 0) >= Number(l.qty_fulfilled || 0)) ? 'CLOSED' : 'OPEN';
    }
    res.json(fulfillments);
  } catch (err) {
    next(err);
  }
});

// Item Fulfillment's own detail view -- reached from a Transfer Order's Related Records
// tab, or from the Receive picker. Qty On Hand here is the *destination's* (Transfer
// To's), not Withdraw From's, since this document's own numbers (Fulfill/Received) are
// about what's landed (or about to land) there -- matches how Item Receipt's view shows
// the identical figure for the same items.
router.get('/item-fulfillments/:fulfillmentId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[f]] = await pool.query(
      `SELECT f.*, u.display_name AS created_by_name,
              t.to_no, t.date_created AS to_date_created, t.transfer_to_location_id,
              wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name
       FROM item_fulfillments f
       JOIN transfer_orders t ON t.id = f.transfer_order_id
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       LEFT JOIN users u ON u.id = f.created_by_user_id
       WHERE f.id = ?`,
      [req.params.fulfillmentId]
    );
    if (!f) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT ifl.*, tol.uom, tol.unit, i.item_code, i.display_name AS item_name, i.average_cost, il.qty_on_hand
       FROM item_fulfillment_lines ifl
       LEFT JOIN transfer_order_lines tol ON tol.id = ifl.transfer_order_line_id
       LEFT JOIN inventories i ON i.id = ifl.item_id
       LEFT JOIN inventory_locations il ON il.inventory_id = ifl.item_id AND il.location_id = ?
       WHERE ifl.item_fulfillment_id = ?`,
      [f.transfer_to_location_id, req.params.fulfillmentId]
    );
    const status = lines.every((l) => Number(l.received || 0) >= Number(l.qty_fulfilled || 0)) ? 'CLOSED' : 'OPEN';
    const totalAmount = lines.reduce((s, l) => s + Number(l.qty_fulfilled) * Number(l.average_cost || 0), 0);

    res.json({ ...f, status, total_amount: totalAmount, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/item-fulfillments/:fulfillmentId/item-receipts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, u.display_name AS created_by_name FROM item_receipts r
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.item_fulfillment_id = ? ORDER BY r.id DESC`,
      [req.params.fulfillmentId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Item Receipt is the other half of the two-step stock move Item Fulfillment starts --
// saving one is what actually lands stock at Transfer To. Always raised against one
// specific Item Fulfillment batch (never the Transfer Order directly), since a line can
// be fulfilled across several batches and each is received independently.
router.post('/item-fulfillments/:fulfillmentId/item-receipts', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[f]] = await conn.query(
      `SELECT f.transfer_order_id, t.transfer_to_location_id, t.status FROM item_fulfillments f
       JOIN transfer_orders t ON t.id = f.transfer_order_id WHERE f.id = ?`,
      [req.params.fulfillmentId]
    );
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (f.status === 'cancelled') return res.status(409).json({ error: 'This transfer order has been cancelled.' });

    const { date_created: dateCreated, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.qty_to_receive) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Receive for at least one item.' });

    const [ifLines] = await conn.query(
      `SELECT ifl.*, i.item_code FROM item_fulfillment_lines ifl
       LEFT JOIN inventories i ON i.id = ifl.item_id WHERE ifl.item_fulfillment_id = ?`,
      [req.params.fulfillmentId]
    );
    const byId = new Map(ifLines.map((l) => [l.id, l]));

    for (const s of submitted) {
      const line = byId.get(Number(s.item_fulfillment_line_id));
      if (!line) return res.status(400).json({ error: 'Unknown line.' });
      const remaining = Number(line.qty_fulfilled) - Number(line.received || 0);
      const qtyToReceive = Number(s.qty_to_receive);
      if (qtyToReceive > remaining) {
        return res.status(409).json({ error: `Qty to Receive for ${line.item_code} exceeds what's still outstanding on this fulfillment (${remaining}).` });
      }
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO item_receipts (receipt_no, transfer_order_id, item_fulfillment_id, date_created, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?)`,
      [f.transfer_order_id, req.params.fulfillmentId, dateCreated || new Date().toISOString().slice(0, 10), memo || null, req.user.id]
    );
    const receiptId = result.insertId;
    await conn.query('UPDATE item_receipts SET receipt_no = ? WHERE id = ?', [`IR-${receiptId}`, receiptId]);

    for (const s of submitted) {
      const line = byId.get(Number(s.item_fulfillment_line_id));
      const qtyToReceive = Number(s.qty_to_receive);

      await conn.query(
        `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
        [line.item_id, f.transfer_to_location_id, qtyToReceive]
      );
      await conn.query('UPDATE item_fulfillment_lines SET received = received + ? WHERE id = ?', [qtyToReceive, line.id]);
      await conn.query('UPDATE transfer_order_lines SET received = received + ? WHERE id = ?', [qtyToReceive, line.transfer_order_line_id]);
      await conn.query(
        `INSERT INTO item_receipt_lines (item_receipt_id, transfer_order_line_id, item_fulfillment_line_id, item_id, qty_received, memo)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [receiptId, line.transfer_order_line_id, line.id, line.item_id, qtyToReceive, s.memo || null]
      );
    }

    const [freshLines] = await conn.query(
      'SELECT qty, adjusted_qty, fulfilled, received FROM transfer_order_lines WHERE transfer_order_id = ?',
      [f.transfer_order_id]
    );
    const newStatus = computeTOStatus(freshLines);
    await conn.query('UPDATE transfer_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, f.transfer_order_id]);
    await logAudit(conn, { toId: f.transfer_order_id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', newValue: newStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM item_receipts WHERE id = ?', [receiptId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Item Receipt's own detail view. "Fulfill"/"Received" on each line reflect the parent
// Item Fulfillment line's running totals (not just this one receipt's own qty), so the
// document reads as a status snapshot, not just a transaction amount -- matching how the
// real screen shows the exact same figures here as on the Item Fulfillment it closes.
router.get('/item-receipts/:receiptId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[r]] = await pool.query(
      `SELECT r.*, u.display_name AS created_by_name,
              t.to_no, t.date_created AS to_date_created, t.transfer_to_location_id,
              wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              f.fulfillment_no, f.date_created AS if_date_created
       FROM item_receipts r
       JOIN transfer_orders t ON t.id = r.transfer_order_id
       JOIN item_fulfillments f ON f.id = r.item_fulfillment_id
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.id = ?`,
      [req.params.receiptId]
    );
    if (!r) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT rl.item_id, rl.qty_received, rl.memo, tol.uom, tol.unit,
              i.item_code, i.display_name AS item_name, i.average_cost,
              il.qty_on_hand, ifl.qty_fulfilled, ifl.received
       FROM item_receipt_lines rl
       LEFT JOIN transfer_order_lines tol ON tol.id = rl.transfer_order_line_id
       LEFT JOIN inventories i ON i.id = rl.item_id
       LEFT JOIN inventory_locations il ON il.inventory_id = rl.item_id AND il.location_id = ?
       LEFT JOIN item_fulfillment_lines ifl ON ifl.id = rl.item_fulfillment_line_id
       WHERE rl.item_receipt_id = ?`,
      [r.transfer_to_location_id, req.params.receiptId]
    );
    const totalAmount = lines.reduce((s, l) => s + Number(l.qty_received) * Number(l.average_cost || 0), 0);

    res.json({ ...r, total_amount: totalAmount, lines });
  } catch (err) {
    next(err);
  }
});

// Reallocate is how a warehouse controller decides which of several *competing* pending
// Transfer Order lines -- all wanting the same item out of the same location -- actually
// gets a claim on the shared on-hand pool. Committed only ever moves through here, never
// through fulfillment itself (see POST /:id/item-fulfillments, which caps Qty to Fulfill
// at a line's own committed balance) -- so a freshly-raised TO sits at Committed 0,
// unfulfillable, until it's been reallocated some stock.
router.get('/lines/:lineId/reallocate', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[line]] = await pool.query(
      `SELECT tol.item_id, t.withdraw_from_location_id FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id WHERE tol.id = ?`,
      [req.params.lineId]
    );
    if (!line) return res.status(404).json({ error: 'Not found' });

    const [[item]] = await pool.query('SELECT id, item_code, display_name FROM inventories WHERE id = ?', [line.item_id]);
    const [[location]] = await pool.query('SELECT id, location_name FROM locations WHERE id = ?', [line.withdraw_from_location_id]);
    const [[stock]] = await pool.query(
      'SELECT qty_on_hand, qty_committed FROM inventory_locations WHERE inventory_id = ? AND location_id = ?',
      [line.item_id, line.withdraw_from_location_id]
    );

    const [candidates] = await pool.query(
      `SELECT tol.id AS transfer_order_line_id, tol.qty, tol.adjusted_qty, tol.fulfilled, tol.committed, tol.uom, tol.unit,
              t.id AS to_id, t.to_no, t.date_created AS order_date, t.date_needed
       FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id
       WHERE tol.item_id = ? AND t.withdraw_from_location_id = ? AND t.status IN (?)
       ORDER BY t.date_created ASC, t.id ASC`,
      [line.item_id, line.withdraw_from_location_id, OPEN_TO_STATUSES]
    );

    res.json({
      item, location,
      qty_on_hand: Number(stock?.qty_on_hand || 0),
      qty_committed: Number(stock?.qty_committed || 0),
      triggering_line_id: Number(req.params.lineId),
      candidates,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/lines/:lineId/reallocate', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[line]] = await conn.query(
      `SELECT tol.item_id, t.withdraw_from_location_id FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id WHERE tol.id = ?`,
      [req.params.lineId]
    );
    if (!line) return res.status(404).json({ error: 'Not found' });

    const submitted = (Array.isArray(req.body.lines) ? req.body.lines : []).filter((l) => l.transfer_order_line_id);
    if (!submitted.length) return res.status(400).json({ error: 'Select at least one order to commit qty to.' });

    // Every submitted line must genuinely belong to this same item+location pool --
    // otherwise stock earmarked for one item could get reassigned to an unrelated one.
    const [poolLines] = await conn.query(
      `SELECT tol.id, tol.qty, tol.adjusted_qty, tol.committed FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id
       WHERE tol.item_id = ? AND t.withdraw_from_location_id = ? AND t.status IN (?)`,
      [line.item_id, line.withdraw_from_location_id, OPEN_TO_STATUSES]
    );
    const poolById = new Map(poolLines.map((l) => [l.id, l]));

    for (const s of submitted) {
      const target = poolById.get(Number(s.transfer_order_line_id));
      if (!target) return res.status(400).json({ error: 'One of the selected orders is no longer eligible.' });
      const committedQty = Number(s.committed);
      const cap = Number(target.adjusted_qty ?? target.qty);
      if (!(committedQty >= 0) || committedQty > cap) {
        return res.status(409).json({ error: `Committed qty can't exceed that order's own ordered qty (${cap}).` });
      }
    }

    const [[stock]] = await conn.query(
      'SELECT qty_on_hand FROM inventory_locations WHERE inventory_id = ? AND location_id = ?',
      [line.item_id, line.withdraw_from_location_id]
    );
    const onHand = Number(stock?.qty_on_hand || 0);

    const submittedById = new Map(submitted.map((s) => [Number(s.transfer_order_line_id), Number(s.committed)]));
    let newTotal = 0;
    for (const l of poolLines) {
      newTotal += submittedById.has(l.id) ? submittedById.get(l.id) : Number(l.committed || 0);
    }
    if (newTotal > onHand) {
      return res.status(409).json({ error: `Total committed (${newTotal}) can't exceed what's on hand at this location (${onHand}).` });
    }

    await conn.beginTransaction();
    for (const [lineId, committedQty] of submittedById) {
      await conn.query('UPDATE transfer_order_lines SET committed = ? WHERE id = ?', [committedQty, lineId]);
    }
    await conn.query(
      `INSERT INTO inventory_locations (inventory_id, location_id, qty_committed)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE qty_committed = VALUES(qty_committed)`,
      [line.item_id, line.withdraw_from_location_id, newTotal]
    );
    await conn.commit();

    res.json({ ok: true, qty_committed: newTotal });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'TransferOrder' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Creates the TO header plus one line per material passed in `lines` -- this is how the
// Production module's "Create TO" button (only shown when a Job Order has short
// materials) pre-fills the form with exactly the items that are actually short, in one
// request, rather than requiring the user to add each line by hand afterward.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      date_created: dateCreated, date_needed: dateNeeded,
      withdraw_from_location_id: withdrawFromId, transfer_to_location_id: transferToId,
      requestor_id: requestorId, job_order_id: jobOrderId, memo, lines,
    } = req.body;
    if (!withdrawFromId || !transferToId) {
      return res.status(400).json({ error: 'Withdraw From and Transfer To locations are required.' });
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO transfer_orders
         (to_no, date_created, date_needed, withdraw_from_location_id, transfer_to_location_id, requestor_id, job_order_id, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), dateNeeded || null, withdrawFromId, transferToId, requestorId || null, jobOrderId || null, memo || null, req.user.id]
    );
    const toId = result.insertId;
    await conn.query('UPDATE transfer_orders SET to_no = ? WHERE id = ?', [`TO-${toId}`, toId]);
    await logAudit(conn, { toId, userId: req.user.id, eventType: 'Created', fieldName: 'to_no', newValue: `TO-${toId}` });

    let lineNo = 1;
    for (const line of (Array.isArray(lines) ? lines : [])) {
      if (!line.item_id || !line.qty) continue;
      const [[stock]] = await conn.query(
        'SELECT qty_on_hand FROM inventory_locations WHERE inventory_id = ? AND location_id = ?',
        [line.item_id, withdrawFromId]
      );
      const [[{ toCount }]] = await conn.query(
        'SELECT COUNT(*) + 1 AS toCount FROM transfer_order_lines WHERE job_order_process_id = ?',
        [line.job_order_process_id || 0]
      );
      await conn.query(
        `INSERT INTO transfer_order_lines
           (transfer_order_id, line_no, item_id, job_order_id, job_order_process_id, to_count, qty, uom, unit, back_ordered, committed, qty_on_hand, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          toId, lineNo++, line.item_id, jobOrderId || null, line.job_order_process_id || null,
          line.job_order_process_id ? toCount : 1, line.qty, line.uom || null, line.unit || null,
          line.back_ordered || 0, line.committed || 0, Number(stock?.qty_on_hand || 0), line.memo || null,
        ]
      );
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM transfer_orders WHERE id = ?', [toId]);
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
    const [[t]] = await pool.query('SELECT status FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'pending_fulfillment') return res.status(409).json({ error: 'Only a transfer order with nothing fulfilled yet can be edited.' });

    const {
      date_created: dateCreated, date_needed: dateNeeded,
      withdraw_from_location_id: withdrawFromId, transfer_to_location_id: transferToId,
      requestor_id: requestorId, memo,
    } = req.body;
    await pool.query(
      `UPDATE transfer_orders SET date_created = ?, date_needed = ?, withdraw_from_location_id = ?,
              transfer_to_location_id = ?, requestor_id = ?, memo = ?, updated_at = NOW() WHERE id = ?`,
      [dateCreated, dateNeeded || null, withdrawFromId, transferToId, requestorId || null, memo || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM transfer_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/lines', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT status, withdraw_from_location_id, job_order_id FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'pending_fulfillment') return res.status(409).json({ error: 'Only a transfer order with nothing fulfilled yet can be edited.' });

    const { item_id: itemId, qty, uom, unit, memo } = req.body;
    if (!itemId || !qty) return res.status(400).json({ error: 'Item and Qty are required.' });

    await conn.beginTransaction();
    const [[stock]] = await conn.query(
      'SELECT qty_on_hand FROM inventory_locations WHERE inventory_id = ? AND location_id = ?',
      [itemId, t.withdraw_from_location_id]
    );
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM transfer_order_lines WHERE transfer_order_id = ?',
      [req.params.id]
    );
    const [result] = await conn.query(
      `INSERT INTO transfer_order_lines (transfer_order_id, line_no, item_id, job_order_id, qty, uom, unit, qty_on_hand, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, nextLine, itemId, t.job_order_id, qty, uom || null, unit || null, Number(stock?.qty_on_hand || 0), memo || null]
    );
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
  try {
    const [[t]] = await pool.query('SELECT status FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'pending_fulfillment') return res.status(409).json({ error: 'Only a transfer order with nothing fulfilled yet can be edited.' });

    const { qty, adjusted_qty: adjustedQty, memo } = req.body;
    await pool.query(
      'UPDATE transfer_order_lines SET qty = ?, adjusted_qty = ?, memo = ? WHERE id = ? AND transfer_order_id = ?',
      [qty, adjustedQty === '' ? null : adjustedQty, memo || null, req.params.lineId, req.params.id]
    );
    const [[row]] = await pool.query(`${LINE_SELECT} WHERE l.id = ?`, [req.params.lineId]);
    if (!row) return res.status(404).json({ error: 'Line not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT status FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'pending_fulfillment') return res.status(409).json({ error: 'Only a transfer order with nothing fulfilled yet can be edited.' });

    await pool.query('DELETE FROM transfer_order_lines WHERE id = ? AND transfer_order_id = ?', [req.params.lineId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Item Fulfillment is its own transaction, raised against a Transfer Order -- mirrors
// the real system's two-step stock move: saving this only pulls stock out of Withdraw
// From, right now. Landing it at Transfer To is a separate later step (Item Receipt)
// that this build doesn't model, so nothing here ever touches the destination's
// qty_on_hand. Each line can be partially fulfilled across multiple Item Fulfillment
// transactions -- `fulfilled` is a running total capped at that line's own qty (or
// Adjusted Qty, if the requestor tweaked it). The Transfer Order only flips to
// "fulfilled" once every line's running total has caught all the way up.
router.post('/:id/item-fulfillments', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query(
      'SELECT status, withdraw_from_location_id FROM transfer_orders WHERE id = ?',
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!OPEN_TO_STATUSES.includes(t.status)) return res.status(409).json({ error: 'This transfer order has nothing left to fulfill.' });

    const { date_created: dateCreated, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.qty_to_fulfill) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Fulfill for at least one item.' });

    const [toLines] = await conn.query(
      `SELECT tol.*, i.item_code FROM transfer_order_lines tol
       LEFT JOIN inventories i ON i.id = tol.item_id WHERE tol.transfer_order_id = ?`,
      [req.params.id]
    );
    const byId = new Map(toLines.map((l) => [l.id, l]));

    // Validate everything before writing anything -- same discipline as Assembly Build.
    for (const s of submitted) {
      const line = byId.get(Number(s.transfer_order_line_id));
      if (!line) return res.status(400).json({ error: 'Unknown line.' });
      const target = Number(line.adjusted_qty ?? line.qty);
      const remaining = target - Number(line.fulfilled || 0);
      const qtyToFulfill = Number(s.qty_to_fulfill);
      if (qtyToFulfill > remaining) {
        return res.status(409).json({ error: `Qty to Fulfill for ${line.item_code} exceeds the remaining balance (${remaining}).` });
      }
      // Committed, not raw on-hand, is what actually gates fulfillment -- it's this
      // line's reserved share of a pool that other pending Transfer Order lines may
      // also be claiming (see /lines/:lineId/reallocate). A freshly-raised line sits at
      // Committed 0 until someone reallocates stock to it.
      const committedRemaining = Number(line.committed || 0) - Number(line.fulfilled || 0);
      if (qtyToFulfill > committedRemaining) {
        return res.status(409).json({ error: `Qty to Fulfill for ${line.item_code} exceeds its committed qty (${committedRemaining} available) -- reallocate stock to this order first.` });
      }
      const [[stock]] = await conn.query(
        'SELECT qty_on_hand FROM inventory_locations WHERE inventory_id = ? AND location_id = ?',
        [line.item_id, t.withdraw_from_location_id]
      );
      const available = Number(stock?.qty_on_hand || 0);
      if (qtyToFulfill > available) {
        return res.status(409).json({ error: `Qty to Fulfill for ${line.item_code} exceeds what's on hand at the withdraw-from location (${available}).` });
      }
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO item_fulfillments (fulfillment_no, transfer_order_id, date_created, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?)`,
      [req.params.id, dateCreated || new Date().toISOString().slice(0, 10), memo || null, req.user.id]
    );
    const fulfillmentId = result.insertId;
    await conn.query('UPDATE item_fulfillments SET fulfillment_no = ? WHERE id = ?', [`IF-${fulfillmentId}`, fulfillmentId]);

    for (const s of submitted) {
      const line = byId.get(Number(s.transfer_order_line_id));
      const qtyToFulfill = Number(s.qty_to_fulfill);

      await conn.query(
        'UPDATE inventory_locations SET qty_on_hand = qty_on_hand - ? WHERE inventory_id = ? AND location_id = ?',
        [qtyToFulfill, line.item_id, t.withdraw_from_location_id]
      );
      await conn.query('UPDATE transfer_order_lines SET fulfilled = fulfilled + ? WHERE id = ?', [qtyToFulfill, line.id]);
      await conn.query(
        `INSERT INTO item_fulfillment_lines (item_fulfillment_id, transfer_order_line_id, item_id, qty_fulfilled, memo)
         VALUES (?, ?, ?, ?, ?)`,
        [fulfillmentId, line.id, line.item_id, qtyToFulfill, s.memo || null]
      );
    }

    const [freshLines] = await conn.query(
      'SELECT qty, adjusted_qty, fulfilled, received FROM transfer_order_lines WHERE transfer_order_id = ?',
      [req.params.id]
    );
    const newStatus = computeTOStatus(freshLines);
    await conn.query(
      'UPDATE transfer_orders SET status = ?, fulfilled_by_user_id = ?, fulfilled_at = NOW(), updated_at = NOW() WHERE id = ?',
      [newStatus, req.user.id, req.params.id]
    );
    await logAudit(conn, { toId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', newValue: newStatus });
    await logAudit(conn, { toId: req.params.id, userId: req.user.id, eventType: 'Created', fieldName: 'fulfillment_no', newValue: `IF-${fulfillmentId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM item_fulfillments WHERE id = ?', [fulfillmentId]);
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
    const [[t]] = await conn.query('SELECT status FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status === 'received' || t.status === 'cancelled') {
      return res.status(409).json({ error: `A transfer order that's already ${t.status === 'received' ? 'Received' : 'Cancelled'} can't be cancelled.` });
    }

    await conn.beginTransaction();
    await conn.query("UPDATE transfer_orders SET status = 'cancelled', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { toId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: t.status, newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM transfer_orders WHERE id = ?', [req.params.id]);
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
    const [[t]] = await conn.query('SELECT status FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    // Once anything's actually been fulfilled/received, deleting the TO would orphan
    // real stock-moving Item Fulfillment/Receipt records -- only a completely untouched
    // order can be hard-deleted; anything further along should be Cancelled instead.
    if (t.status !== 'pending_fulfillment') {
      return res.status(409).json({ error: 'Only a transfer order with nothing fulfilled yet can be deleted -- cancel it instead.' });
    }

    await conn.beginTransaction();
    await conn.query('DELETE FROM transfer_order_lines WHERE transfer_order_id = ?', [req.params.id]);
    await conn.query('DELETE FROM transfer_orders WHERE id = ?', [req.params.id]);
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
