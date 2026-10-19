const pool = require('../db');

// Assets > Fleet (2026-10-19). What is due on each vehicle, worked out in one place so the Fleet
// page, the vehicle's own page and the daily reminders (scheduleFleetReminders) cannot disagree.
//
//   odometer      the highest reading anywhere: the vehicle's own, its last service, its last fill-up
//   last PMS      the latest service log ticked PMS
//   next PMS      that log's own Next Due, else last PMS + the vehicle's interval -- by date (months)
//                 and/or by km, whichever the vehicle has; due at whichever comes first
//   registration / insurance / emission   their expiry dates
//
// Each item reads: overdue (past it), due_soon (within DUE_SOON_DAYS, or DUE_SOON_KM for a km
// reading), ok, or none (nothing recorded to judge by).

const DUE_SOON_DAYS = 30;
const DUE_SOON_KM = 500;
const ISO = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

function todayPh() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function addMonths(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  return ISO(d);
}
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

function dateStatus(due, today) {
  if (!due) return { status: 'none', due: null, days_left: null };
  const left = daysBetween(today, due);
  return { status: left < 0 ? 'overdue' : left <= DUE_SOON_DAYS ? 'due_soon' : 'ok', due, days_left: left };
}

// The vehicles: every asset whose Asset Type is named or categorised as one (VEHICLE, Motorcycle, Truck,
// Van, Car; Category Vehicle / Transportation -- what the New
// Asset form sets -- its class is only given when Accounting capitalises it), every asset in a
// Transportation Equipment class, and any other asset given vehicle details. `assetId` narrows it to one.
async function loadVehicles(q = pool, assetId = null) {
  const [rows] = await q.query(
    `SELECT a.id AS asset_id, a.reference_no, a.tag_no, a.brand, a.model AS asset_model, a.serial_no, a.status AS asset_status,
            a.custodian_employee_id, ac.name AS asset_class,
            CONCAT_WS(' ', ce.first_name, ce.last_name) AS custodian_name,
            ai.display_name AS asset_name,
            v.*,
            CONCAT_WS(' ', de.first_name, de.last_name) AS driver_name,
            CONCAT_WS(' ', ie.first_name, ie.last_name) AS incharge_name
       FROM assets a
       LEFT JOIN asset_classes ac ON ac.id = a.asset_class_id
       LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
       LEFT JOIN vehicle_details v ON v.asset_id = a.id
       LEFT JOIN employees ce ON ce.id = a.custodian_employee_id
       LEFT JOIN employees de ON de.id = v.driver_employee_id
       LEFT JOIN employees ie ON ie.id = v.incharge_employee_id
      WHERE (ac.name LIKE '%Transport%' OR ac.name LIKE '%Vehicle%' OR ai.category LIKE '%Vehicle%'
             OR ai.category LIKE '%Transport%' OR ai.display_name REGEXP '(^|[^a-z])(vehicles?|motorcycles?|motorbikes?|trucks?|vans?|cars?)([^a-z]|$)'
             OR v.asset_id IS NOT NULL)
        ${assetId ? 'AND a.id = ?' : ''}
      ORDER BY v.plate_no IS NULL, v.plate_no, a.id`,
    assetId ? [assetId] : []).catch((e) => {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return [[]]; // create-fleet-module.js not run yet
    throw e;
  });
  if (!rows.length) return [];
  const ids = rows.map((r) => r.asset_id);
  const [lastPms] = await q.query(
    `SELECT l.* FROM vehicle_service_logs l
      JOIN (SELECT asset_id, MAX(CONCAT(service_date, LPAD(id, 12, '0'))) k FROM vehicle_service_logs
             WHERE is_pms = 1 AND asset_id IN (?) GROUP BY asset_id) m
        ON m.asset_id = l.asset_id AND CONCAT(l.service_date, LPAD(l.id, 12, '0')) = m.k`, [ids]);
  const [odo] = await q.query(
    `SELECT asset_id, MAX(km) km FROM (
        SELECT asset_id, odometer_km km FROM vehicle_service_logs WHERE asset_id IN (?)
        UNION ALL SELECT asset_id, odometer_km FROM vehicle_fuel_logs WHERE asset_id IN (?)) x GROUP BY asset_id`, [ids, ids]);
  const pmsBy = new Map(lastPms.map((l) => [l.asset_id, l]));
  const odoBy = new Map(odo.map((o) => [o.asset_id, Number(o.km) || null]));
  const today = todayPh();
  return rows.map((r) => computeDue(r, pmsBy.get(r.asset_id), odoBy.get(r.asset_id), today));
}

