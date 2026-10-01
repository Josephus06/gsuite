const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');

const router = express.Router();
const ROUTE = '/sales-orders';

const STATUS_VALUES = [
  'pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered',
  'pending_billing', 'pending_billing_partially_delivered', 'billed', 'cancelled',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      status, search, sales_rep_id: salesRepId, office_location_id: officeLocationId, as_of: asOf,
      customer_id: customerId, page = '1', limit = '10',
    } = req.query;

    const commonWhere = [];
    const commonParams = [];
    if (salesRepId) { commonWhere.push('so.sales_rep_id = ?'); commonParams.push(salesRepId); }
    if (officeLocationId) { commonWhere.push('so.office_location_id = ?'); commonParams.push(officeLocationId); }
    if (asOf) { commonWhere.push('so.date_created <= ?'); commonParams.push(asOf); }
    if (customerId) { commonWhere.push('so.customer_id = ?'); commonParams.push(customerId); }
    if (search) {
      // The Sales Rep's name too: a supervisor typing a rep's name ("vanessa") expects that rep's
      // orders, and only got customers who happened to share the name. sr is joined whenever
      // search is set (countFrom below).
      commonWhere.push("(so.sales_order_no LIKE ? OR e.estimate_no LIKE ? OR c.name LIKE ? OR so.contract_description LIKE ? OR CONCAT(sr.first_name, ' ', sr.last_name) LIKE ?)");
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Account Officers only ever see their own sales orders; Supervisors see their own
    // plus their direct reports' -- everyone else is unrestricted.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope) { commonWhere.push('so.sales_rep_id IN (?)'); commonParams.push(scope); }

    const where = [...commonWhere];
    const params = [...commonParams];
    if (status && STATUS_VALUES.includes(status)) { where.push('so.status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const commonWhereSql = commonWhere.length ? `WHERE ${commonWhere.join(' AND ')}` : '';

    const baseFrom = `FROM sales_orders so
       LEFT JOIN estimates e ON e.id = so.estimate_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id`;

    // The two COUNT queries below do not need the five joins baseFrom carries. Every one of them
    // is a LEFT JOIN on the sales_orders side, so none can change how many rows are counted --
    // they were pure cost over all 69k rows. Measured on production: COUNT(*) 0.84s -> 0.11s and
    // the GROUP BY 0.98s -> 0.23s, which was 1.8s of the 1.96s this endpoint took to return ten
    // rows. estimates and customers come back only when `search` is active, because that is the
    // one filter that reads e.estimate_no and c.name.
    //
    // The same reasoning is already applied to the Production list counts, for the same reason.
    const countFrom = search ? baseFrom : `FROM sales_orders so`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${countFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT so.*, e.estimate_no, c.name AS customer_name, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name, loc.location_name
       ${baseFrom} ${whereSql}
       ORDER BY so.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [countRows] = await pool.query(
      `SELECT so.status, COUNT(*) AS count ${countFrom} ${commonWhereSql} GROUP BY so.status`,
      commonParams
    );
    const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, total, page: pageNum, limit: limitNum, counts });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.*, e.estimate_no, c.name AS customer_name, cc.contact_name,
              sd.name AS sales_division_name, loc.location_name AS office_location_name,
              bp.po_number AS blanket_po_no,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
              CONCAT(ap.first_name, ' ', ap.last_name) AS approved_by_name
       FROM sales_orders so
       LEFT JOIN estimates e ON e.id = so.estimate_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       LEFT JOIN blanket_pos bp ON bp.id = so.blanket_po_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN employees ap ON ap.id = so.approved_by_id
       WHERE so.id = ?`,
      [req.params.id]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });
    // Defense in depth -- a scoped user can't view someone else's sales order just by
    // guessing/pasting its URL, even though the list already filters it out.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope && !scope.includes(so.sales_rep_id)) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sol.*, jt.display_name AS job_type_name, loc.location_name AS job_location_name, t.code AS tax_code, t.rate AS tax_rate,
              jo.job_order_no, jo.status AS job_order_status,
              jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
       FROM sales_order_lines sol
       LEFT JOIN job_types jt ON jt.id = sol.job_type_id
       LEFT JOIN locations loc ON loc.id = sol.job_location_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
       WHERE sol.sales_order_id = ? ORDER BY sol.line_no`,
      [req.params.id]
    );

    res.json({ ...so, lines });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- edit (System Admin only)
//
// Header details and every line -- description, qty, price, Disc Amt (PER PIECE, the estimate's
// rule: Disc Price/Unit = Price/Unit - Disc Amt, Net of Tax = Qty x Disc Price/Unit), tax code,
// sizes, delivery date/time, remarks. Amounts are recomputed here, never trusted from the browser;
// the header totals follow; a line's Job Order takes the new quantity and description; the SO
// status is recomputed. The CUSTOMER is not editable: an invoice reads its customer through its
// SO, so changing it would silently move invoices and receivables to someone else.
const SO_HEADER_EDIT = ['ref_no', 'date_created', 'contact_person_id', 'contact_email', 'contact_title', 'contact_phone',
  'blanket_po_memo', 'sales_rep_id', 'office_location_id', 'contract_description', 'memo', 'shipping_address',
  'production_lead_time', 'price_validity', 'order_confirmation_type', 'order_confirmation_ref', 'credit_term',
  'bill_to_contact_number'];
const SO_LINE_EDIT = ['description', 'job_location_id', 'quantity', 'units', 'price_per_unit', 'tax_code_id', 'length', 'width', 'height', 'uom',
  'shipping', 'remarks', 'memo', 'delivery_date', 'delivery_time'];

async function soAudit(conn, soId, userId, fieldName, oldValue, newValue) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('SalesOrder', ?, 'Updated', ?, ?, ?, ?)`,
    [soId, String(fieldName).slice(0, 150), oldValue == null ? null : String(oldValue).slice(0, 2000), newValue == null ? null : String(newValue).slice(0, 2000), userId]);
}

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'SalesOrder' AND a.auditable_id = ? ORDER BY a.set_at DESC, a.id DESC`, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.put('/:id', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!(await isSystemAdmin(req.user.id))) return res.status(403).json({ error: 'Only a System Admin can edit a Sales Order.' });
    const [[so]] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [req.params.id]);
    if (!so) return res.status(404).json({ error: 'Not found' });
    if (String(so.status || '').toLowerCase().includes('cancel')) return res.status(409).json({ error: 'This Sales Order is cancelled.' });
    const b = req.body || {};
    const blank = (v) => (v === '' || v === undefined ? null : v);
    const day = (v) => (v == null || v === '' ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
    const r2 = (v) => Number((Number(v) || 0).toFixed(2));
    const r4 = (v) => Number((Number(v) || 0).toFixed(4));

    const [oldLines] = await conn.query('SELECT * FROM sales_order_lines WHERE sales_order_id = ? ORDER BY line_no', [req.params.id]);
    const byId = new Map(oldLines.map((l) => [Number(l.id), l]));
    const sent = Array.isArray(b.lines) ? b.lines : [];
    for (const l of sent) if (!byId.has(Number(l.id))) return res.status(400).json({ error: 'A line does not belong to this Sales Order.' });
    const taxIds = [...new Set(sent.map((l) => Number(l.tax_code_id)).filter(Boolean))];
    const [taxRows] = taxIds.length ? await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxIds]) : [[]];
    const rate = new Map(taxRows.map((t) => [Number(t.id), Number(t.rate)]));

    await conn.beginTransaction();
    // header
    const head = {};
    for (const f of SO_HEADER_EDIT) head[f] = b[f] === undefined ? so[f] : blank(b[f]);
    head.date_created = day(head.date_created) || day(so.date_created);
    await conn.query(`UPDATE sales_orders SET ${SO_HEADER_EDIT.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...SO_HEADER_EDIT.map((f) => head[f]), req.params.id]);
    for (const f of SO_HEADER_EDIT) {
      const was = f.includes('date') ? day(so[f]) : so[f];
      if (String(was ?? '') !== String(head[f] ?? '')) await soAudit(conn, req.params.id, req.user.id, f, was, head[f]);
    }
    // lines
    let qtyChanged = false; let pricingChanged = false;
    for (const l of sent) {
      const old = byId.get(Number(l.id));
      const v = {};
      for (const f of SO_LINE_EDIT) v[f] = l[f] === undefined ? old[f] : blank(l[f]);
      v.delivery_date = day(v.delivery_date);
      const qty = Number(v.quantity) || 0;
      if (Math.abs(qty - Number(old.quantity || 0)) > 0.00005) qtyChanged = true;
      if (qty <= 0) throw Object.assign(new Error(`Line ${old.line_no}: quantity must be more than 0.`), { status: 400 });
      // Amounts are recomputed ONLY when a pricing input changed (qty, price, per-piece discount, tax
      // code). Migrated lines often do not reconcile (a tax-inclusive Price/Unit, no tax code), so
      // rewriting them on a memo-only save would silently move money.
      const oldPerPiece = Number(old.quantity) ? Number(old.disc_amount || 0) / Number(old.quantity) : 0;
      const linePricing = Math.abs(qty - Number(old.quantity || 0)) > 0.00005
        || Math.abs(Number(v.price_per_unit || 0) - Number(old.price_per_unit || 0)) > 0.00005
        || (l.disc_per_piece !== undefined && Math.abs(Number(l.disc_per_piece || 0) - oldPerPiece) > 0.0001)
        || String(v.tax_code_id ?? '') !== String(old.tax_code_id ?? '');
      if (linePricing) pricingChanged = true;
      const price = r4(v.price_per_unit);
      const subtotal = r2(qty * price);
      const perPiece = l.disc_per_piece === undefined ? (Number(old.quantity) ? Number(old.disc_amount || 0) / Number(old.quantity) : 0) : Number(l.disc_per_piece) || 0;
      const discAmount = r2(perPiece * qty);
      const net = r2(subtotal - discAmount);
      const taxRate = v.tax_code_id ? (rate.get(Number(v.tax_code_id)) ?? 0) : 0;
      const taxAmount = r2(net * taxRate / 100);
      // GP keeps the line's cost as it was: cost = old net - old GP.
      const cost = Number(old.net_of_tax || 0) - Number(old.gp_amount || 0);
      const amounts = {
        price_per_unit: price, subtotal, disc_amount: discAmount, disc_percent: subtotal ? r2(discAmount / subtotal * 100) : 0,
        disc_price_per_unit: r4(net / qty), net_of_tax: net, tax_amount: taxAmount, gross_amount: r2(net + taxAmount),
        gp_amount: old.gp_amount == null ? null : r2(net - cost), gp_rate: old.gp_amount == null ? old.gp_rate : (net ? r2((net - cost) / net * 100) : null),
      };
      const cols = linePricing ? { ...v, ...amounts } : v;
      await conn.query(`UPDATE sales_order_lines SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...Object.values(cols), old.id]);
      for (const [k, nv] of Object.entries(cols)) {
        const ov = k.includes('date') ? day(old[k]) : old[k];
        const same = typeof nv === 'number' ? Math.abs(Number(ov || 0) - nv) < 0.00005 : String(ov ?? '') === String(nv ?? '');
        if (!same) await soAudit(conn, req.params.id, req.user.id, `line ${old.line_no} · ${k}`, ov, nv);
      }
      if (old.job_order_id) {
        await conn.query('UPDATE job_orders SET quantity = ?, description = ?, job_location_id = ?, updated_at = NOW() WHERE id = ?', [qty, v.description, v.job_location_id, old.job_order_id]);
      }
    }
    // header totals from the lines as they now stand -- only when some line's pricing changed
    if (pricingChanged) {
    const [[t]] = await conn.query(
      `SELECT COALESCE(SUM(subtotal),0) sub, COALESCE(SUM(disc_amount),0) disc, COALESCE(SUM(net_of_tax),0) net,
              COALESCE(SUM(tax_amount),0) tax, COALESCE(SUM(gross_amount),0) gross, COALESCE(SUM(gp_amount),0) gp
         FROM sales_order_lines WHERE sales_order_id = ?`, [req.params.id]);
    await conn.query(
      `UPDATE sales_orders SET subtotal = ?, discount_total = ?, net_of_tax = ?, tax_total = ?, total_amount = ?,
              est_gp_amount = ?, est_gp_rate = ? WHERE id = ?`,
      [r2(t.sub), r2(t.disc), r2(t.net), r2(t.tax), r2(t.gross), r2(t.gp), Number(t.net) ? r2(t.gp / t.net * 100) : null, req.params.id]);
    if (Math.abs(Number(so.total_amount || 0) - r2(t.gross)) > 0.005) await soAudit(conn, req.params.id, req.user.id, 'total_amount', so.total_amount, r2(t.gross));
    }
    // Status only when a quantity changed: migrated JOs carry no invoiced qty, so recomputing an old
    // billed order's status from them would wrongly reopen it.
    const [statusLines] = await conn.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
         FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [req.params.id]);
    if (qtyChanged && statusLines.some((l) => l.job_order_id)) {
      await conn.query('UPDATE sales_orders SET status = ? WHERE id = ?', [computeSalesOrderStatus(statusLines), req.params.id]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

// Mirrors the real system's "Create JO" cell on a Sales Order line: turns that line
// into a Job Order (a deliberately minimal production-record stand-in, not the full
// production/QI/delivery/invoicing pipeline the real system has behind it).
// Creating a JO from a line is an "add" (a sales rep forwarding their order to production),
// not an edit of the sales order -- gate it on can_add, which sales accounts have.
router.post('/:id/lines/:lineId/create-jo', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[so]] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [req.params.id]);
    const [[line]] = await conn.query(
      'SELECT * FROM sales_order_lines WHERE id = ? AND sales_order_id = ?',
      [req.params.lineId, req.params.id]
    );
    if (!so || !line) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    if (line.job_order_id) {
      await conn.rollback();
      return res.status(409).json({ error: 'This line already has a Job Order' });
    }

    // Job Order number: JO-<soNumber>-<sequence>-<totalLines> -- sequence is this line's position,
    // total is how many lines the SO has (so JO-63615-2-3 reads "line 2 of 3").
    const soNumericPart = so.sales_order_no.replace(/\D/g, '');
    const [[lineCount]] = await conn.query('SELECT COUNT(*) AS n FROM sales_order_lines WHERE sales_order_id = ?', [so.id]);
    const jobOrderNo = `JO-${soNumericPart}-${line.line_no}-${lineCount.n}`;
    const [result] = await conn.query(
      // delivery_date/delivery_time come across with the rest of the line: production schedules
      // against them (scheduledJobOrders, and the dashboard's COALESCE(delivery_date,
      // planned_start_at) window), so a JO created without them loses the date Sales committed
      // to and silently falls back to planned dates.
      `INSERT INTO job_orders
         (job_order_no, sales_order_line_id, sales_order_id, job_type_id, job_location_id, description, quantity, units,
          length, width, height, memo, contact_email, contact_title, contact_phone, shipping_address, sales_rep_id,
          delivery_date, delivery_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobOrderNo, line.id, req.params.id, line.job_type_id, line.job_location_id, line.description, line.quantity, line.units,
        line.length, line.width, line.height, line.memo,
        so.contact_email, so.contact_title, so.contact_phone, so.shipping_address, so.sales_rep_id,
        line.delivery_date, line.delivery_time]
    );
    const jobOrderId = result.insertId;
    await conn.query('UPDATE sales_order_lines SET job_order_id = ? WHERE id = ?', [jobOrderId, line.id]);

    // Copy the originating estimate process line's cost breakdown into the Job Order's
    // own Materials/Processes tabs -- this is where that data actually gets consumed
    // downstream, since Sales Order lines themselves stay flat (no nested process rows).
    if (line.estimate_job_order_id) {
      const [processes] = await conn.query(
        'SELECT * FROM estimate_job_order_processes WHERE estimate_job_order_id = ? ORDER BY line_no',
        [line.estimate_job_order_id]
      );
      for (const p of processes) {
        await conn.query(
          `INSERT INTO job_order_processes
             (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, length, width, uom,
              qty, total, unit, remarks, memo, process_cost, material_cost, total_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [jobOrderId, p.line_no, p.process_id, p.process_qty, p.process_uom, p.category, p.parts, p.item_id, p.length, p.width,
            p.uom, p.qty, p.total, p.unit, p.remarks, p.memo, p.process_cost, p.material_cost, p.total_cost]
        );
      }
    }

    // The first line getting a JO moves the whole order out of "Pending for JO".
    await conn.query(
      "UPDATE sales_orders SET status = 'jo_in_process', updated_at = NOW() WHERE id = ? AND status = 'pending_for_jo'",
      [req.params.id]
    );
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Created', 'status', NULL, ?, ?)`,
      [jobOrderId, 'Planned - Pending for BOM', req.user.id]
    );
    await conn.commit();
    const [[jobOrder]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [jobOrderId]);
    res.status(201).json(jobOrder);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------------------
