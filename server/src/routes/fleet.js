const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { loadVehicles, withEfficiency } = require('../lib/fleet');
const { sendXlsx } = require('../lib/xlsxExport');

const router = express.Router();

// A bad link (/assets/fleet/null) is a 404, not a database error.
router.param('assetId', (req, res, next, id) => (/^\d+$/.test(String(id)) ? next() : res.status(404).json({ error: 'Vehicle not found.' })));

// Assets > Fleet (Vehicles) (asked 2026-10-19). A vehicle is an asset (Transportation Equipment);
// this is what is tracked on top of it -- registration / insurance / emission, PMS interval and
// odometer, the PMS / maintenance log and the fuel log. Due dates are lib/fleet.js; the daily
// reminders to the General Managers, custodian and in-charge are lib/fleet.js runFleetReminders.
// Repair costs are recorded only -- nothing here posts to the books.
const ROUTE = '/assets/fleet';

const DETAIL_FIELDS = ['plate_no', 'conduction_sticker', 'engine_no', 'chassis_no', 'make', 'model', 'year_model', 'color',
  'fuel_type', 'or_no', 'cr_no', 'registration_date', 'registration_expiry', 'insurer', 'policy_no', 'insurance_expiry',
  'emission_expiry', 'odometer_km', 'odometer_at', 'pms_interval_km', 'pms_interval_months', 'driver_employee_id',
  'incharge_employee_id', 'remarks'];
const SERVICE_TYPES = ['PMS', 'Repair', 'Tires', 'Battery', 'Change Oil', 'Body / Paint', 'Electrical', 'Aircon', 'Other'];
const blank = (v) => (v === '' || v === undefined ? null : v);
const trunc = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

async function assetExists(id) {
  const [[a]] = await pool.query('SELECT id FROM assets WHERE id = ?', [id]);
  return !!a;
}

// A log's reading moves the vehicle's odometer forward, never back.
async function bumpOdometer(assetId, km, onDate) {
  if (km == null) return;
  await pool.query(
    `INSERT INTO vehicle_details (asset_id, odometer_km, odometer_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE odometer_at = IF(odometer_km IS NULL OR VALUES(odometer_km) > odometer_km, VALUES(odometer_at), odometer_at),
                             odometer_km = GREATEST(COALESCE(odometer_km, 0), VALUES(odometer_km))`,
    [assetId, km, onDate]);
}

function listFilter(rows, search, status) {
  const q = String(search || '').trim().toLowerCase();
  return rows.filter((v) => {
    if (q && ![v.plate_no, v.make, v.model, v.brand, v.asset_model, v.reference_no, v.engine_no, v.chassis_no, v.custodian_name, v.incharge_name, v.driver_name]
      .some((x) => String(x || '').toLowerCase().includes(q))) return false;
    if (status === 'attention') return Object.values(v.due).some((d) => d.status === 'overdue' || d.status === 'due_soon');
    if (status === 'overdue') return Object.values(v.due).some((d) => d.status === 'overdue');
    return true;
  });
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(listFilter(await loadVehicles(), req.query.search, req.query.status));
  } catch (err) { next(err); }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = listFilter(await loadVehicles(), req.query.search, req.query.status);
    const st = (d) => ({ overdue: 'OVERDUE', due_soon: 'Due soon', ok: 'OK', none: '' }[d.status] || '');
    await sendXlsx(res, {
      filename: 'fleet.xlsx',
      sheet: 'Fleet',
      columns: [
        { header: 'Plate No', key: 'plate', width: 12 }, { header: 'Vehicle', key: 'vehicle', width: 28 },
        { header: 'Asset Ref', key: 'ref', width: 14 }, { header: 'Custodian', key: 'custodian', width: 22 },
        { header: 'In-charge', key: 'incharge', width: 22 }, { header: 'Odometer (km)', key: 'odo', width: 13 },
        { header: 'Last PMS', key: 'last_pms', width: 12 }, { header: 'Next PMS (date)', key: 'next_date', width: 14 },
        { header: 'Next PMS (km)', key: 'next_km', width: 13 }, { header: 'PMS', key: 'pms', width: 10 },
        { header: 'Registration Expiry', key: 'reg', width: 16 }, { header: 'Registration', key: 'reg_st', width: 12 },
        { header: 'Insurance Expiry', key: 'ins', width: 15 }, { header: 'Insurance', key: 'ins_st', width: 11 },
        { header: 'Emission Expiry', key: 'emi', width: 14 }, { header: 'Emission', key: 'emi_st', width: 10 },
      ],
      rows: rows.map((v) => ({
        plate: v.plate_no || '', vehicle: [v.make || v.brand, v.model || v.asset_model, v.year_model].filter(Boolean).join(' '),
        ref: v.reference_no || '', custodian: v.custodian_name || '', incharge: v.incharge_name || '',
        odo: v.current_odometer_km, last_pms: v.last_pms_date || '', next_date: v.next_pms_date || '', next_km: v.next_pms_km,
        pms: st(v.due.pms), reg: v.registration_expiry || '', reg_st: st(v.due.registration),
        ins: v.insurance_expiry || '', ins_st: st(v.due.insurance), emi: v.emission_expiry || '', emi_st: st(v.due.emission),
      })),
    });
  } catch (err) { next(err); }
});

