const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/suppliers';

// Everything a supplier record holds. The block after `is_active` came across from the live system
// with the supplier import -- address, contact numbers, credit terms and payee/bank details -- and
// is editable here so the two systems do not drift apart.
//
// `live_pk` and `live_id` are deliberately NOT here: they are the link back to the live record and
// are set by the importer alone, never typed in.
const FIELDS = ['supplier_code', 'name', 'company_name', 'tin', 'payment_term_id', 'is_active',
  'address', 'contact_no', 'mobile_no', 'office_no', 'fax_no', 'email',
  'credit_term', 'term_days', 'payee_name', 'bank_name', 'bank_account_name', 'bank_account_no'];

// An empty box or an unselected <select> posts '', and "not filled in" is NULL, not ''. It matters
// most for payment_term_id and term_days, which are INT: '' there either becomes 0 or errors
// outright depending on the server's SQL mode, and a payment term of 0 points at no row at all.
// Applying it to the text columns too keeps a cleared field matching what the importer stores.
const blankToNull = (value) => (value === '' || value === undefined ? null : value);

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, pt.term_name AS payment_term_name
       FROM suppliers s
       LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id
       ORDER BY s.id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[supplier]] = await pool.query(
      `SELECT s.*, pt.term_name AS payment_term_name
         FROM suppliers s LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id
        WHERE s.id = ?`, [req.params.id]
    );
    if (!supplier) return res.status(404).json({ error: 'Not found' });
    const [contacts] = await pool.query('SELECT * FROM supplier_contacts WHERE supplier_id = ? ORDER BY id', [req.params.id]);
    const [addresses] = await pool.query('SELECT * FROM supplier_addresses WHERE supplier_id = ? ORDER BY id', [req.params.id]);

    // What is still owed this supplier. Read straight off vendor_bills.amount_due, which the bill
    // payment routes decrement as each payment applies (and put back on a void), rather than
    // recomputing gross minus payments here -- two places deriving the same figure differently is
    // how a statement and a payment screen come to disagree. Bills settled in full carry 0, so a
    // plain SUM over every bill is the balance; verified against the clone, where all 18,760 paid
    // bills hold exactly 0 and only the 402 open ones contribute.
    const [[{ balance }]] = await pool.query(
      `SELECT IFNULL(ROUND(SUM(vb.amount_due), 2), 0) AS balance
         FROM vendor_bills vb
         JOIN purchase_orders po ON po.id = vb.purchase_order_id
        WHERE po.supplier_id = ?`, [req.params.id]
    );

    // Items this supplier has been bought from, with the last price paid. Empty until the
    // inventory/supplier price list is imported; the tab says so rather than looking broken.
    const [items] = await pool.query(
      `SELECT isp.id, isp.price, isp.last_purchase_date, isp.ref_no,
              i.item_code, i.display_name, i.item_type
         FROM inventory_supplier_prices isp
         JOIN inventories i ON i.id = isp.inventory_id
        WHERE isp.supplier_id = ?
        ORDER BY i.item_code`, [req.params.id]
    );

    res.json({ ...supplier, contacts, addresses, items, balance: Number(balance) });
  } catch (err) {
    next(err);
  }
});

// Every document this supplier appears on, in one list, newest first -- the supplier's own
// statement. Four sources, which is why it is a UNION rather than a filter on one table:
//
//   PO    purchase_orders        supplier_id directly
//   RR    purchase_order_receipts  through its purchase order
//   VB    vendor_bills             through its purchase order (it has no supplier_id of its own)
//   BPAY  bill_payments          supplier_id directly
//
// PAGINATED, not optional: the busiest supplier in the clone has 3,027 of these rows, and this is
// exactly the "fetch the whole table to show ten of it" shape that has bitten this app elsewhere.
// The count comes from the same subquery so the pager cannot disagree with the page.
//
// The filters mirror the column boxes on the live screen. `as_of` is inclusive and is the one
// that changes the meaning of the list rather than just narrowing it: it answers "where did this
// supplier stand on that date", so it belongs with the date column it sits under.
const LEDGER_SQL = `
  SELECT 'PO' AS doc_type, po.id AS doc_id, po.po_no AS doc_no, po.date_created AS doc_date,
         po.status AS status, po.ref_no AS reference_no, po.memo AS memo, po.total_amount AS amount
    FROM purchase_orders po
   WHERE po.supplier_id = ?
  UNION ALL
  SELECT 'RR', r.id, r.receipt_no, r.date_created, NULL, r.ref_no, r.memo, r.total_amount
    FROM purchase_order_receipts r
    JOIN purchase_orders po ON po.id = r.purchase_order_id
   WHERE po.supplier_id = ?
  UNION ALL
  SELECT 'VB', vb.id, vb.bill_no, vb.date_created, vb.status, vb.reference_no, vb.memo, vb.gross_amount
    FROM vendor_bills vb
    JOIN purchase_orders po ON po.id = vb.purchase_order_id
   WHERE po.supplier_id = ?
  UNION ALL
  SELECT 'BPAY', bp.id, bp.bill_payment_no, bp.date_created, bp.status, bp.reference_no, bp.memo, bp.total_amount
    FROM bill_payments bp
   WHERE bp.supplier_id = ?
`;

