const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/assembly-builds';

async function logAudit(conn, { assemblyBuildId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('AssemblyBuild', ?, ?, ?, ?, ?, ?)`,
    [assemblyBuildId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Mirrors the real system's "Production > Assembly Build" ("Saved Assembly Build")
// list -- a flat table (no status tabs) with a filter panel, same pattern as the
// Job Orders list.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      search, sales_rep_id: salesRepId, job_location_id: jobLocationId, customer_id: customerId,
      as_of: asOf, page = '1', limit = '10',
    } = req.query;

    const where = [];
    const params = [];
    if (salesRepId) { where.push('so.sales_rep_id = ?'); params.push(salesRepId); }
    if (jobLocationId) { where.push('jo.job_location_id = ?'); params.push(jobLocationId); }
    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
    if (asOf) { where.push('ab.date_created <= ?'); params.push(asOf); }
    if (search) {
      where.push('(ab.ab_no LIKE ? OR jo.job_order_no LIKE ? OR c.name LIKE ? OR jo.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM assembly_builds ab
       JOIN job_orders jo ON jo.id = ab.job_order_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT ab.id, ab.ab_no, ab.date_created, ab.quantity_built, ab.status,
              jo.job_order_no, jo.description AS job_desc, loc.location_name AS job_location_name,
              jt.display_name AS job_type_name, c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name
       ${baseFrom} ${whereSql}
       ORDER BY ab.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ab]] = await pool.query(
      `SELECT ab.*, jo.job_order_no, jo.description AS job_desc, jo.quantity, jo.units, jo.quantity_inspected,
              jo.length, jo.width, jo.height, jo.memo AS jo_memo,
              loc.location_name AS job_location_name, jt.display_name AS job_type_name,
              c.name AS customer_name, cc.contact_name,
              so.contact_email, so.contact_title, so.contact_phone,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(cu.first_name, ' ', cu.last_name) AS created_by_name
       FROM assembly_builds ab
       JOIN job_orders jo ON jo.id = ab.job_order_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN users cbu ON cbu.id = ab.created_by_user_id
       LEFT JOIN employees cu ON cu.id = cbu.employee_id
       WHERE ab.id = ?`,
      [req.params.id]
    );
    if (!ab) return res.status(404).json({ error: 'Not found' });

    const [processes] = await pool.query(
      `SELECT abl.*, pr.process_name, i.display_name AS item_name, loc.location_name
       FROM assembly_build_lines abl
       LEFT JOIN processes pr ON pr.id = abl.process_id
       LEFT JOIN inventories i ON i.id = abl.item_id
       LEFT JOIN locations loc ON loc.id = abl.location_id
       WHERE abl.assembly_build_id = ?
       ORDER BY abl.id`,
      [req.params.id]
    );

    res.json({ ...ab, processes });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'AssemblyBuild' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Reverses the build: adds the deducted material back to on-hand and subtracts what
// this transaction contributed from each process line's Total Built and the JO's
// overall Qty Built. Can't be reversed twice.
router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ab]] = await conn.query('SELECT status, job_order_id, quantity_built FROM assembly_builds WHERE id = ?', [req.params.id]);
    if (!ab) { return res.status(404).json({ error: 'Not found' }); }
    if (ab.status === 'cancelled') { return res.status(409).json({ error: 'This Assembly Build is already cancelled.' }); }

    const [lines] = await conn.query(
      'SELECT job_order_process_id, item_id, location_id, total_qty_to_build FROM assembly_build_lines WHERE assembly_build_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.item_id && l.location_id) {
        await conn.query(
          'UPDATE inventory_locations SET qty_on_hand = qty_on_hand + ? WHERE inventory_id = ? AND location_id = ?',
          [l.total_qty_to_build, l.item_id, l.location_id]
        );
        await conn.query('UPDATE job_order_processes SET total_built = total_built - ? WHERE id = ?', [l.total_qty_to_build, l.job_order_process_id]);
      }
    }
    await conn.query('UPDATE job_orders SET quantity_built = quantity_built - ?, updated_at = NOW() WHERE id = ?', [ab.quantity_built, ab.job_order_id]);
    await conn.query(
      "UPDATE assembly_builds SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { assemblyBuildId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'saved', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM assembly_builds WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
