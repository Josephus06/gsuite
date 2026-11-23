const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

// Reports > Fuel Issuance (asked 2026-11-23): what Audit needs to control gas issuance. Every Fuel
// Request in a date range (by its fuel date) with who asked, for which vehicle, how much, who approved
// it, and how many times its slip was printed -- each print and reprint from the form's audit history
// (routes/forms.js POST /:id/printed logs them) -- plus the checks below, so the exceptions surface
// instead of having to be hunted for:
//
//   not_printed     approved, slip never printed (not issued yet -- or printed before the counter, 2026-11-23)
//   reprinted       the slip was printed more than once (only a System Admin can, but each is a second voucher)
//   over_limit      the requester's month (submitted, noted and approved requests) is past their fuel limit
//   odometer        a Fleet vehicle with no odometer, or one not higher than its previous approved fill
//   same_day        the same vehicle got more than one approved fill that day
//   typed_vehicle   not a Fleet vehicle -- typed by hand, so nothing ties it to a real plate
//   self_approved   the requester approved their own request
//
// Its own permission page: reading every department's fuel is Audit's question, not the right to
// file or approve a request.
const ROUTE = '/reports/fuel-issuance';
const FUEL_COUNTED = ['submitted', 'noted', 'approved'];
const FLAG_LABELS = {
  not_printed: 'Not printed yet',
  reprinted: 'Reprinted',
  over_limit: 'Over monthly limit',
  odometer: 'Odometer issue',
  same_day: 'Same vehicle, same day',
  typed_vehicle: 'Typed vehicle (not Fleet)',
  self_approved: 'Self-approved',
};

const router = express.Router();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const ymd = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);
const stamp = (v) => (v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : String(v || '').slice(0, 16));

function range(query) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = String(query.from || '').slice(0, 10) || monthStart;
  const to = String(query.to || '').slice(0, 10) || today;
  return from <= to ? { from, to } : { from: to, to: from };
}

// The vehicle as one key: a Fleet vehicle by its asset, a typed one by its text.
const vehicleKey = (r) => (r.vehicle_asset_id ? `a${r.vehicle_asset_id}` : `t:${String(r.vehicle_label || '').trim().toUpperCase()}`);