router.get('/:id/transactions', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { as_of: asOf, doc_no: docNo, status, reference_no: referenceNo, memo, doc_type: docType } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));

    const id = req.params.id;
    const where = [];
    const params = [id, id, id, id];
    if (asOf) { where.push('t.doc_date <= ?'); params.push(asOf); }
    if (docType) { where.push('t.doc_type = ?'); params.push(docType); }
    if (docNo) { where.push('t.doc_no LIKE ?'); params.push(`%${docNo}%`); }
    if (status) { where.push('t.status LIKE ?'); params.push(`%${status}%`); }
    if (referenceNo) { where.push('t.reference_no LIKE ?'); params.push(`%${referenceNo}%`); }
    if (memo) { where.push('t.memo LIKE ?'); params.push(`%${memo}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM (${LEDGER_SQL}) t ${whereSql}`, params
    );
    const [rows] = await pool.query(
      `SELECT t.* FROM (${LEDGER_SQL}) t ${whereSql}
        ORDER BY t.doc_date DESC, t.doc_no DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ rows, total, page, limit });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const values = FIELDS.map((f) => blankToNull(req.body[f]));
    const [result] = await conn.query(
      `INSERT INTO suppliers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const supplierId = result.insertId;

    for (const c of req.body.contacts || []) {
      await conn.query(
        `INSERT INTO supplier_contacts (supplier_id, contact_name, title, email, phone, is_primary) VALUES (?, ?, ?, ?, ?, ?)`,
        [supplierId, c.contact_name, c.title || null, c.email || null, c.phone || null, !!c.is_primary]
      );
    }
    for (const a of req.body.addresses || []) {
      await conn.query(
        `INSERT INTO supplier_addresses (supplier_id, address_line, is_default) VALUES (?, ?, ?)`,
        [supplierId, a.address_line, !!a.is_default]
      );
    }

    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [supplierId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Supplier code already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    // Only the fields actually SENT are written. This matters now that a supplier carries the
    // twelve imported columns: the old version wrote every field in FIELDS, using null for any the
    // caller omitted, so a client that posted just a name and a code would silently blank the
    // address, TIN, credit term and bank details that came across from the live system.
    // Clearing a field on purpose still works -- that sends the field, as an empty string.
    const present = FIELDS.filter((f) => req.body[f] !== undefined);
    if (present.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    await pool.query(
      `UPDATE suppliers SET ${present.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...present.map((f) => blankToNull(req.body[f])), req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM supplier_contacts WHERE supplier_id = ?', [req.params.id]);
    await conn.query('DELETE FROM supplier_addresses WHERE supplier_id = ?', [req.params.id]);
    await conn.query('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This supplier is referenced by other data and cannot be deleted.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

router.post('/:id/contacts', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { contact_name, title, email, phone, is_primary } = req.body;
    const [result] = await pool.query(
      `INSERT INTO supplier_contacts (supplier_id, contact_name, title, email, phone, is_primary) VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, contact_name, title || null, email || null, phone || null, !!is_primary]
    );
    const [[row]] = await pool.query('SELECT * FROM supplier_contacts WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/contacts/:contactId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM supplier_contacts WHERE id = ? AND supplier_id = ?', [req.params.contactId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/addresses', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { address_line, is_default } = req.body;
    const [result] = await pool.query(
      `INSERT INTO supplier_addresses (supplier_id, address_line, is_default) VALUES (?, ?, ?)`,
      [req.params.id, address_line, !!is_default]
    );
    const [[row]] = await pool.query('SELECT * FROM supplier_addresses WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/addresses/:addressId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM supplier_addresses WHERE id = ? AND supplier_id = ?', [req.params.addressId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
