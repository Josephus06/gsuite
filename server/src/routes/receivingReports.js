const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/receiving-reports';
const PO_ROUTE = '/purchase-orders';

// Purchasing > Receiving Report -- every RR across all Purchase Orders.
//
// The documents themselves are created and viewed through the PO that produced them
// (POST /purchase-orders/:id/receipts). What was missing was a way to see them as a
// transaction list, so this module is read-only: it lists and opens, it never creates.
//
// Receiving Reports have no status column of their own, and the parent PO's receipt_status
// cannot stand in for one: import-purchasing-related.js inserts receipt rows without
// re-deriving it, so 19,100 of the 19,103 POs that have receipts still read 'not_received'.
// Only the handful received through the app are correct. The list therefore reports the
// receipt's own line count and received quantity, which are true for every row.

// A user reaches a receipt either from this module or by clicking through a Purchase Order,
// so either permission opens it. Written as one query rather than by chaining
// requirePermission twice: that middleware answers a refusal with res.status(403) instead of
// next(err), so a second check placed after it would never run.
async function requireReceiptView(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT p.route FROM user_page_permissions upp
         JOIN pages p ON p.id = upp.page_id
        WHERE upp.user_id = ? AND upp.can_view = TRUE AND p.route IN (?, ?)`,
      [req.user.id, ROUTE, PO_ROUTE]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, from, to, supplier_id: supplierId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = [];
    const params = [];
    if (search) {
      where.push('(r.receipt_no LIKE ? OR po.po_no LIKE ? OR s.name LIKE ? OR r.ref_no LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    // Inclusive of the end date: date_created is a DATE, so a plain <= is what a user means
    // by "to 31 Aug".
    if (from) { where.push('r.date_created >= ?'); params.push(from); }
    if (to) { where.push('r.date_created <= ?'); params.push(to); }
    if (supplierId) { where.push('po.supplier_id = ?'); params.push(supplierId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT r.id, r.receipt_no, r.date_created, r.ref_no, r.memo, r.is_on_hold,
              r.subtotal, r.net_of_tax, r.tax_amount, r.total_amount,
              po.id AS purchase_order_id, po.po_no,
              s.name AS supplier_name,
              u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM purchase_order_receipt_lines rl
                WHERE rl.purchase_order_receipt_id = r.id) AS line_count,
              (SELECT COALESCE(SUM(rl.qty_received), 0) FROM purchase_order_receipt_lines rl
                WHERE rl.purchase_order_receipt_id = r.id) AS qty_received
         FROM purchase_order_receipts r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN users u ON u.id = r.created_by_user_id
         ${whereSql}
        ORDER BY r.date_created DESC, r.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(r.total_amount), 0) AS total_amount
         FROM purchase_order_receipts r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         ${whereSql}`,
      params
    );

    res.json({ rows, total: totals.total, total_amount: totals.total_amount, limit, offset });
  } catch (err) {
    next(err);
  }
});

// Same payload as GET /purchase-orders/receipts/:receiptId, so the existing detail view can
// read from whichever module the user came in through.
router.get('/:id', requireAuth, requireReceiptView, async (req, res, next) => {
  try {
    const [[receipt]] = await pool.query(
      `SELECT r.*, po.id AS purchase_order_id, po.po_no, po.receipt_status,
              s.name AS supplier_name, u.display_name AS created_by_name
         FROM purchase_order_receipts r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN users u ON u.id = r.created_by_user_id
        WHERE r.id = ?`,
      [req.params.id]
    );
    if (!receipt) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT rl.*, i.item_code, i.display_name AS item_name, loc.location_name, t.code AS tax_code
         FROM purchase_order_receipt_lines rl
         LEFT JOIN inventories i ON i.id = rl.item_id
         LEFT JOIN locations loc ON loc.id = rl.location_id
         LEFT JOIN taxes t ON t.id = rl.tax_code_id
        WHERE rl.purchase_order_receipt_id = ?`,
      [req.params.id]
    );

    res.json({ ...receipt, lines });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
