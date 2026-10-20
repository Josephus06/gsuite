const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// HRD > OBT (asked 2026-10-20; db/add-obt-confirmation.js): every APPROVED Official Business Trip --
// a Forms > Business Trip that cleared its approval -- for HR, who Confirms each one. View on /hrd/obt
// lists them; Update (can_update) confirms. A form only lands here once approved, and a confirmation is recorded once.
const ROUTE = '/hrd/obt';

// Before the migration the confirmation columns do not exist: the list still answers, unconfirmed.
async function hasConfirmCols() {
  const [c] = await pool.query("SHOW COLUMNS FROM form_business_trip_details LIKE 'obt_confirmed_at'");
  return c.length > 0;
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const confirmCols = await hasConfirmCols();
    const status = ['pending', 'confirmed'].includes(req.query.status) ? req.query.status : 'all';
    const where = ["f.type = 'business_trip'", "f.status = 'approved'"];
    if (confirmCols && status === 'pending') where.push('d.obt_confirmed_at IS NULL');
    if (confirmCols && status === 'confirmed') where.push('d.obt_confirmed_at IS NOT NULL');
    if (!confirmCols && status === 'confirmed') where.push('1 = 0');
    const params = [];
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push('(f.request_no LIKE ? OR f.name LIKE ? OR u.display_name LIKE ? OR d.purpose LIKE ? OR d.driver_name LIKE ? OR d.vehicle_plate_no LIKE ?)');
      params.push(...Array(6).fill(`%${q}%`));
    }
    const [rows] = await pool.query(
      `SELECT f.id, f.request_no, f.name, f.department, f.approved_at, u.display_name AS filed_by, ua.display_name AS approved_by_name,
              d.trip_date, d.time_out, d.time_in, d.driver_name, d.vehicle_plate_no, d.total_mileage_km, d.purpose,
              ${confirmCols ? 'd.obt_confirmed_at, uc.display_name AS confirmed_by_name' : 'NULL AS obt_confirmed_at, NULL AS confirmed_by_name'}
         FROM form_requests f
         LEFT JOIN form_business_trip_details d ON d.form_request_id = f.id
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN users ua ON ua.id = f.approved_by
         ${confirmCols ? 'LEFT JOIN users uc ON uc.id = d.obt_confirmed_by_user_id' : ''}
        WHERE ${where.join(' AND ')}
        ORDER BY d.trip_date DESC, f.id DESC
        LIMIT 500`, params);
    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS all_count${confirmCols ? ', SUM(d.obt_confirmed_at IS NULL) AS pending, SUM(d.obt_confirmed_at IS NOT NULL) AS confirmed' : ', COUNT(*) AS pending, 0 AS confirmed'}
         FROM form_requests f LEFT JOIN form_business_trip_details d ON d.form_request_id = f.id
        WHERE f.type = 'business_trip' AND f.status = 'approved'`);
    res.json({
      rows,
      counts: { all: Number(counts.all_count) || 0, pending: Number(counts.pending) || 0, confirmed: Number(counts.confirmed) || 0 },
    });
  } catch (err) { next(err); }
});

router.post('/:id/confirm', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  try {
    if (!(await hasConfirmCols())) return res.status(409).json({ error: 'OBT confirmation is not set up yet (run db/add-obt-confirmation.js).' });
    const [[f]] = await pool.query(
      `SELECT f.id, f.type, f.status, f.request_no, d.obt_confirmed_at FROM form_requests f
         LEFT JOIN form_business_trip_details d ON d.form_request_id = f.id WHERE f.id = ?`, [req.params.id]);
    if (!f || f.type !== 'business_trip') return res.status(404).json({ error: 'Official Business Trip not found.' });
    if (f.status !== 'approved') return res.status(409).json({ error: `${f.request_no} is not approved yet.` });
    if (f.obt_confirmed_at) return res.status(409).json({ error: `${f.request_no} is already confirmed.` });
    await pool.query(
      'UPDATE form_business_trip_details SET obt_confirmed_at = UTC_TIMESTAMP(), obt_confirmed_by_user_id = ? WHERE form_request_id = ?',
      [req.user.id, f.id]);
    // On the form's own history, as routes/forms.js logFormAudit writes it.
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('FormRequest', ?, 'Updated', 'OBT', NULL, 'Confirmed by HR', ?)`, [f.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
