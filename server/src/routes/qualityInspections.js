const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');

const router = express.Router();
// Reached from a Job Order's Production view, not its own page in the nav -- reuses
// Production's permission scope rather than registering a whole new page entry, same
// treatment as Item Fulfillment/Item Receipt reusing Transfer Orders' scope.
const ROUTE = '/production';

async function logAudit(conn, { qiId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('QualityInspection', ?, ?, ?, ?, ?, ?)`,
    [qiId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Mirrors the real system's "Production > Quality Inspection" ("Saved Quality
// Inspection") list -- a flat filterable table (no status tabs), same pattern as
// Assembly Build's list.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      search, job_location_id: jobLocationId, customer_id: customerId, as_of: asOf, page = '1', limit = '10',
    } = req.query;

    const where = [];
    const params = [];
    if (jobLocationId) { where.push('jo.job_location_id = ?'); params.push(jobLocationId); }
    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
    if (asOf) { where.push('qi.date_created <= ?'); params.push(asOf); }
    if (search) {
      where.push('(qi.qi_no LIKE ? OR jo.job_order_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM quality_inspections qi
       JOIN job_orders jo ON jo.id = qi.job_order_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT qi.id, qi.qi_no, qi.date_created, qi.status, jo.job_order_no, loc.location_name AS job_location_name, c.name AS customer_name,
              (SELECT COALESCE(SUM(pass_qty), 0) FROM quality_inspection_lines WHERE quality_inspection_id = qi.id) AS total_pass_qty,
              (SELECT COALESCE(SUM(rma_qty), 0) FROM quality_inspection_lines WHERE quality_inspection_id = qi.id) AS total_rma_qty
       ${baseFrom} ${whereSql}
       ORDER BY qi.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

// Powers the Quality Inspection create modal's header + Assembly Build table -- only
// batches with something still uninspected (quantity_built - passed_qty - rma_qty > 0)
// show up, matching the real screen only ever listing what's actually left to inspect.
router.get('/for-job-order/:jobOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[jo]] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.quantity_built, jo.quantity_inspected, jo.units,
              jt.display_name AS job_type_name, loc.location_name AS job_location_name,
              c.name AS customer_name
       FROM job_orders jo
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       WHERE jo.id = ?`,
      [req.params.jobOrderId]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });

    const [builds] = await pool.query(
      `SELECT id, ab_no, date_created, quantity_built, passed_qty, rma_qty
       FROM assembly_builds
       WHERE job_order_id = ? AND status != 'cancelled' AND (quantity_built - passed_qty - rma_qty) > 0
       ORDER BY id`,
      [req.params.jobOrderId]
    );

    res.json({ ...jo, assembly_builds: builds });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[qi]] = await pool.query(
      `SELECT qi.*, jo.job_order_no, jo.quantity AS jo_quantity, jo.quantity_built, jo.quantity_inspected,
              c.name AS customer_name, cc.contact_name,
              so.contact_email, so.contact_title, so.contact_phone,
              u.display_name AS created_by_name
       FROM quality_inspections qi
       JOIN job_orders jo ON jo.id = qi.job_order_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN users u ON u.id = qi.created_by_user_id
       WHERE qi.id = ?`,
      [req.params.id]
    );
    if (!qi) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT qil.*, ab.ab_no FROM quality_inspection_lines qil
       LEFT JOIN assembly_builds ab ON ab.id = qil.assembly_build_id
       WHERE qil.quality_inspection_id = ?`,
      [req.params.id]
    );

    res.json({ ...qi, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'QualityInspection' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Saving splits each covered Assembly Build's own remaining (uninspected) qty into Pass
// Qty (cleared for delivery) and RMA Qty (kicked back for rework/return) -- both
// accumulate onto that AB's own running totals, and the JO's quantity_inspected tracks
// the sum across every AB. One QI can cover several ABs at once, one line each.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { job_order_id: jobOrderId, date_created: dateCreated, memo, lines } = req.body;
    if (!jobOrderId) return res.status(400).json({ error: 'Job Order is required.' });

    const [[jo]] = await conn.query('SELECT quantity, quantity_inspected, sales_order_id FROM job_orders WHERE id = ?', [jobOrderId]);
    if (!jo) return res.status(404).json({ error: 'Job Order not found.' });

    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.pass_qty || 0) > 0 || Number(l.rma_qty || 0) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Pass Qty or RMA Qty for at least one item.' });

    const [builds] = await conn.query(
      'SELECT id, ab_no, quantity_built, passed_qty, rma_qty FROM assembly_builds WHERE job_order_id = ?',
      [jobOrderId]
    );
    const byId = new Map(builds.map((b) => [b.id, b]));

    for (const s of submitted) {
      const ab = byId.get(Number(s.assembly_build_id));
      if (!ab) return res.status(400).json({ error: 'Unknown Assembly Build.' });
      const remaining = Number(ab.quantity_built) - Number(ab.passed_qty || 0) - Number(ab.rma_qty || 0);
      const submittedQty = Number(s.pass_qty || 0) + Number(s.rma_qty || 0);
      if (submittedQty > remaining) {
        return res.status(409).json({ error: `Pass Qty + RMA Qty for ${ab.ab_no} exceeds the remaining uninspected qty (${remaining}).` });
      }
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO quality_inspections (qi_no, job_order_id, date_created, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?)`,
      [jobOrderId, dateCreated || new Date().toISOString().slice(0, 10), memo || null, req.user.id]
    );
    const qiId = result.insertId;
    await conn.query('UPDATE quality_inspections SET qi_no = ? WHERE id = ?', [`QI-${qiId}`, qiId]);

    let totalInspected = 0;
    for (const s of submitted) {
      const ab = byId.get(Number(s.assembly_build_id));
      const passQty = Number(s.pass_qty || 0);
      const rmaQty = Number(s.rma_qty || 0);
      totalInspected += passQty + rmaQty;

      await conn.query('UPDATE assembly_builds SET passed_qty = passed_qty + ?, rma_qty = rma_qty + ? WHERE id = ?', [passQty, rmaQty, ab.id]);
      await conn.query(
        `INSERT INTO quality_inspection_lines (quality_inspection_id, assembly_build_id, ab_qty, pass_qty, rma_qty, rma_memo, action_to_be_taken)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [qiId, ab.id, ab.quantity_built, passQty, rmaQty, s.rma_memo || null, s.action_to_be_taken || null]
      );
    }
    // A JO's own quantity is only ever "done" once every unit ordered has actually been
    // inspected -- Assembly Build alone doesn't get there (that's just what's been made,
    // not what's cleared). Short of that, it's "Partially Completed"; anything covering
    // every last unit flips it to "Completed".
    const newQuantityInspected = Number(jo.quantity_inspected || 0) + totalInspected;
    const newStage = newQuantityInspected >= Number(jo.quantity || 0) ? 'completed' : 'partially_completed';
    await conn.query(
      'UPDATE job_orders SET quantity_inspected = ?, production_stage = ?, updated_at = NOW() WHERE id = ?',
      [newQuantityInspected, newStage, jobOrderId]
    );
    // Once any one Job Order on the Sales Order has cleared inspection (fully or
    // partially), the order as a whole is ready to start shipping -- doesn't wait for
    // every other line to catch up -- but a Sales Order's status is only ever as
    // advanced as its *least* advanced line, so this recomputes from every line rather
    // than just forward-stamping "Pending Delivery" off this one qualifying JO.
    if (jo.sales_order_id) {
      const [[so]] = await conn.query('SELECT status FROM sales_orders WHERE id = ?', [jo.sales_order_id]);
      if (so && so.status !== 'cancelled') {
        const [soLines] = await conn.query(
          `SELECT sol.job_order_id, sol.quantity, j.quantity_built, j.quantity_inspected, j.quantity_delivered, j.quantity_invoiced
           FROM sales_order_lines sol LEFT JOIN job_orders j ON j.id = sol.job_order_id
           WHERE sol.sales_order_id = ?`,
          [jo.sales_order_id]
        );
        const newSoStatus = computeSalesOrderStatus(soLines);
        if (newSoStatus !== so.status) {
          await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newSoStatus, jo.sales_order_id]);
        }
      }
    }
    await logAudit(conn, { qiId, userId: req.user.id, eventType: 'Created', fieldName: 'qi_no', newValue: `QI-${qiId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM quality_inspections WHERE id = ?', [qiId]);
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
    const [[qi]] = await conn.query('SELECT status, job_order_id FROM quality_inspections WHERE id = ?', [req.params.id]);
    if (!qi) return res.status(404).json({ error: 'Not found' });
    if (qi.status === 'cancelled') return res.status(409).json({ error: 'This Quality Inspection is already cancelled.' });

    const [lines] = await conn.query('SELECT assembly_build_id, pass_qty, rma_qty FROM quality_inspection_lines WHERE quality_inspection_id = ?', [req.params.id]);
    const [[jo]] = await conn.query('SELECT quantity, quantity_inspected FROM job_orders WHERE id = ?', [qi.job_order_id]);

    await conn.beginTransaction();
    let totalInspected = 0;
    for (const l of lines) {
      await conn.query('UPDATE assembly_builds SET passed_qty = passed_qty - ?, rma_qty = rma_qty - ? WHERE id = ?', [l.pass_qty, l.rma_qty, l.assembly_build_id]);
      totalInspected += Number(l.pass_qty) + Number(l.rma_qty);
    }
    // Mirrors the stage logic in POST / -- reversed. Back to 0 inspected means back to
    // needing inspection at all (For QI); still some left over just downgrades from
    // Completed to Partially Completed rather than resetting all the way.
    const newQuantityInspected = Math.max(Number(jo.quantity_inspected || 0) - totalInspected, 0);
    const newStage = newQuantityInspected <= 0
      ? 'for_qi'
      : (newQuantityInspected >= Number(jo.quantity || 0) ? 'completed' : 'partially_completed');
    await conn.query(
      'UPDATE job_orders SET quantity_inspected = ?, production_stage = ?, updated_at = NOW() WHERE id = ?',
      [newQuantityInspected, newStage, qi.job_order_id]
    );
    await conn.query(
      "UPDATE quality_inspections SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { qiId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'saved', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM quality_inspections WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