// Attachments carried over from the originating estimate
// ---------------------------------------------------------------------------------------
//
// The PO, conforme or proof of payment someone scanned onto the estimate is the same
// document the order is worked against, so it is exposed here rather than making whoever
// opens the Sales Order navigate back to the estimate to find it. The rows are read-only
// on this side: the files belong to the estimate, and letting an order add or delete them
// would leave the two screens disagreeing about what was actually submitted.
//
// Gated on the Sales Order's own can_view (not the estimate's) -- someone who can see the
// order is entitled to the paperwork behind it, and plenty of order-side accounts have no
// estimate permission at all.
async function estimateIdForSalesOrder(req) {
  const [[so]] = await pool.query('SELECT id, estimate_id, sales_rep_id FROM sales_orders WHERE id = ?', [req.params.id]);
  if (!so) return null;
  // Same defense in depth as the detail route -- a scoped user must not reach another rep's
  // paperwork by pasting an id.
  const scope = await getSalesRepEmployeeScope(req.user.id);
  if (scope && !scope.includes(so.sales_rep_id)) return null;
  return so.estimate_id;
}

// Both the estimate's files and the order's own, each tagged with where it came from -- the
// screen shows them in one list, and `source` is what tells it which file route to open and
// whether the row may be removed.
router.get('/:id/attachments', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const so = await salesOrderForAttachment(req);
    if (!so) return res.status(404).json({ error: 'Not found' });

    // A sales order with no estimate behind it (imported or non-standard) simply has none.
    const [inherited] = so.estimate_id ? await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, u.display_name AS uploaded_by_name
         FROM estimate_attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.estimate_id = ? ORDER BY a.id`,
      [so.estimate_id],
    ) : [[]];

    const [own] = await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, u.display_name AS uploaded_by_name
         FROM sales_order_attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.sales_order_id = ? ORDER BY a.id`,
      [req.params.id],
    );

    res.json({
      canManage: so.canManage,
      attachments: [
        ...inherited.map((r) => ({ ...r, source: 'estimate' })),
        ...own.map((r) => ({ ...r, source: 'order' })),
      ],
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------
// The order's own attachments
// ---------------------------------------------------------------------------------------
//
// An order picks up documents after it is raised -- a revised PO, a signed conforme, a
// delivery instruction. Those belong to the order, not to the estimate behind it, so they
// live in their own table and are listed alongside the inherited ones with a source marker.
//
// Gated on can_add rather than can_edit: Sales holds can_add on /sales-orders but not
// can_edit, and the reps who own these orders are exactly who needs to attach to them.
// Adding paperwork is also genuinely an add, not an edit of the order.
const SO_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const SO_ATTACHMENT_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|tiff))$/i;