// Employees for the Driver / In-charge pickers; Technical Department first, as the in-charge is
// meant to come from there.
router.get('/options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [employees] = await pool.query(
      `SELECT e.id, CONCAT_WS(' ', e.first_name, e.last_name) AS name, d.name AS department,
              (d.name LIKE '%Technical%') AS is_technical
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.is_active = 1 ORDER BY is_technical DESC, name`).catch(async (e) => {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      return pool.query(
        `SELECT e.id, CONCAT_WS(' ', e.first_name, e.last_name) AS name, d.name AS department, (d.name LIKE '%Technical%') AS is_technical
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id ORDER BY is_technical DESC, name`);
    });
    res.json({ employees, service_types: SERVICE_TYPES });
  } catch (err) { next(err); }
});

router.get('/:assetId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const id = Number(req.params.assetId);
    const [vehicle] = await loadVehicles(pool, id);
    if (!vehicle) {
      if (!(await assetExists(id))) return res.status(404).json({ error: 'Not found' });
      // An asset of another class, not a vehicle yet -- saving details makes it one.
      const [[a]] = await pool.query('SELECT id AS asset_id, reference_no, brand, model AS asset_model FROM assets WHERE id = ?', [id]);
      return res.json({ ...a, is_new: true, due: null, service_logs: [], fuel_logs: [] });
    }
    const [service] = await pool.query(
      `SELECT l.*, u.display_name AS created_by_name FROM vehicle_service_logs l LEFT JOIN users u ON u.id = l.created_by_user_id
        WHERE l.asset_id = ? ORDER BY l.service_date DESC, l.id DESC`, [id]);
    const [fuel] = await pool.query(
      `SELECT f.*, CONCAT_WS(' ', e.first_name, e.last_name) AS driver_name, u.display_name AS created_by_name
         FROM vehicle_fuel_logs f LEFT JOIN employees e ON e.id = f.driver_employee_id LEFT JOIN users u ON u.id = f.created_by_user_id
        WHERE f.asset_id = ? ORDER BY f.fuel_date DESC, f.id DESC`, [id]);
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
    const fuelLogs = withEfficiency(fuel);
    const effs = fuelLogs.map((f) => f.km_per_liter).filter((x) => x != null);
    res.json({
      ...vehicle,
      service_logs: service.map((l) => ({ ...l, service_date: day(l.service_date), next_due_date: day(l.next_due_date) })),
      fuel_logs: fuelLogs,
      fuel_summary: {
        liters: fuelLogs.reduce((s, f) => s + Number(f.liters || 0), 0),
        amount: fuelLogs.reduce((s, f) => s + Number(f.amount || 0), 0),
        avg_km_per_liter: effs.length ? Number((effs.reduce((s, x) => s + x, 0) / effs.length).toFixed(2)) : null,
      },
      service_total: service.reduce((s, l) => s + Number(l.cost || 0), 0),
    });
  } catch (err) { next(err); }
});