async function build(query) {
  const { from, to } = range(query);
  const status = query.status === 'all' ? null : 'approved';
  const where = ["f.type = 'fuel'", 'd.fuel_date BETWEEN ? AND ?'];
  const params = [from, to];
  if (status) { where.push('f.status = ?'); params.push(status); }
  if (Number(query.department_id) > 0) { where.push('f.department_id = ?'); params.push(Number(query.department_id)); }
  if (Number(query.user_id) > 0) { where.push('f.user_id = ?'); params.push(Number(query.user_id)); }
  if (query.vehicle) { where.push('(vd.plate_no LIKE ? OR d.vehicle_label LIKE ? OR a.serial_no LIKE ?)'); const l = `%${query.vehicle}%`; params.push(l, l, l); }

  const [rows] = await pool.query(
    `SELECT f.id, f.request_no, f.status, f.user_id, f.department_id, COALESCE(dep.name, f.department) AS department,
            COALESCE(ru.display_name, f.name) AS requester, f.approved_at, f.approved_by,
            COALESCE(au.display_name, au.username) AS approved_by_name,
            f.print_count, f.first_printed_at, COALESCE(pu.display_name, pu.username) AS first_printed_by_name,
            d.fuel_date, d.vehicle_asset_id, d.vehicle_label, d.liters, d.price_per_liter, d.amount, d.odometer_km,
            d.station, d.purpose, vd.plate_no, a.serial_no, a.brand, a.model,
            ru.has_fuel_limit, ru.fuel_limit_liters
       FROM form_requests f
       JOIN form_fuel_details d ON d.form_request_id = f.id
       LEFT JOIN departments dep ON dep.id = f.department_id
       LEFT JOIN users ru ON ru.id = f.user_id
       LEFT JOIN users au ON au.id = f.approved_by
       LEFT JOIN users pu ON pu.id = f.first_printed_by
       LEFT JOIN assets a ON a.id = d.vehicle_asset_id
       LEFT JOIN vehicle_details vd ON vd.asset_id = d.vehicle_asset_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.fuel_date, f.id`, params);

  for (const r of rows) {
    r.fuel_date = ymd(r.fuel_date);
    const plate = String(r.plate_no || r.serial_no || '').trim();
    r.vehicle = r.vehicle_asset_id
      ? [plate, [r.brand, r.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || `Asset #${r.vehicle_asset_id}`
      : (r.vehicle_label || '—');
    r.liters = r3(r.liters); r.amount = r.amount == null ? null : r2(r.amount);
    r.print_count = Number(r.print_count) || 0;
    r.flags = [];
    r.prints = [];
  }
  if (!rows.length) return { from, to, status: status || 'all', rows, summary: summarize(rows), flag_labels: FLAG_LABELS };

  const ids = rows.map((r) => r.id);

  // Every print / reprint, from the form's audit history.
  const [prints] = await pool.query(
    `SELECT l.auditable_id AS form_id, l.event_type, l.new_value, l.set_at, COALESCE(u.display_name, u.username) AS by_name
       FROM audit_logs l LEFT JOIN users u ON u.id = l.set_by_user_id
      WHERE l.auditable_type = 'FormRequest' AND l.event_type IN ('Printed', 'Reprinted') AND l.auditable_id IN (?)
      ORDER BY l.set_at, l.id`, [ids]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const p of prints) {
    const r = byId.get(Number(p.form_id));
    if (r) r.prints.push({ event: p.event_type, copy: Number(p.new_value) || null, at: stamp(p.set_at), by: p.by_name || '' });
  }

  // Month totals per requester (the limit counts submitted, noted and approved requests).
  const months = [...new Set(rows.map((r) => `${r.user_id}|${r.fuel_date.slice(0, 7)}`))];
  const monthUsed = new Map();
  for (const key of months) {
    const [userId, month] = key.split('|');
    const [[u]] = await pool.query(
      `SELECT COALESCE(SUM(d.liters), 0) AS l FROM form_fuel_details d JOIN form_requests f ON f.id = d.form_request_id
        WHERE f.user_id = ? AND f.type = 'fuel' AND f.status IN (?) AND DATE_FORMAT(d.fuel_date, '%Y-%m') = ?`,
      [userId, FUEL_COUNTED, month]);
    monthUsed.set(key, r3(u.l));
  }

  // Each Fleet vehicle's approved fills over all time, for the odometer check and km travelled.
  const assetIds = [...new Set(rows.filter((r) => r.vehicle_asset_id).map((r) => Number(r.vehicle_asset_id)))];
  const history = new Map(); // asset id -> [{ id, fuel_date, odometer_km }]
  if (assetIds.length) {
    const [hist] = await pool.query(
      `SELECT f.id, d.vehicle_asset_id, d.fuel_date, d.odometer_km FROM form_requests f
         JOIN form_fuel_details d ON d.form_request_id = f.id
        WHERE f.type = 'fuel' AND f.status = 'approved' AND d.vehicle_asset_id IN (?)
        ORDER BY d.vehicle_asset_id, d.fuel_date, f.id`, [assetIds]);
    for (const h of hist) {
      const k = Number(h.vehicle_asset_id);
      if (!history.has(k)) history.set(k, []);
      history.get(k).push({ id: Number(h.id), fuel_date: ymd(h.fuel_date), odometer_km: h.odometer_km == null ? null : Number(h.odometer_km) });
    }
  }

  // Same vehicle, same day (approved fills).
  const perDay = new Map();
  for (const r of rows) {
    if (r.status !== 'approved') continue;
    const k = `${vehicleKey(r)}|${r.fuel_date}`;
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }

  for (const r of rows) {
    const approved = r.status === 'approved';
    if (approved && r.print_count === 0) r.flags.push('not_printed');
    if (r.print_count > 1) r.flags.push('reprinted');
    const used = monthUsed.get(`${r.user_id}|${r.fuel_date.slice(0, 7)}`) || 0;
    r.month_used = used;
    r.month_limit = r.has_fuel_limit && Number(r.fuel_limit_liters) > 0 ? Number(r.fuel_limit_liters) : null;
    if (r.month_limit != null && used > r.month_limit + 0.0005) r.flags.push('over_limit');
    if (!r.vehicle_asset_id) r.flags.push('typed_vehicle');
    else {
      const list = history.get(Number(r.vehicle_asset_id)) || [];
      const i = list.findIndex((h) => h.id === Number(r.id));
      const prev = i > 0 ? list[i - 1] : (i < 0 ? [...list].reverse().find((h) => h.fuel_date <= r.fuel_date && h.id !== Number(r.id)) : null);
      const odo = r.odometer_km == null ? null : Number(r.odometer_km);
      r.prev_odometer_km = prev ? prev.odometer_km : null;
      r.km_since_last = odo != null && prev && prev.odometer_km != null ? odo - prev.odometer_km : null;
      r.km_per_liter = r.km_since_last > 0 && r.liters > 0 ? r2(r.km_since_last / r.liters) : null;
      if (odo == null || (prev && prev.odometer_km != null && odo <= prev.odometer_km)) r.flags.push('odometer');
    }
    if (approved && (perDay.get(`${vehicleKey(r)}|${r.fuel_date}`) || 0) > 1) r.flags.push('same_day');
    if (approved && r.approved_by && Number(r.approved_by) === Number(r.user_id)) r.flags.push('self_approved');
  }

  return { from, to, status: status || 'all', rows, summary: summarize(rows), flag_labels: FLAG_LABELS };
}

function summarize(rows) {
  const total = { requests: rows.length, liters: 0, amount: 0, prints: 0, reprints: 0, with_flags: 0 };
  const flags = Object.fromEntries(Object.keys(FLAG_LABELS).map((k) => [k, 0]));
  const group = (keyOf, labelOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!m.has(k)) m.set(k, { label: labelOf(r), requests: 0, liters: 0, amount: 0, km: 0, flagged: 0 });
      const g = m.get(k);
      g.requests += 1; g.liters += r.liters || 0; g.amount += r.amount || 0;
      if (r.km_since_last > 0) g.km += r.km_since_last;
      if (r.flags.length) g.flagged += 1;
    }
    return [...m.values()].map((g) => ({ ...g, liters: r3(g.liters), amount: r2(g.amount), km_per_liter: g.km > 0 && g.liters > 0 ? r2(g.km / g.liters) : null }))
      .sort((a, b) => b.liters - a.liters);
  };
  for (const r of rows) {
    total.liters += r.liters || 0; total.amount += r.amount || 0;
    total.prints += r.print_count; total.reprints += Math.max(0, r.print_count - 1);
    if (r.flags.length) total.with_flags += 1;
    for (const f of r.flags) flags[f] += 1;
  }
  total.liters = r3(total.liters); total.amount = r2(total.amount);
  return {
    total, flags,
    by_vehicle: group(vehicleKey, (r) => r.vehicle),
    by_department: group((r) => r.department || '—', (r) => r.department || '—'),
    by_requester: group((r) => r.user_id, (r) => r.requester || '—'),
  };
}