// The order, plus whether this user owns it. Ownership is the rep the order is booked
// under -- "the owner of the sales order" -- resolved through the acting user's employee_id.
async function salesOrderForAttachment(req) {
  const [[so]] = await pool.query(
    'SELECT id, estimate_id, sales_rep_id FROM sales_orders WHERE id = ?', [req.params.id]
  );
  if (!so) return null;
  const scope = await getSalesRepEmployeeScope(req.user.id);
  if (scope && !scope.includes(so.sales_rep_id)) return null;

  const [[me]] = await pool.query('SELECT employee_id, account_type FROM users WHERE id = ?', [req.user.id]);
  // scope === null means no visibility rule applies to this account (System Admin and the
  // non-sales roles) -- those can manage the order's files the same as its owner can.
  const isOwner = !!me?.employee_id && Number(me.employee_id) === Number(so.sales_rep_id);
  return { ...so, isOwner, canManage: isOwner || scope === null };
}

router.post('/:id/order-attachments', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const so = await salesOrderForAttachment(req);
    if (!so) return res.status(404).json({ error: 'Not found' });
    if (!so.canManage) {
      return res.status(403).json({ error: 'Only the sales order\'s own rep can attach files to it.' });
    }

    const { file_name: fileName, data, mime_type: mimeType } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'file_name and data are required.' });
    if (!SO_ATTACHMENT_TYPES.test(String(mimeType || ''))) {
      return res.status(400).json({ error: 'Only a PDF or an image can be attached.' });
    }

    // Accepts a bare base64 string or a full data: URL, since the browser's FileReader hands
    // back the latter.
    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'data is not valid base64.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > SO_ATTACHMENT_MAX_BYTES) {
      return res.status(413).json({ error: `Attachments must be ${SO_ATTACHMENT_MAX_BYTES / 1024 / 1024}MB or smaller.` });
    }

    const [result] = await pool.query(
      `INSERT INTO sales_order_attachments (sales_order_id, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, String(fileName).slice(0, 255), String(mimeType).slice(0, 100), buf.length, buf, req.user.id]
    );
    const [[row]] = await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, a.uploaded_by_user_id,
              u.display_name AS uploaded_by_name
         FROM sales_order_attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ ...row, source: 'order' });
  } catch (err) { next(err); }
});

router.get('/:id/order-attachments/:attachmentId/file', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const so = await salesOrderForAttachment(req);
    if (!so) return res.status(404).json({ error: 'Not found' });

    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, file_data FROM sales_order_attachments WHERE id = ? AND sales_order_id = ?',
      [req.params.attachmentId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

router.delete('/:id/order-attachments/:attachmentId', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const so = await salesOrderForAttachment(req);
    if (!so) return res.status(404).json({ error: 'Not found' });
    if (!so.canManage) {
      return res.status(403).json({ error: 'Only the sales order\'s own rep can remove its files.' });
    }
    const [result] = await pool.query(
      'DELETE FROM sales_order_attachments WHERE id = ? AND sales_order_id = ?',
      [req.params.attachmentId, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.get('/:id/attachments/:attachmentId/file', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const estimateId = await estimateIdForSalesOrder(req);
    if (!estimateId) return res.status(404).json({ error: 'Not found' });

    // Matched against the estimate id as well as the attachment id, so an attachment on
    // someone else's estimate cannot be pulled through this order's URL.
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, file_data FROM estimate_attachments WHERE id = ? AND estimate_id = ?',
      [req.params.attachmentId, estimateId],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

module.exports = router;
