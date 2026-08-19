// Return Material Inventory (RMI) -- material coming back from a branch or satellite
// warehouse to a central one. See the block comment in db/create-rmi.js for the shape and
// for why it is a single document rather than the three-document transfer-order chain.
//
// Read-only for now: the 199 historical documents migrated from live are the content, and
// raising a new one is a separate piece of work. Stock is deliberately untouched here --
// nothing in this file writes inventory_locations, so listing and opening a migrated RMI
// cannot move a balance.
const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

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
    res.json({ ...rmi, lines });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