// Filter pickers: departments and requesters that have filed fuel requests.
router.get('/filters', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [departments] = await pool.query(
      `SELECT DISTINCT dep.id, dep.name FROM form_requests f JOIN departments dep ON dep.id = f.department_id
        WHERE f.type = 'fuel' ORDER BY dep.name`);
    const [requesters] = await pool.query(
      `SELECT DISTINCT u.id, COALESCE(u.display_name, u.username) AS name FROM form_requests f JOIN users u ON u.id = f.user_id
        WHERE f.type = 'fuel' ORDER BY name`);
    res.json({ departments, requesters });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const out = await build(req.query);
    if (req.query.flagged === '1') out.rows = out.rows.filter((r) => r.flags.length);
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const out = await build(req.query);
    const rows = req.query.flagged === '1' ? out.rows.filter((r) => r.flags.length) : out.rows;
    const wb = new ExcelJS.Workbook();
    const money = '#,##0.00';

    const ws = wb.addWorksheet('Issuances');
    ws.columns = [
      { header: 'Control No.', key: 'request_no', width: 12 },
      { header: 'Fuel Date', key: 'fuel_date', width: 12 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Requester / Driver', key: 'requester', width: 26 },
      { header: 'Charge to', key: 'department', width: 24 },
      { header: 'Vehicle', key: 'vehicle', width: 28 },
      { header: 'Liters', key: 'liters', width: 9 },
      { header: 'Price / L', key: 'price_per_liter', width: 10 },
      { header: 'Amount', key: 'amount', width: 12 },
      { header: 'Odometer', key: 'odometer_km', width: 11 },
      { header: 'Km since last', key: 'km_since_last', width: 12 },
      { header: 'Km / L', key: 'km_per_liter', width: 9 },
      { header: 'Month used / limit (L)', key: 'month', width: 18 },
      { header: 'Gas Station', key: 'station', width: 24 },
      { header: 'Purpose', key: 'purpose', width: 34 },
      { header: 'Approved by', key: 'approved_by_name', width: 22 },
      { header: 'Approved at', key: 'approved_at', width: 17 },
      { header: 'Times printed', key: 'print_count', width: 12 },
      { header: 'Print history', key: 'prints', width: 50 },
      { header: 'Flags', key: 'flags', width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        ...r,
        approved_at: r.approved_at ? stamp(r.approved_at) : '',
        amount: r.amount == null ? null : Number(r.amount),
        price_per_liter: r.price_per_liter == null ? null : Number(r.price_per_liter),
        month: r.month_limit != null ? `${r.month_used} / ${r.month_limit}` : `${r.month_used} / no limit`,
        prints: r.prints.map((p) => `${p.event} ${p.at} by ${p.by}`).join('; '),
        flags: r.flags.map((f) => FLAG_LABELS[f]).join(', '),
      });
    }
    ['amount', 'price_per_liter'].forEach((k) => { ws.getColumn(k).numFmt = money; });
    ws.autoFilter = { from: 'A1', to: `T${rows.length + 1}` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const sheet = (name, list) => {
      const s = wb.addWorksheet(name);
      s.columns = [
        { header: name.replace('By ', ''), key: 'label', width: 34 }, { header: 'Requests', key: 'requests', width: 10 },
        { header: 'Liters', key: 'liters', width: 11 }, { header: 'Amount', key: 'amount', width: 14 },
        { header: 'Km travelled', key: 'km', width: 13 }, { header: 'Km / L', key: 'km_per_liter', width: 9 },
        { header: 'Flagged', key: 'flagged', width: 9 },
      ];
      s.getRow(1).font = { bold: true };
      list.forEach((g) => s.addRow(g));
      s.getColumn('amount').numFmt = money;
    };
    sheet('By Vehicle', out.summary.by_vehicle);
    sheet('By Department', out.summary.by_department);
    sheet('By Requester', out.summary.by_requester);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="fuel-issuance-${out.from}-to-${out.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
