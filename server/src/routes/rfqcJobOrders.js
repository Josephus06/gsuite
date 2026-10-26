const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');
const { countOpenRework } = require('../lib/reworkJobOrder');
const { listRows, filterOptions, sendExtract } = require('../lib/reworkJobOrderList');

const router = express.Router();
const ROUTE = '/rfqc-job-orders';

// RFQC (rework-from-quality-check) job orders -- raised during Quality Inspection for the RMA (failed/damaged) qty; approved/built/inspected from the JO view.
// Browse, and Cancel (System Admin, below). Filters and Extract are shared with the other rework list (lib/reworkJobOrderList.js).
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await listRows(req, 'RFQC')); } catch (err) { next(err); }
});

router.get('/filter-options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await filterOptions(req, 'RFQC')); } catch (err) { next(err); }
});

// Extract: every RFQC under the list's current filters, as a workbook.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    await sendExtract(res, await listRows(req, 'RFQC'), 'RFQC');
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// Cancel an RFQC (asked 2026-10-26). The same rules as cancelling a Sales Order's Job Order: a System
// Admin, a Cancellation reason, and refused once it is Completed or has been billed or delivered. A
// cancelled RFQC no longer counts as open rework (lib/reworkJobOrder.js countOpenRework), so its
// mother JO's stage is re-evaluated: Completed if everything ordered has passed and nothing else is open.
router.get('/cancel-reasons', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM reasons WHERE reason_type = 'Cancellation' AND is_active = TRUE ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
});

router.put('/:id/cancel', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!(await isSystemAdmin(req.user.id))) return res.status(403).json({ error: 'Only a System Admin can cancel an RFQC.' });
    const reasonId = Number(req.body?.reason_id) || null;
    const remarks = String(req.body?.remarks || '').trim().slice(0, 500) || null;
    const [[jo]] = await conn.query(
      'SELECT id, job_order_no, status, production_stage, parent_job_order_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo || !String(jo.job_order_no || '').startsWith('RFQC-')) return res.status(404).json({ error: 'RFQC not found.' });
    if (jo.status === 'Cancelled') return res.status(409).json({ error: `${jo.job_order_no} is already cancelled.` });
    if (jo.status === 'Completed' || ['completed', 'invoiced'].includes(jo.production_stage)) {
      return res.status(409).json({ error: `${jo.job_order_no} is completed and cannot be cancelled.` });
    }
    const [[reason]] = reasonId
      ? await conn.query("SELECT id, name FROM reasons WHERE id = ? AND reason_type = 'Cancellation'", [reasonId])
      : [[null]];
    if (!reason) return res.status(400).json({ error: 'Choose a cancellation reason.' });
    const [invoices] = await conn.query(
      `SELECT DISTINCT si.invoice_no FROM sales_invoice_lines l JOIN sales_invoices si ON si.id = l.sales_invoice_id
        WHERE l.job_order_id = ? AND si.status <> 'cancelled'`, [jo.id]);
    const [tickets] = await conn.query(
      `SELECT DISTINCT dt.dt_no FROM delivery_ticket_lines l JOIN delivery_tickets dt ON dt.id = l.delivery_ticket_id
        WHERE l.job_order_id = ? AND dt.status = 'open'`, [jo.id]);
    const blockers = [...invoices.map((r) => r.invoice_no), ...tickets.map((r) => r.dt_no)];
    if (blockers.length) return res.status(409).json({ error: `${jo.job_order_no} has been billed or delivered (${blockers.slice(0, 6).join(', ')}). Void those first.` });

    await conn.beginTransaction();
    await conn.query("UPDATE job_orders SET status = 'Cancelled', updated_at = NOW() WHERE id = ?", [jo.id]);
    const note = `cancelled -- ${reason.name}${remarks ? `: ${remarks}` : ''}`.slice(0, 2000);
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Cancelled', 'status', ?, ?, ?)`, [jo.id, jo.status, note, req.user.id]);
    if (jo.parent_job_order_id) {
      const [[mom]] = await conn.query('SELECT id, job_order_no, quantity, quantity_inspected, production_stage FROM job_orders WHERE id = ?', [jo.parent_job_order_id]);
      if (mom && mom.production_stage === 'partially_completed') {
        const open = await countOpenRework(conn, mom.id);
        if (open === 0 && Number(mom.quantity_inspected || 0) >= Number(mom.quantity || 0)) {
          await conn.query("UPDATE job_orders SET production_stage = 'completed', updated_at = NOW() WHERE id = ?", [mom.id]);
          await conn.query(
            `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
             VALUES ('JobOrder', ?, 'Updated', 'production_stage', 'partially_completed', ?, ?)`,
            [mom.id, `completed (${jo.job_order_no} cancelled)`, req.user.id]);
        }
      }
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('JobOrder', ?, 'Updated', ?, ?, ?, ?)`,
        [jo.parent_job_order_id, `rework ${jo.job_order_no}`, jo.status, note, req.user.id]);
    }
    await conn.commit();
    res.json({ ok: true, job_order_no: jo.job_order_no });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