function computeDue(v, pms, logOdo, today) {
  const odometer = Math.max(Number(v.odometer_km) || 0, logOdo || 0) || null;
  const lastPmsDate = pms ? day(pms.service_date) : null;
  const lastPmsKm = pms && pms.odometer_km != null ? Number(pms.odometer_km) : null;

  let nextDate = pms?.next_due_date ? day(pms.next_due_date) : null;
  if (!nextDate && lastPmsDate && Number(v.pms_interval_months) > 0) nextDate = addMonths(lastPmsDate, v.pms_interval_months);
  let nextKm = pms?.next_due_km != null ? Number(pms.next_due_km) : null;
  if (nextKm == null && lastPmsKm != null && Number(v.pms_interval_km) > 0) nextKm = lastPmsKm + Number(v.pms_interval_km);

  // PMS: whichever of date and km is nearer decides it.
  const byDate = dateStatus(nextDate, today);
  let byKm = { status: 'none' };
  if (nextKm != null && odometer != null) {
    const kmLeft = nextKm - odometer;
    byKm = { status: kmLeft <= 0 ? 'overdue' : kmLeft <= DUE_SOON_KM ? 'due_soon' : 'ok', km_left: kmLeft };
  }
  const rank = { overdue: 3, due_soon: 2, ok: 1, none: 0 };
  const pmsStatus = rank[byKm.status] > rank[byDate.status] ? byKm.status : byDate.status;

  return {
    ...v,
    registration_expiry: day(v.registration_expiry), insurance_expiry: day(v.insurance_expiry),
    emission_expiry: day(v.emission_expiry), registration_date: day(v.registration_date), odometer_at: day(v.odometer_at),
    current_odometer_km: odometer,
    last_pms_date: lastPmsDate, last_pms_km: lastPmsKm,
    next_pms_date: nextDate, next_pms_km: nextKm,
    due: {
      pms: { status: pmsStatus, due: nextDate, days_left: byDate.days_left, due_km: nextKm, km_left: byKm.km_left ?? null },
      registration: dateStatus(day(v.registration_expiry), today),
      insurance: dateStatus(day(v.insurance_expiry), today),
      emission: dateStatus(day(v.emission_expiry), today),
    },
  };
}

// km per litre between full-tank fill-ups: distance since the previous full tank over the litres
// put in since then (this fill included). Needs odometer readings on both.
function withEfficiency(fuelLogs) {
  const asc = [...fuelLogs].sort((a, b) => String(day(a.fuel_date)).localeCompare(String(day(b.fuel_date))) || a.id - b.id);
  let prevFull = null; let litresSince = 0;
  const out = new Map();
  for (const f of asc) {
    litresSince += Number(f.liters) || 0;
    if (f.is_full_tank && f.odometer_km != null) {
      if (prevFull && litresSince > 0 && Number(f.odometer_km) > Number(prevFull.odometer_km)) {
        out.set(f.id, Number(((Number(f.odometer_km) - Number(prevFull.odometer_km)) / litresSince).toFixed(2)));
      }
      prevFull = f; litresSince = 0;
    }
  }
  return fuelLogs.map((f) => ({ ...f, fuel_date: day(f.fuel_date), km_per_liter: out.get(f.id) ?? null }));
}

