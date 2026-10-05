// Return Material Inventory (RMI) -- material coming back from a branch or satellite
// warehouse to a central one. See the block comment in db/create-rmi.js for the shape and
// for why it is a single document rather than the three-document transfer-order chain.
//
// The 199 historical documents migrated from live, plus new ones raised here (POST /, added
// 2026-10-05). A new RMI is raised Pending Receipt, as on live, and receiving it is a separate
// piece of work. Stock is deliberately untouched here -- nothing in this file writes
// inventory_locations, so raising, listing or opening an RMI cannot move a balance.
const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { insertNumbered } = require('../lib/docNumber');
const { deriveOnHand } = require('../lib/stockLedger');
const { assertPeriodOpen } = require('../lib/accountingPeriod');

const router = express.Router();
const ROUTE = '/rmis';

// The tabs the list filters on. Order is the document's own life, not alphabetical, because
// that is the order the tabs are drawn in.
const STATUS_VALUES = ['pending_receipt', 'partially_received', 'received', 'cancelled'];

// One row per line, with the item and job resolved. qty is what was sent back; received is
// what arrived -- the live grid's two quantity columns, and the pair the status is derived
// from.
const LINE_SELECT = `
  SELECT l.*, i.item_code, i.display_name AS item_name, jo.job_order_no
    FROM rmi_lines l
    LEFT JOIN inventories i ON i.id = l.item_id
    LEFT JOIN job_orders jo ON jo.id = l.job_order_id
`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const where = [];
    const params = [];
    if (status && STATUS_VALUES.includes(status)) { where.push('r.status = ?'); params.push(status); }
    if (search) {
      where.push('(r.rmi_no LIKE ? OR r.memo LIKE ? OR lf.location_name LIKE ? OR lt.location_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Line count and totals come from the same query rather than a second round trip per
    // row -- the list shows "3 items" and the quantities without opening the document.
    const [rows] = await pool.query(
      `SELECT r.*,
              lf.location_name AS return_from_name,
              lt.location_name AS return_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS returned_by_name,
              (SELECT COUNT(*) FROM rmi_lines l WHERE l.rmi_id = r.id) AS line_count,
              (SELECT COALESCE(SUM(l.qty), 0) FROM rmi_lines l WHERE l.rmi_id = r.id) AS total_qty,
              (SELECT COALESCE(SUM(l.received), 0) FROM rmi_lines l WHERE l.rmi_id = r.id) AS total_received
         FROM rmis r
         LEFT JOIN locations lf ON lf.id = r.return_from_location_id
         LEFT JOIN locations lt ON lt.id = r.return_to_location_id
         LEFT JOIN employees e ON e.id = r.returned_by_employee_id
         ${whereSql}
        ORDER BY r.date_created DESC, r.id DESC`,
      params,
    );

    // Counts are of everything, not of the filtered set: the tabs have to keep showing their
    // totals while one of them is selected.
    const [countRows] = await pool.query('SELECT status, COUNT(*) AS count FROM rmis GROUP BY status');
    const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, counts });
  } catch (err) {
    next(err);
  }
});

// The pickers on the new-RMI form, from this route's own permission: /employees and /inventory
// answer only to those pages' permissions, and a refusal there would stop the form loading.
router.get('/form-meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [employees] = await pool.query('SELECT id, first_name, last_name, position_title FROM employees ORDER BY id DESC');
    const [items] = await pool.query(
      `SELECT i.id, i.item_code, i.display_name, u.code AS base_unit_code, u.title AS base_unit_title
         FROM inventories i LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
        WHERE i.is_active = 1 ORDER BY i.id DESC`
    );
    res.json({ employees, items });
  } catch (err) { next(err); }
});

