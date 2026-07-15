const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/purchase-orders';
const APPROVAL_THRESHOLD = 10000;

async function logAudit(conn, { poId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('PurchaseOrder', ?, ?, ?, ?, ?, ?)`,
    [poId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Powers the Place Order Form's working grid -- every still-open line (PR Qty not yet
// fully caught by PO Qty) across the selected Purchase Requisitions. Skips the real
// screen's Supplier Price comparison/reason-code justification for now (see schema.sql
// note on purchase_orders) -- just a straightforward per-line Supplier/Rate/Tax entry.
router.get('/canvass-lines', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const prIds = String(req.query.pr_ids || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (!prIds.length) return res.json([]);

    const [lines] = await pool.query(
      `SELECT prl.id AS purchase_requisition_line_id, prl.purchase_requisition_id, pr.pr_no,
              prl.item_id, i.item_code, i.display_name AS item_name, prl.purchase_description,
              prl.job_order_id, jo.job_order_no, prl.qty, prl.po_qty, prl.purchase_unit, prl.unit_title,
              COALESCE((SELECT SUM(qty_on_hand) FROM inventory_locations WHERE inventory_id = prl.item_id), 0) AS qty_on_hand
       FROM purchase_requisition_lines prl
       JOIN purchase_requisitions pr ON pr.id = prl.purchase_requisition_id
       LEFT JOIN inventories i ON i.id = prl.item_id
       LEFT JOIN job_orders jo ON jo.id = prl.job_order_id
       WHERE prl.purchase_requisition_id IN (?) AND prl.qty > prl.po_qty
       ORDER BY pr.id, prl.line_no`,
      [prIds]
    );
    lines.forEach((l) => { l.remaining = Number(l.qty) - Number(l.po_qty); });
    res.json(lines);
  } catch (err) {
    next(err);
  }
});

// Mirrors the real "Saved Purchase Orders" list's status tabs -- these don't map onto a
// single column, they're a read-only bucket derived from status + receipt_status +
// bill_status together (e.g. "Pending Billing" means status=approved AND fully received
// AND not yet billed at all). Once ANY billing has happened the bucket is driven by
// bill_status rather than receipt_status, since you can't un-bill your way back to
// "pending receipt" -- billing is always the further-along axis.
const LIST_STATUS_CASE = `
  CASE
    WHEN po.status = 'pending_approval' THEN 'pending_approval'
    WHEN po.status = 'pending_approval_gm' THEN 'pending_approval_gm'
    WHEN po.status = 'cancelled' THEN 'cancelled'
    WHEN po.bill_status = 'fully_billed' THEN 'fully_billed'
    WHEN po.bill_status = 'partially_billed' THEN 'partially_billed'
    WHEN po.receipt_status = 'fully_received' THEN 'pending_billing'
    WHEN po.receipt_status = 'partially_received' THEN 'partially_received'
    ELSE 'pending_receipt'
  END
`;
const LIST_STATUS_VALUES = [
  'pending_approval', 'pending_approval_gm', 'pending_receipt', 'partially_received',
  'pending_billing', 'partially_billed', 'fully_billed', 'cancelled',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, supplier_id: supplierId, as_of: asOf, page = '1', limit = '10' } = req.query;

    const commonWhere = [];
    const commonParams = [];
    if (supplierId) { commonWhere.push('po.supplier_id = ?'); commonParams.push(supplierId); }
    if (asOf) { commonWhere.push('po.date_created <= ?'); commonParams.push(asOf); }
    if (search) { commonWhere.push('(po.po_no LIKE ? OR s.name LIKE ?)'); commonParams.push(`%${search}%`, `%${search}%`); }

    const where = [...commonWhere];
    const params = [...commonParams];
    if (status && LIST_STATUS_VALUES.includes(status)) { where.push(`(${LIST_STATUS_CASE}) = ?`); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const commonWhereSql = commonWhere.length ? `WHERE ${commonWhere.join(' AND ')}` : '';

    const baseFrom = `FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by_user_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT po.id, po.po_no, po.ref_no, po.type, po.date_created, po.status, po.receipt_status, po.bill_status,
              po.discount_amount, po.net_of_tax, po.tax_amount, po.total_amount, po.memo,
              s.name AS supplier_name, u.display_name AS created_by_name,
              (${LIST_STATUS_CASE}) AS list_status
       ${baseFrom} ${whereSql}
       ORDER BY po.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [countRows] = await pool.query(
      `SELECT (${LIST_STATUS_CASE}) AS list_status, COUNT(*) AS count ${baseFrom} ${commonWhereSql} GROUP BY list_status`,
      commonParams
    );
    const counts = Object.fromEntries(LIST_STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.list_status] !== undefined) counts[r.list_status] = r.count; });

    res.json({ rows, total, page: pageNum, limit: limitNum, counts });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[po]] = await pool.query(
      `SELECT po.*, s.name AS supplier_name, s.supplier_code, u.display_name AS created_by_name,
              pt.term_name, parent.po_no AS parent_po_no
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by_user_id
       LEFT JOIN payment_terms pt ON pt.id = po.term_id
       LEFT JOIN purchase_orders parent ON parent.id = po.parent_purchase_order_id
       WHERE po.id = ?`,
      [req.params.id]
    );
    if (!po) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT pol.*, i.item_code, i.display_name AS item_name, pr.pr_no, t.code AS tax_code,
              loc.location_name, d.name AS department_name, jo.job_order_no
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       LEFT JOIN purchase_requisition_lines prl ON prl.id = pol.purchase_requisition_line_id
       LEFT JOIN purchase_requisitions pr ON pr.id = prl.purchase_requisition_id
       LEFT JOIN taxes t ON t.id = pol.tax_code_id
       LEFT JOIN locations loc ON loc.id = pol.location_id
       LEFT JOIN departments d ON d.id = pol.department_id
       LEFT JOIN job_orders jo ON jo.id = pol.job_order_id
       WHERE pol.purchase_order_id = ?`,
      [req.params.id]
    );

    res.json({ ...po, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'PurchaseOrder' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Saving splits the working grid into one PO per distinct Supplier -- a canvass batch
// covering several suppliers becomes several POs in one Save, matching the real screen.
// Each line's qty is capped against its source PR line's own remaining (qty - po_qty)
// balance, re-checked fresh here rather than trusting whatever the client last saw.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, ref_no: refNo, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && l.supplier_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Supplier and Qty greater than 0.' });

    const prLineIds = [...new Set(submitted.map((l) => l.purchase_requisition_line_id).filter(Boolean))];
    const prLineById = new Map();
    if (prLineIds.length) {
      const [prLines] = await conn.query('SELECT id, qty, po_qty FROM purchase_requisition_lines WHERE id IN (?)', [prLineIds]);
      prLines.forEach((l) => prLineById.set(l.id, l));
    }
    const consumedByPrLine = {};
    for (const l of submitted) {
      if (!l.purchase_requisition_line_id) continue;
      const prLine = prLineById.get(l.purchase_requisition_line_id);
      if (!prLine) return res.status(400).json({ error: 'One of the selected PR lines is no longer valid.' });
      const remaining = Number(prLine.qty) - Number(prLine.po_qty) - (consumedByPrLine[l.purchase_requisition_line_id] || 0);
      if (Number(l.qty) > remaining) {
        return res.status(409).json({ error: `Qty for ${l.purchase_description || 'a line'} exceeds what's still open on its PR (${remaining}).` });
      }
      consumedByPrLine[l.purchase_requisition_line_id] = (consumedByPrLine[l.purchase_requisition_line_id] || 0) + Number(l.qty);
    }

    // Tax rate is looked up server-side (never trusted from the client) -- same
    // discipline as the Sales Invoice line copy.
    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    const groups = new Map();
    for (const l of submitted) {
      if (!groups.has(l.supplier_id)) groups.set(l.supplier_id, []);
      groups.get(l.supplier_id).push(l);
    }

    await conn.beginTransaction();
    const createdPOs = [];
    for (const [supplierId, groupLines] of groups) {
      let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
      const computed = groupLines.map((l) => {
        const qty = Number(l.qty);
        const rate = Number(l.rate || 0);
        const discPercent = Number(l.disc_percent || 0);
        const lineSubtotal = qty * rate;
        const lineDiscAmount = lineSubtotal * (discPercent / 100);
        const lineNetOfTax = lineSubtotal - lineDiscAmount;
        const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
        const lineTaxAmount = lineNetOfTax * (taxRatePct / 100);
        const extPrice = lineNetOfTax + lineTaxAmount;
        subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
        return { ...l, lineSubtotal, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
      });
      const totalAmount = netOfTax + taxAmount;

      const [result] = await conn.query(
        `INSERT INTO purchase_orders (po_no, date_created, supplier_id, ref_no, memo, subtotal, discount_amount, net_of_tax, tax_amount, total_amount, status, created_by_user_id)
         VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
        [dateCreated || new Date().toISOString().slice(0, 10), supplierId, refNo || null, memo || null, subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
      );
      const poId = result.insertId;
      await conn.query('UPDATE purchase_orders SET po_no = ? WHERE id = ?', [`PO-${poId}`, poId]);

      for (const l of computed) {
        await conn.query(
          `INSERT INTO purchase_order_lines
             (purchase_order_id, purchase_requisition_line_id, item_id, purchase_description, location_id, department_id,
              qty, purchase_unit, unit_title, rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [poId, l.purchase_requisition_line_id || null, l.item_id, l.purchase_description || null, l.location_id || null, l.department_id || null,
            l.qty, l.purchase_unit || null, l.unit_title || null, l.rate || 0, l.disc_percent || 0, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
        );
        if (l.purchase_requisition_line_id) {
          await conn.query('UPDATE purchase_requisition_lines SET po_qty = po_qty + ? WHERE id = ?', [l.qty, l.purchase_requisition_line_id]);
        }
      }
      await logAudit(conn, { poId, userId: req.user.id, eventType: 'Created', fieldName: 'po_no', newValue: `PO-${poId}` });
      createdPOs.push(poId);
    }

    // Once every line on a PR has caught its po_qty up to the full requested qty, the
    // PR itself moves to Request In-Process (or Completed once received -- not modeled
    // yet since there's no Received PO step in this build).
    for (const prLineId of prLineIds) {
      const [[prLine]] = await conn.query('SELECT purchase_requisition_id FROM purchase_requisition_lines WHERE id = ?', [prLineId]);
      if (!prLine) continue;
      const [allLines] = await conn.query('SELECT qty, po_qty FROM purchase_requisition_lines WHERE purchase_requisition_id = ?', [prLine.purchase_requisition_id]);
      const [[pr]] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ?', [prLine.purchase_requisition_id]);
      if (pr && pr.status === 'pending_request') {
        const anyOrdered = allLines.some((l) => Number(l.po_qty) > 0);
        if (anyOrdered) {
          await conn.query("UPDATE purchase_requisitions SET status = 'request_in_process', updated_at = NOW() WHERE id = ?", [prLine.purchase_requisition_id]);
        }
      }
    }

    await conn.commit();
    const [pos] = await pool.query('SELECT * FROM purchase_orders WHERE id IN (?)', [createdPOs]);
    res.status(201).json(pos);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Approval path depends on PO type and amount (see the /direct route's status pick for
// PO3/PO4, which skip straight to the GM tier below):
//   PO1/PO2, total > APPROVAL_THRESHOLD: Purchasing Supervisor approves -> pending_approval_gm
//     -> General Manager approves -> 'approved'.
//   PO1/PO2, total <= APPROVAL_THRESHOLD: Purchasing Supervisor approves -> 'approved' directly.
//   PO3/PO4: created straight into pending_approval_gm -- General Manager approves -> 'approved'.
// A System Admin can also perform the GM-tier approval (matches the "GM" ~ admin-level
// authority precedent used elsewhere, e.g. approving PO3/PO4 costing without a dedicated
// GM account existing yet).
router.put('/:id/approve', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT status, total_amount FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const [[actingUser]] = await conn.query('SELECT is_purchasing_supervisor, account_type FROM users WHERE id = ?', [req.user.id]);

    let newStatus;
    await conn.beginTransaction();
    if (po.status === 'pending_approval') {
      if (!actingUser.is_purchasing_supervisor) {
        await conn.rollback();
        return res.status(403).json({ error: 'Only a Purchasing Supervisor can approve this Purchase Order at this stage.' });
      }
      newStatus = Number(po.total_amount) > APPROVAL_THRESHOLD ? 'pending_approval_gm' : 'approved';
      await conn.query(
        'UPDATE purchase_orders SET status = ?, approved_by_supervisor_user_id = ?, approved_by_supervisor_at = NOW() WHERE id = ?',
        [newStatus, req.user.id, req.params.id]
      );
    } else if (po.status === 'pending_approval_gm') {
      if (actingUser.account_type !== 'System Admin' && actingUser.account_type !== 'General Manager') {
        await conn.rollback();
        return res.status(403).json({ error: 'Only a General Manager / System Admin can approve this Purchase Order.' });
      }
      newStatus = 'approved';
      await conn.query(
        "UPDATE purchase_orders SET status = 'approved', approved_by_gm_user_id = ?, approved_by_gm_at = NOW() WHERE id = ?",
        [req.user.id, req.params.id]
      );
    } else {
      await conn.rollback();
      return res.status(409).json({ error: `This Purchase Order is not pending approval (current status: ${po.status}).` });
    }
    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: po.status, newValue: newStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Landed Cost (PO-2): a sub-PO tied to an already-Approved, non-PO2 parent PO, used for
// freight/customs/etc. charges. Not sourced from any Purchase Requisition line.
router.get('/:id/landed-costs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT po.id, po.po_no, po.date_created, po.status, po.total_amount, po.memo,
              s.name AS supplier_name, pt.term_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN payment_terms pt ON pt.id = po.term_id
       WHERE po.parent_purchase_order_id = ? AND po.type = 'PO2'
       ORDER BY po.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/landed-costs', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[parent]] = await conn.query('SELECT type, status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!parent) return res.status(404).json({ error: 'Not found' });
    if (parent.type === 'PO2') return res.status(409).json({ error: 'A Landed Cost PO cannot itself have a Landed Cost.' });
    if (parent.status !== 'approved') return res.status(409).json({ error: 'The parent Purchase Order must be Approved before adding a Landed Cost.' });

    const { date_created: dateCreated, supplier_id: supplierId, term_id: termId, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!supplierId) return res.status(400).json({ error: 'Select a Supplier.' });
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Qty greater than 0.' });

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const qty = Number(l.qty);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = qty * rate;
      const lineDiscAmount = lineSubtotal * (discPercent / 100);
      const lineNetOfTax = lineSubtotal - lineDiscAmount;
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      const lineTaxAmount = lineNetOfTax * (taxRatePct / 100);
      const extPrice = lineNetOfTax + lineTaxAmount;
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return { ...l, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO purchase_orders (po_no, type, parent_purchase_order_id, date_created, supplier_id, term_id, memo,
         subtotal, discount_amount, net_of_tax, tax_amount, total_amount, status, created_by_user_id)
       VALUES ('', 'PO2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
      [req.params.id, dateCreated || new Date().toISOString().slice(0, 10), supplierId, termId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
    );
    const poId = result.insertId;
    await conn.query('UPDATE purchase_orders SET po_no = ? WHERE id = ?', [`PO-${poId}`, poId]);

    for (const l of computed) {
      await conn.query(
        `INSERT INTO purchase_order_lines
           (purchase_order_id, item_id, purchase_description, qty, purchase_unit, unit_title,
            rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [poId, l.item_id, l.purchase_description || null, l.qty, l.purchase_unit || null, l.unit_title || null,
          l.rate || 0, l.disc_percent || 0, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
      );
    }
    await logAudit(conn, { poId, userId: req.user.id, eventType: 'Created', fieldName: 'po_no', newValue: `PO-${poId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [poId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Direct PO (PO-3 "Services with JO" / PO-4 "Services/Non-Inventory without JO"): a
// standalone Purchase Order not sourced from any Purchase Requisition. Each line can
// carry its own Location/Department, and (PO-3 only) a Job Order.
router.post('/direct', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { po_category: poCategory, date_created: dateCreated, need_by_date: needByDate, supplier_id: supplierId, term_id: termId, ref_no: refNo, memo, lines } = req.body;
    if (!['PO3', 'PO4'].includes(poCategory)) return res.status(400).json({ error: 'Select a PO Category.' });
    if (!supplierId) return res.status(400).json({ error: 'Select a Supplier.' });
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Qty greater than 0.' });

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const qty = Number(l.qty);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = qty * rate;
      const lineDiscAmount = lineSubtotal * (discPercent / 100);
      const lineNetOfTax = lineSubtotal - lineDiscAmount;
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      const lineTaxAmount = lineNetOfTax * (taxRatePct / 100);
      const extPrice = lineNetOfTax + lineTaxAmount;
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return { ...l, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
    });
    const totalAmount = netOfTax + taxAmount;
    // PO3 (Services with JO) / PO4 (Services/Non-Inventory without JO) skip the
    // Purchasing Supervisor tier entirely and go straight to the General Manager --
    // unlike PO1/PO2, which always start with the Purchasing Supervisor regardless of
    // amount (see the /:id/approve route for the full tier breakdown).
    const initialStatus = 'pending_approval_gm';

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO purchase_orders (po_no, type, date_created, need_by_date, supplier_id, term_id, ref_no, memo,
         subtotal, discount_amount, net_of_tax, tax_amount, total_amount, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [poCategory, dateCreated || new Date().toISOString().slice(0, 10), needByDate || null, supplierId, termId || null, refNo || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, totalAmount, initialStatus, req.user.id]
    );
    const poId = result.insertId;
    await conn.query('UPDATE purchase_orders SET po_no = ? WHERE id = ?', [`PO-${poId}`, poId]);

    for (const l of computed) {
      await conn.query(
        `INSERT INTO purchase_order_lines
           (purchase_order_id, item_id, purchase_description, location_id, department_id, job_order_id, memo,
            qty, purchase_unit, unit_title, rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [poId, l.item_id, l.purchase_description || null, l.location_id || null, l.department_id || null,
          poCategory === 'PO3' ? (l.job_order_id || null) : null, l.memo || null,
          l.qty, l.purchase_unit || null, l.unit_title || null, l.rate || 0, l.disc_percent || 0,
          l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
      );
    }
    await logAudit(conn, { poId, userId: req.user.id, eventType: 'Created', fieldName: 'po_no', newValue: `PO-${poId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [poId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/receipts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.receipt_no, r.date_created, r.total_amount, r.is_on_hold
       FROM purchase_order_receipts r
       WHERE r.purchase_order_id = ?
       ORDER BY r.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/receipts/:receiptId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[receipt]] = await pool.query(
      `SELECT r.*, po.id AS purchase_order_id, po.po_no, s.name AS supplier_name, u.display_name AS created_by_name
       FROM purchase_order_receipts r
       JOIN purchase_orders po ON po.id = r.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.id = ?`,
      [req.params.receiptId]
    );
    if (!receipt) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT rl.*, i.item_code, i.display_name AS item_name, loc.location_name, t.code AS tax_code
       FROM purchase_order_receipt_lines rl
       LEFT JOIN inventories i ON i.id = rl.item_id
       LEFT JOIN locations loc ON loc.id = rl.location_id
       LEFT JOIN taxes t ON t.id = rl.tax_code_id
       WHERE rl.purchase_order_receipt_id = ?`,
      [req.params.receiptId]
    );

    res.json({ ...receipt, lines });
  } catch (err) {
    next(err);
  }
});

// Receiving a PO ("Receiving Report" / RR-#): lands the received qty as stock at each
// line's chosen Location (this is what makes the qty show up as on-hand in the
// warehouse), and re-derives the parent PO's receipt_status. Only allowed once the PO is
// Approved -- mirrors the real system, where "Receive" only appears post-approval.
// Rate/Discount%/Tax Code are re-entered per receipt line (invoice price can differ from
// the PO's) rather than just copied from the PO line, matching the real form.
router.post('/:id/receipts', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT id, status, receipt_status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'approved') return res.status(409).json({ error: 'This Purchase Order must be Approved before it can be received.' });

    const { date_created: dateCreated, ref_no: refNo, memo, is_on_hold: isOnHold, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.purchase_order_line_id && Number(l.qty_received) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty Received greater than 0 for at least one line.' });

    const lineIds = submitted.map((l) => l.purchase_order_line_id);
    // conversion_factor: PO Qty (and Rec. Qty here) is always in Purchase Unit -- the
    // amount that actually lands in inventory_locations.qty_on_hand (and Bin Card) is in
    // Base Unit, so it has to be scaled by the item's own Purchase Unit -> Base Unit
    // factor (e.g. 5 ROLL x 1344.8 = 6,724 SQFT).
    const [poLines] = await conn.query(
      `SELECT pol.id, pol.item_id, pol.qty, pol.received_qty, pol.location_id, COALESCE(i.conversion_factor, 1) AS conversion_factor
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       WHERE pol.id IN (?) AND pol.purchase_order_id = ?`,
      [lineIds, req.params.id]
    );
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    for (const l of submitted) {
      const poLine = poLineById.get(l.purchase_order_line_id);
      if (!poLine) return res.status(400).json({ error: 'One of the selected lines does not belong to this Purchase Order.' });
      const remaining = Number(poLine.qty) - Number(poLine.received_qty);
      if (Number(l.qty_received) > remaining) {
        return res.status(409).json({ error: `Qty Received exceeds what's still open on this line (${remaining}).` });
      }
      if (!l.location_id && !poLine.location_id) {
        return res.status(400).json({ error: 'Select a Location for every line being received.' });
      }
    }

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const poLine = poLineById.get(l.purchase_order_line_id);
      const qty = Number(l.qty_received);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = qty * rate;
      const lineDiscAmount = lineSubtotal * (discPercent / 100);
      const lineNetOfTax = lineSubtotal - lineDiscAmount;
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      const lineTaxAmount = lineNetOfTax * (taxRatePct / 100);
      const extPrice = lineNetOfTax + lineTaxAmount;
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return {
        purchase_order_line_id: l.purchase_order_line_id, tax_code_id: l.tax_code_id || null,
        poLine, qty, rate, discPercent, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice,
        locationId: l.location_id || poLine.location_id,
      };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO purchase_order_receipts (receipt_no, purchase_order_id, date_created, ref_no, memo, is_on_hold, subtotal, discount_amount, net_of_tax, tax_amount, total_amount, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, dateCreated || new Date().toISOString().slice(0, 10), refNo || null, memo || null, !!isOnHold, subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
    );
    const receiptId = result.insertId;
    await conn.query('UPDATE purchase_order_receipts SET receipt_no = ? WHERE id = ?', [`RR-${receiptId}`, receiptId]);

    for (const l of computed) {
      await conn.query(
        `INSERT INTO purchase_order_receipt_lines
           (purchase_order_receipt_id, purchase_order_line_id, item_id, location_id, qty_received, rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptId, l.purchase_order_line_id, l.poLine.item_id, l.locationId || null, l.qty, l.rate, l.discPercent, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id, l.lineTaxAmount, l.extPrice]
      );
      await conn.query('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE id = ?', [l.qty, l.purchase_order_line_id]);
      if (l.locationId) {
        const baseQty = l.qty * Number(l.poLine.conversion_factor || 1);
        await conn.query(
          `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
          [l.poLine.item_id, l.locationId, baseQty]
        );
      }
    }

    const [allLines] = await conn.query('SELECT qty, received_qty FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);
    const allReceived = allLines.every((l) => Number(l.received_qty) >= Number(l.qty));
    const anyReceived = allLines.some((l) => Number(l.received_qty) > 0);
    const receiptStatus = allReceived ? 'fully_received' : anyReceived ? 'partially_received' : 'not_received';
    await conn.query('UPDATE purchase_orders SET receipt_status = ? WHERE id = ?', [receiptStatus, req.params.id]);

    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'receipt_status', oldValue: po.receipt_status, newValue: receiptStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_order_receipts WHERE id = ?', [receiptId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/returns', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT vr.id, vr.return_no, vr.date_created, vr.total_amount
       FROM purchase_returns vr
       WHERE vr.purchase_order_id = ?
       ORDER BY vr.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/returns/:returnId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ret]] = await pool.query(
      `SELECT vr.*, po.id AS purchase_order_id, po.po_no, s.name AS supplier_name, u.display_name AS created_by_name
       FROM purchase_returns vr
       JOIN purchase_orders po ON po.id = vr.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = vr.created_by_user_id
       WHERE vr.id = ?`,
      [req.params.returnId]
    );
    if (!ret) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT rl.*, i.item_code, i.display_name AS item_name, loc.location_name, t.code AS tax_code
       FROM purchase_return_lines rl
       LEFT JOIN inventories i ON i.id = rl.item_id
       LEFT JOIN locations loc ON loc.id = rl.location_id
       LEFT JOIN taxes t ON t.id = rl.tax_code_id
       WHERE rl.purchase_return_id = ?`,
      [req.params.returnId]
    );

    res.json({ ...ret, lines });
  } catch (err) {
    next(err);
  }
});

// "Vendor Return" (VR-#): decrements received_qty on each PO line (capped at what's
// currently recorded as received -- received_qty already nets out past returns, so it's
// the correct ceiling) and decrements stock at the same Location the item was received
// into. Re-derives receipt_status the same way the receive endpoint does, which is what
// lets a return flip a Fully Received PO back to Partially Received, matching the real
// system's confirmed behavior.
router.post('/:id/returns', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT id, status, receipt_status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.receipt_status === 'not_received') return res.status(409).json({ error: 'Nothing has been received on this Purchase Order yet.' });

    const { date_created: dateCreated, ref_no: refNo, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.purchase_order_line_id && Number(l.qty_returned) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Return greater than 0 for at least one line.' });

    const lineIds = submitted.map((l) => l.purchase_order_line_id);
    // Same Purchase Unit -> Base Unit scaling as receiving (see POST /:id/receipts) --
    // qty_returned is in Purchase Unit, the stock decrement must be in Base Unit.
    const [poLines] = await conn.query(
      `SELECT pol.id, pol.item_id, pol.qty, pol.received_qty, pol.location_id, COALESCE(i.conversion_factor, 1) AS conversion_factor
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       WHERE pol.id IN (?) AND pol.purchase_order_id = ?`,
      [lineIds, req.params.id]
    );
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    for (const l of submitted) {
      const poLine = poLineById.get(l.purchase_order_line_id);
      if (!poLine) return res.status(400).json({ error: 'One of the selected lines does not belong to this Purchase Order.' });
      if (Number(l.qty_returned) > Number(poLine.received_qty)) {
        return res.status(409).json({ error: `Qty to Return exceeds what's currently received on this line (${poLine.received_qty}).` });
      }
    }

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const poLine = poLineById.get(l.purchase_order_line_id);
      const qty = Number(l.qty_returned);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = qty * rate;
      const lineDiscAmount = lineSubtotal * (discPercent / 100);
      const lineNetOfTax = lineSubtotal - lineDiscAmount;
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      const lineTaxAmount = lineNetOfTax * (taxRatePct / 100);
      const extPrice = lineNetOfTax + lineTaxAmount;
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return {
        purchase_order_line_id: l.purchase_order_line_id, tax_code_id: l.tax_code_id || null,
        poLine, qty, rate, discPercent, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice,
      };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO purchase_returns (return_no, purchase_order_id, date_created, ref_no, memo, subtotal, discount_amount, net_of_tax, tax_amount, total_amount, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, dateCreated || new Date().toISOString().slice(0, 10), refNo || null, memo || null, subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
    );
    const returnId = result.insertId;
    await conn.query('UPDATE purchase_returns SET return_no = ? WHERE id = ?', [`VR-${returnId}`, returnId]);

    for (const l of computed) {
      await conn.query(
        `INSERT INTO purchase_return_lines
           (purchase_return_id, purchase_order_line_id, item_id, location_id, qty_returned, rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [returnId, l.purchase_order_line_id, l.poLine.item_id, l.poLine.location_id, l.qty, l.rate, l.discPercent, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id, l.lineTaxAmount, l.extPrice]
      );
      await conn.query('UPDATE purchase_order_lines SET received_qty = received_qty - ? WHERE id = ?', [l.qty, l.purchase_order_line_id]);
      if (l.poLine.location_id) {
        const baseQty = l.qty * Number(l.poLine.conversion_factor || 1);
        await conn.query(
          'UPDATE inventory_locations SET qty_on_hand = GREATEST(qty_on_hand - ?, 0) WHERE inventory_id = ? AND location_id = ?',
          [baseQty, l.poLine.item_id, l.poLine.location_id]
        );
      }
    }

    const [allLines] = await conn.query('SELECT qty, received_qty FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);
    const allReceived = allLines.every((l) => Number(l.received_qty) >= Number(l.qty));
    const anyReceived = allLines.some((l) => Number(l.received_qty) > 0);
    const receiptStatus = allReceived ? 'fully_received' : anyReceived ? 'partially_received' : 'not_received';
    await conn.query('UPDATE purchase_orders SET receipt_status = ? WHERE id = ?', [receiptStatus, req.params.id]);

    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'receipt_status', oldValue: po.receipt_status, newValue: receiptStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_returns WHERE id = ?', [returnId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Editing a saved Purchase Order -- mirrors the real system's "Edit" button (confirmed
// against the sandbox: reuses the same header/line fields as Create, gated by
// `can_edit`). Only allowed while still Pending Approval, matching how every other
// transaction type in this build already treats "once approved, no further edits" --
// once a PO is approved it may already have Receiving Reports / Vendor Bills built on
// top of its lines, and this build has no undo path for that (same reasoning as
// Inventory Adjustment/Sales Invoice/Vendor Bill only supporting Cancel post-save, never
// Edit). Qty changes are only accepted for lines with no Purchase Requisition link and
// zero received/billed activity -- PR-sourced (PO1) quantities stay fixed to avoid
// desyncing purchase_requisition_lines.po_qty, which Create/Cancel both maintain with
// their own reconciliation logic this route deliberately doesn't duplicate; everything
// else (rate, discount, tax code, description, location, department) is always
// editable, and lines can be added/removed as long as nothing's been received/billed
// against them yet.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (!['pending_approval', 'pending_approval_gm'].includes(po.status)) {
      return res.status(409).json({ error: 'Only a Purchase Order that is still Pending Approval can be edited.' });
    }

    const {
      date_created: dateCreated, need_by_date: needByDate, supplier_id: supplierId,
      term_id: termId, ref_no: refNo, memo, lines,
    } = req.body;
    if (!supplierId) return res.status(400).json({ error: 'Select a Supplier.' });
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Qty greater than 0.' });

    const [existingLines] = await conn.query('SELECT * FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);
    const existingById = new Map(existingLines.map((l) => [l.id, l]));

    const submittedIds = new Set(submitted.filter((l) => l.id).map((l) => Number(l.id)));
    for (const existing of existingLines) {
      if (submittedIds.has(existing.id)) continue;
      if (Number(existing.received_qty) > 0 || Number(existing.billed_qty) > 0) {
        return res.status(409).json({ error: 'Cannot remove a line that already has Received or Billed activity.' });
      }
    }

    for (const l of submitted) {
      if (!l.id) continue;
      const existing = existingById.get(Number(l.id));
      if (!existing) return res.status(400).json({ error: 'One of the submitted lines does not belong to this Purchase Order.' });
      const hasActivity = Number(existing.received_qty) > 0 || Number(existing.billed_qty) > 0;
      const qtyChanged = Number(l.qty) !== Number(existing.qty);
      if (qtyChanged && (existing.purchase_requisition_line_id || hasActivity)) {
        return res.status(409).json({
          error: existing.purchase_requisition_line_id
            ? 'Qty on a line sourced from a Purchase Requisition cannot be changed here.'
            : 'Qty cannot be changed on a line that already has Received or Billed activity.',
        });
      }
    }
    for (const l of submitted) {
      if (l.id) continue;
      if (l.purchase_requisition_line_id) return res.status(400).json({ error: 'New lines cannot be linked to a Purchase Requisition.' });
    }

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const qty = Number(l.qty);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = qty * rate;
      const lineDiscAmount = lineSubtotal * (discPercent / 100);
      const lineNetOfTax = lineSubtotal - lineDiscAmount;
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      const lineTaxAmount = lineNetOfTax * (taxRatePct / 100);
      const extPrice = lineNetOfTax + lineTaxAmount;
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return { ...l, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();

    for (const existing of existingLines) {
      if (submittedIds.has(existing.id)) continue;
      if (existing.purchase_requisition_line_id) {
        await conn.query('UPDATE purchase_requisition_lines SET po_qty = GREATEST(po_qty - ?, 0) WHERE id = ?', [existing.qty, existing.purchase_requisition_line_id]);
      }
      await conn.query('DELETE FROM purchase_order_lines WHERE id = ?', [existing.id]);
    }

    for (const l of computed) {
      if (l.id) {
        await conn.query(
          `UPDATE purchase_order_lines SET
             purchase_description = ?, location_id = ?, department_id = ?, qty = ?, purchase_unit = ?, unit_title = ?,
             rate = ?, disc_percent = ?, disc_amount = ?, net_of_tax = ?, tax_code_id = ?, tax_amount = ?, ext_price = ?
           WHERE id = ?`,
          [l.purchase_description || null, l.location_id || null, l.department_id || null, l.qty, l.purchase_unit || null, l.unit_title || null,
            l.rate || 0, l.disc_percent || 0, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice, l.id]
        );
      } else {
        await conn.query(
          `INSERT INTO purchase_order_lines
             (purchase_order_id, item_id, purchase_description, location_id, department_id, job_order_id,
              qty, purchase_unit, unit_title, rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.params.id, l.item_id, l.purchase_description || null, l.location_id || null, l.department_id || null, l.job_order_id || null,
            l.qty, l.purchase_unit || null, l.unit_title || null, l.rate || 0, l.disc_percent || 0, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
        );
      }
    }

    await conn.query(
      `UPDATE purchase_orders SET
         date_created = ?, need_by_date = ?, supplier_id = ?, term_id = ?, ref_no = ?, memo = ?,
         subtotal = ?, discount_amount = ?, net_of_tax = ?, tax_amount = ?, total_amount = ?
       WHERE id = ?`,
      [dateCreated || po.date_created, needByDate || null, supplierId, termId || null, refNo || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.params.id]
    );
    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'total_amount', oldValue: po.total_amount, newValue: totalAmount });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
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
    const [[po]] = await conn.query('SELECT status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'cancelled') return res.status(409).json({ error: 'This PO is already cancelled.' });

    const [lines] = await conn.query('SELECT purchase_requisition_line_id, qty FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.purchase_requisition_line_id) {
        await conn.query('UPDATE purchase_requisition_lines SET po_qty = GREATEST(po_qty - ?, 0) WHERE id = ?', [l.qty, l.purchase_requisition_line_id]);
      }
    }
    await conn.query(
      "UPDATE purchase_orders SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: po.status, newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