/* ------------------------------------------------------------------ daily reminders ---------- */
//
// Who is told (asked 2026-10-19): the General Managers, the vehicle's custodian and its in-charge
// (Technical Department). For registration, insurance and emission: 30 days before, 7 days before,
// and once it has lapsed. For PMS: once it is due soon (30 days / 500 km) and once it is overdue.
// vehicle_reminders_sent keys each one by item + due date (or km) + stage, so a daily run never
// sends the same reminder twice -- and a renewal (a new expiry date) starts the count again.

const LABEL = { registration: 'Registration (LTO)', insurance: 'Insurance', emission: 'Emission test', pms: 'PMS' };

async function userForEmployee(q, employeeId) {
  if (!employeeId) return null;
  const [[u]] = await q.query('SELECT id FROM users WHERE employee_id = ? AND is_active = 1 ORDER BY id LIMIT 1', [employeeId]);
  return u ? u.id : null;
}

async function generalManagerIds(q) {
  const [a] = await q.query('SELECT u.id FROM general_managers gm JOIN users u ON u.id = gm.user_id WHERE u.is_active = 1').catch(() => [[]]);
  const [b] = await q.query("SELECT id FROM users WHERE account_type = 'General Manager' AND is_active = 1");
  return [...new Set([...a, ...b].map((r) => Number(r.id)))];
}

// The reminder a vehicle item is at today, or null: { stage, key, text }.
function reminderFor(kind, d, v) {
  if (kind === 'pms') {
    if (d.status !== 'overdue' && d.status !== 'due_soon') return null;
    const when = [d.due ? `on ${d.due}` : null, d.due_km != null ? `at ${Number(d.due_km).toLocaleString('en-US')} km` : null].filter(Boolean).join(' or ');
    const stage = d.status === 'overdue' ? 'overdue' : 'soon';
    return {
      stage, key: `${d.due || ''}|${d.due_km ?? ''}|${stage}`,
      text: d.status === 'overdue' ? `PMS is overdue (was due ${when}).` : `PMS is due ${when}.`,
    };
  }
  if (!d.due) return null;
  let stage = null;
  if (d.days_left < 0) stage = 'lapsed';
  else if (d.days_left <= 7) stage = '7d';
  else if (d.days_left <= 30) stage = '30d';
  if (!stage) return null;
  return {
    stage, key: `${d.due}|${stage}`,
    text: stage === 'lapsed' ? `${LABEL[kind]} expired on ${d.due}.` : `${LABEL[kind]} expires on ${d.due} (${d.days_left} day${d.days_left === 1 ? '' : 's'}).`,
  };
}

async function runFleetReminders(q = pool) {
  const { insertFor } = require('./approvalNotifications');
  const vehicles = await loadVehicles(q);
  const gms = await generalManagerIds(q);
  let sent = 0;
  for (const v of vehicles) {
    const name = [v.plate_no, [v.make || v.brand, v.model || v.asset_model].filter(Boolean).join(' '), v.reference_no].filter(Boolean).join(' · ');
    const to = [...gms, await userForEmployee(q, v.custodian_employee_id), await userForEmployee(q, v.incharge_employee_id)].filter(Boolean);
    for (const kind of ['registration', 'insurance', 'emission', 'pms']) {
      const r = reminderFor(kind, v.due[kind], v);
      if (!r) continue;
      const [ins] = await q.query('INSERT IGNORE INTO vehicle_reminders_sent (asset_id, kind, due_key) VALUES (?, ?, ?)', [v.asset_id, kind, r.key]);
      if (!ins.affectedRows) continue; // already told
      await insertFor(to, {
        type: `vehicle_${kind}_${r.stage === 'lapsed' || r.stage === 'overdue' ? 'overdue' : 'due'}`,
        title: `${name}: ${LABEL[kind]} ${r.stage === 'lapsed' || r.stage === 'overdue' ? 'overdue' : 'due'}`,
        message: r.text, relatedType: 'Vehicle', relatedId: v.asset_id,
      }, null);
      sent += 1;
    }
  }
  return { vehicles: vehicles.length, reminders: sent };
}

module.exports = { loadVehicles, withEfficiency, todayPh, runFleetReminders, reminderFor, DUE_SOON_DAYS, DUE_SOON_KM };