// Raise a new RMI. Lines come in as { item_id, job_order_no, qty }: JO # is typed, as on live, and
// resolved here. UOM / Unit and Qty on Hand (the Bin Card balance at Return From) are snapshotted
// now, like every other line table, so the document keeps reading the way it was raised.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const {
    date_created: dateCreated, return_from_location_id: fromId, return_to_location_id: toId,
    returned_by_employee_id: returnedBy, memo, lines,
  } = req.body;
  if (!dateCreated) return res.status(400).json({ error: 'Date Created is required.' });
  if (!fromId || !toId) return res.status(400).json({ error: 'Return From and Return To are both required.' });
  if (Number(fromId) === Number(toId)) return res.status(400).json({ error: 'Return From and Return To must be different warehouses.' });
  const items = (Array.isArray(lines) ? lines : []).filter((l) => l && l.item_id);
  if (!items.length) return res.status(400).json({ error: 'Add at least one material.' });
  for (const [i, l] of items.entries()) {
    if (!(Number(l.qty) > 0)) return res.status(400).json({ error: `Line ${i + 1}: Qty must be more than 0.` });
  }

  const conn = await pool.getConnection();
  try {
    await assertPeriodOpen(dateCreated, 'non_gl', conn);
    // Resolve each typed JO # to its job order; one that matches nothing is refused, not dropped.
    const joNos = [...new Set(items.map((l) => String(l.job_order_no || '').trim()).filter(Boolean))];
    const joByNo = new Map();
    if (joNos.length) {
      const [jos] = await conn.query('SELECT id, job_order_no FROM job_orders WHERE job_order_no IN (?)', [joNos]);
      jos.forEach((j) => joByNo.set(j.job_order_no.toUpperCase(), j.id));
      const unknown = joNos.find((n) => !joByNo.has(n.toUpperCase()));
      if (unknown) return res.status(400).json({ error: `JO # ${unknown} was not found.` });
    }
    const [itemRows] = await conn.query(
      `SELECT i.id, u.code AS base_unit_code, u.title AS base_unit_title
         FROM inventories i LEFT JOIN units_of_measure u ON u.id = i.base_unit_id WHERE i.id IN (?)`,
      [items.map((l) => Number(l.item_id))]
    );
    const itemById = new Map(itemRows.map((r) => [Number(r.id), r]));
    const missing = items.find((l) => !itemById.has(Number(l.item_id)));
    if (missing) return res.status(400).json({ error: 'One of the materials is no longer in the item list.' });
    const onHand = await deriveOnHand(conn, items.map((l) => l.item_id));

    await conn.beginTransaction();
    const { id: rmiId, no: rmiNo } = await insertNumbered(conn, {
      table: 'rmis',
      column: 'rmi_no',
      prefix: 'RMI-',
      run: (no) => conn.query(
        `INSERT INTO rmis (rmi_no, date_created, return_from_location_id, return_to_location_id,
                           returned_by_employee_id, memo, status, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_receipt', ?)`,
        [no, dateCreated, fromId, toId, returnedBy || null, memo || null, req.user.id]
      ),
    });
    for (const [i, l] of items.entries()) {
      const it = itemById.get(Number(l.item_id));
      const jo = String(l.job_order_no || '').trim();
      await conn.query(
        `INSERT INTO rmi_lines (rmi_id, line_no, item_id, job_order_id, qty, received, uom, unit, qty_on_hand)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [rmiId, i + 1, it.id, jo ? joByNo.get(jo.toUpperCase()) : null, Number(l.qty),
          it.base_unit_code || null, it.base_unit_title || null,
          Number(onHand.get(`${it.id}|${fromId}`) || 0)]
      );
    }
    await conn.commit();
    res.status(201).json({ id: rmiId, rmi_no: rmiNo });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[rmi]] = await pool.query(
      `SELECT r.*,
              lf.location_name AS return_from_name,
              lt.location_name AS return_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS returned_by_name,
              u.display_name AS created_by_name
         FROM rmis r
         LEFT JOIN locations lf ON lf.id = r.return_from_location_id
         LEFT JOIN locations lt ON lt.id = r.return_to_location_id
         LEFT JOIN employees e ON e.id = r.returned_by_employee_id
         LEFT JOIN users u ON u.id = r.created_by_user_id
        WHERE r.id = ?`,
      [req.params.id],
    );
    if (!rmi) return res.status(404).json({ error: 'RMI not found.' });

    const [lines] = await pool.query(`${LINE_SELECT} WHERE l.rmi_id = ? ORDER BY l.line_no`, [req.params.id]);
    // What has been received in T1S, receipt by receipt. Migrated documents have none -- their
    // received quantities came over on the lines alone.
    const [receipts] = await pool.query(
      `SELECT rrl.id, rrl.rmi_line_id, rrl.qty, rrl.uom, DATE_FORMAT(rrl.date_received, '%Y-%m-%d') AS date_received,
              rrl.created_at, i.item_code, i.display_name AS item_name, u.display_name AS received_by_name
         FROM rmi_receipt_lines rrl
         LEFT JOIN inventories i ON i.id = rrl.item_id
         LEFT JOIN users u ON u.id = rrl.received_by_user_id
        WHERE rrl.rmi_id = ? ORDER BY rrl.date_received, rrl.id`,
      [req.params.id],
    );
    res.json({ ...rmi, lines, receipts });
  } catch (err) {
    next(err);
  }
});

// Receive an RMI (asked 2026-10-05: receiving had never been built). Each line takes what arrived,
// up to what is still outstanding on it -- all of it at once, or part now and the rest later. Every
// receipt is a stock movement (rmi_receipt_lines, read by lib/stockLedger.js): out of Return From,
// into Return To, on the date received. The status follows the lines -- Partially Received while
// anything is short, Received once every line is in full.
//
// can_update, not can_edit: receiving advances the document, it does not change what it says.
router.post('/:id/receive', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  const { date_received: dateReceived, lines } = req.body;
  if (!dateReceived) return res.status(400).json({ error: 'Date Received is required.' });
  const wanted = (Array.isArray(lines) ? lines : []).filter((l) => l && l.rmi_line_id && Number(l.qty) > 0);
  if (!wanted.length) return res.status(400).json({ error: 'Enter a quantity received on at least one line.' });

  const conn = await pool.getConnection();
  try {
    await assertPeriodOpen(dateReceived, 'non_gl', conn);
    await conn.beginTransaction();
    const [[rmi]] = await conn.query('SELECT id, rmi_no, status, date_created FROM rmis WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!rmi) { await conn.rollback(); return res.status(404).json({ error: 'RMI not found.' }); }
    if (rmi.status === 'cancelled') { await conn.rollback(); return res.status(409).json({ error: 'This RMI is cancelled.' }); }
    if (rmi.status === 'received') { await conn.rollback(); return res.status(409).json({ error: 'This RMI has already been received in full.' }); }
    if (String(dateReceived).slice(0, 10) < String(rmi.date_created).slice(0, 10)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Date Received cannot be before the RMI was raised.' });
    }

    const [rmiLines] = await conn.query('SELECT id, line_no, item_id, qty, received, uom FROM rmi_lines WHERE rmi_id = ? FOR UPDATE', [rmi.id]);
    const lineById = new Map(rmiLines.map((l) => [Number(l.id), l]));
    for (const w of wanted) {
      const l = lineById.get(Number(w.rmi_line_id));
      if (!l) { await conn.rollback(); return res.status(400).json({ error: 'One of the lines is not on this RMI.' }); }
      const outstanding = Number((Number(l.qty) - Number(l.received)).toFixed(4));
      if (Number(w.qty) > outstanding + 1e-9) {
        await conn.rollback();
        return res.status(409).json({ error: `Line ${l.line_no}: only ${outstanding} is still to be received.` });
      }
    }

    for (const w of wanted) {
      const l = lineById.get(Number(w.rmi_line_id));
      const q = Number(Number(w.qty).toFixed(4));
      await conn.query(
        `INSERT INTO rmi_receipt_lines (rmi_id, rmi_line_id, item_id, qty, uom, date_received, received_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [rmi.id, l.id, l.item_id, q, l.uom || null, dateReceived, req.user.id],
      );
      await conn.query('UPDATE rmi_lines SET received = received + ? WHERE id = ?', [q, l.id]);
      l.received = Number(l.received) + q;
    }
    const allIn = rmiLines.every((l) => Number(l.received) >= Number(l.qty) - 1e-9);
    const status = allIn ? 'received' : 'partially_received';
    await conn.query(
      'UPDATE rmis SET status = ?, received_at = IF(? = \'received\', ?, received_at) WHERE id = ?',
      [status, status, dateReceived, rmi.id],
    );
    await conn.commit();
    res.json({ id: rmi.id, status });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