router.put('/:assetId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const id = Number(req.params.assetId);
    if (!(await assetExists(id))) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    for (const f of ['registration_date', 'registration_expiry', 'insurance_expiry', 'emission_expiry', 'odometer_at']) {
      if (b[f] && !isDate(b[f])) return res.status(400).json({ error: `${f.replace(/_/g, ' ')} is not a date.` });
    }
    const values = DETAIL_FIELDS.map((f) => {
      if (['year_model', 'pms_interval_months', 'driver_employee_id', 'incharge_employee_id'].includes(f)) return num(b[f]);
      if (['odometer_km', 'pms_interval_km'].includes(f)) return num(b[f]);
      if (f === 'remarks') return blank(b[f]);
      return trunc(blank(b[f]), 120);
    });
    await pool.query(
      `INSERT INTO vehicle_details (asset_id, ${DETAIL_FIELDS.join(', ')}, updated_by_user_id)
       VALUES (?, ${DETAIL_FIELDS.map(() => '?').join(', ')}, ?)
       ON DUPLICATE KEY UPDATE ${DETAIL_FIELDS.map((f) => `${f} = VALUES(${f})`).join(', ')}, updated_by_user_id = VALUES(updated_by_user_id)`,
      [id, ...values, req.user.id]);
    const [vehicle] = await loadVehicles(pool, id);
    res.json(vehicle);
  } catch (err) { next(err); }
});

router.post('/:assetId/service', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const id = Number(req.params.assetId);
    if (!(await assetExists(id))) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (!isDate(b.service_date)) return res.status(400).json({ error: 'Service date is required.' });
    const type = SERVICE_TYPES.includes(b.service_type) ? b.service_type : 'Other';
    const isPms = b.is_pms !== undefined ? !!b.is_pms : type === 'PMS';
    if (b.next_due_date && !isDate(b.next_due_date)) return res.status(400).json({ error: 'Next due date is not a date.' });
    const [r] = await pool.query(
      `INSERT INTO vehicle_service_logs (asset_id, service_date, odometer_km, service_type, is_pms, work_done, shop, cost, reference_no,
         next_due_date, next_due_km, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, b.service_date, num(b.odometer_km), type, isPms ? 1 : 0, blank(b.work_done), trunc(b.shop, 120), num(b.cost),
        trunc(b.reference_no, 60), blank(b.next_due_date), num(b.next_due_km), req.user.id]);
    await bumpOdometer(id, num(b.odometer_km), b.service_date);
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.delete('/:assetId/service/:logId', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM vehicle_service_logs WHERE id = ? AND asset_id = ?', [req.params.logId, req.params.assetId]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.post('/:assetId/fuel', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const id = Number(req.params.assetId);
    if (!(await assetExists(id))) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (!isDate(b.fuel_date)) return res.status(400).json({ error: 'Date is required.' });
    const liters = num(b.liters);
    if (!(liters > 0)) return res.status(400).json({ error: 'Litres must be more than 0.' });
    const price = num(b.price_per_liter);
    const amount = num(b.amount) ?? (price != null ? Number((price * liters).toFixed(2)) : null);
    const [r] = await pool.query(
      `INSERT INTO vehicle_fuel_logs (asset_id, fuel_date, odometer_km, liters, price_per_liter, amount, is_full_tank, station,
         driver_employee_id, receipt_no, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, b.fuel_date, num(b.odometer_km), liters, price, amount, b.is_full_tank === false ? 0 : 1, trunc(b.station, 120),
        num(b.driver_employee_id), trunc(b.receipt_no, 60), req.user.id]);
    await bumpOdometer(id, num(b.odometer_km), b.fuel_date);
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.delete('/:assetId/fuel/:logId', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM vehicle_fuel_logs WHERE id = ? AND asset_id = ?', [req.params.logId, req.params.assetId]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
