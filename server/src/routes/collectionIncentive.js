const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { fetchCollections } = require('./collectionAgingReport');

const router = express.Router();

// Treasury > Collection Incentive (asked 2026-10-15, from Treasury's own workbook "treasury.xlsx").
// The collector's incentive, from what was collected and how late it was collected. Collections are
// counted exactly as Treasury > Collection Report with Aging counts them (same query: real,
// non-voided Customer Payments, aged on days past the invoice's due date).
//
// The workbook's formula, per aging bucket:
//   Base incentive    = (collected in the period / months in the period) x rate (0.1%)
//   Target amount     = target % x base                         (target % is set up by hand)
//   Actual %          = bucket collected / total collected
//   Expected          = base x actual %
//   Multiplier        = actual % / target %  while actual % is under target, otherwise 1
//   Actual incentive  = expected x multiplier
// Qualifier: only when the month's collection reaches 90% of the monthly target (set up by hand).
//
// Advances from Customers (money not yet applied to an invoice) count as CURRENT here -- Treasury's
// instruction, 2026-10-15 -- so they are inside the total and the base.
//
// Monthly report: one month (months = 1). Annual report: the year through a chosen month, the
// workbook's calculation over the period (an average month), plus each month on its own with
// whether it qualified; "earned" is the sum of the qualified months.
const ROUTE = '/treasury/collection-incentive';

const BUCKETS = [
  { key: 'current', label: 'Current', col: 'target_current' },
  { key: '1-30', label: '1-30', col: 'target_1_30' },
  { key: '31-60', label: '31-60', col: 'target_31_60' },
  { key: '61-90', label: '61-90', col: 'target_61_90' },
  { key: '90+', label: 'Over 90', col: 'target_over_90' },
];

// The workbook's own figures, used until Treasury saves a set-up for a year.
const DEFAULTS = {
  target_current: 0.295, target_1_30: 0.38, target_31_60: 0.17, target_61_90: 0.06, target_over_90: 0.095,
  monthly_target: 10000000, incentive_rate: 0.001, qualifier_pct: 0.9,
};
const SETTING_COLS = Object.keys(DEFAULTS);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const ym = (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 7);

// A year's set-up; a year never set up borrows the latest earlier one, then the workbook's.
async function settingsFor(year) {
  const [[row]] = await pool.query(
    `SELECT s.*, u.display_name AS updated_by FROM collection_incentive_settings s
       LEFT JOIN users u ON u.id = s.updated_by_user_id
      WHERE s.year <= ? ORDER BY s.year DESC LIMIT 1`, [year]);
  const out = { year, saved: Boolean(row && row.year === year), inherited_from: row && row.year !== year ? row.year : null };
  for (const c of SETTING_COLS) out[c] = Number(row ? row[c] : DEFAULTS[c]);
  out.updated_by = row?.year === year ? row.updated_by : null;
  out.updated_at = row?.year === year ? row.updated_at : null;
  return out;
}

// Amounts per bucket, advances folded into Current.
function bucketTotals(rows) {
  const t = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
  for (const r of rows) t[r.bucket === 'advance' ? 'current' : r.bucket] += r.applied_amount;
  return t;
}

// The workbook's calculation for one set of bucket totals.
function compute(totals, months, s) {
  const total = BUCKETS.reduce((sum, b) => sum + totals[b.key], 0);
  const base = (total / months) * s.incentive_rate;
  const lines = BUCKETS.map((b) => {
    const targetPct = s[b.col];
    const actualPct = total ? totals[b.key] / total : 0;
    const expected = base * actualPct;
    const multiplier = actualPct < targetPct ? (targetPct ? actualPct / targetPct : 0) : 1;
    return {
      key: b.key, label: b.label, target_pct: targetPct, target_amount: targetPct * base,
      collected: totals[b.key], actual_pct: actualPct, expected, multiplier, incentive: expected * multiplier,
    };
  });
  const avgMonthly = total / months;
  const qualifyAt = s.monthly_target * s.qualifier_pct;
  const incentive = lines.reduce((sum, l) => sum + l.incentive, 0);
  return {
    lines, total_collected: total, months, avg_monthly_collection: avgMonthly, base_incentive: base,
    target_total: lines.reduce((sum, l) => sum + l.target_amount, 0),
    expected_total: lines.reduce((sum, l) => sum + l.expected, 0),
    incentive_total: incentive,
    qualify_at: qualifyAt, qualified: avgMonthly >= qualifyAt,
    pct_of_target: s.monthly_target ? avgMonthly / s.monthly_target : 0,
    incentive_payable: avgMonthly >= qualifyAt ? incentive : 0,
  };
}

const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));

async function buildReport(q) {
  const today = new Date();
  const loc = Number(q.location_id) > 0 ? { location_id: Number(q.location_id) } : {};
  if (q.mode !== 'annual') {
    // Monthly: the given month, default last month.
    const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const month = isMonth(q.month) ? q.month : `${lm.getFullYear()}-${pad(lm.getMonth() + 1)}`;
    const [y, m] = month.split('-').map(Number);
    const s = await settingsFor(y);
    const data = await fetchCollections({ from: `${month}-01`, to: `${month}-${pad(lastDay(y, m))}`, ...loc });
    return { mode: 'monthly', month, label: `${MONTHS[m - 1]} ${y}`, from: data.from, to: data.to, settings: s,
      result: compute(bucketTotals(data.rows), 1, s) };
  }
  // Annual: January through `through` (default the last full month of the running year, December
  // of a past one).
  const year = Number(q.year) >= 2000 ? Number(q.year) : today.getFullYear();
  let through = Number(q.through) >= 1 && Number(q.through) <= 12 ? Number(q.through)
    : (year < today.getFullYear() ? 12 : Math.max(1, today.getMonth()));
  if (year === today.getFullYear()) through = Math.min(through, today.getMonth() + 1);
  const s = await settingsFor(year);
  const data = await fetchCollections({ from: `${year}-01-01`, to: `${year}-${pad(through)}-${pad(lastDay(year, through))}`, ...loc });
  const byMonth = Array.from({ length: through }, () => []);
  for (const r of data.rows) {
    const mi = Number(ym(r.payment_date).slice(5, 7)) - 1;
    if (mi >= 0 && mi < through) byMonth[mi].push(r);
  }
  const months = byMonth.map((rows, i) => {
    const c = compute(bucketTotals(rows), 1, s);
    return { month: `${year}-${pad(i + 1)}`, label: MONTHS[i], collected: c.total_collected, pct_of_target: c.pct_of_target,
      qualified: c.qualified, incentive: c.incentive_total, payable: c.incentive_payable };
  });
  return {
    mode: 'annual', year, through, label: `January–${MONTHS[through - 1]} ${year}`, from: data.from, to: data.to, settings: s,
    result: compute(bucketTotals(data.rows), through, s),
    months, earned_total: months.reduce((sum, m) => sum + m.payable, 0),
    qualified_months: months.filter((m) => m.qualified).length,
  };
}

router.get('/settings', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(await settingsFor(Number(req.query.year) >= 2000 ? Number(req.query.year) : new Date().getFullYear()));
  } catch (err) { next(err); }
});

router.put('/settings/:year', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    if (!(year >= 2000 && year <= 2100)) return res.status(400).json({ error: 'Invalid year.' });
    const v = {};
    for (const c of SETTING_COLS) {
      const n = Number(req.body[c]);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${c.replace(/_/g, ' ')} must be a number, 0 or more.` });
      v[c] = n;
    }
    const sum = BUCKETS.reduce((s, b) => s + v[b.col], 0);
    if (Math.abs(sum - 1) > 0.0005) {
      return res.status(400).json({ error: `The target percentages must add up to 100% (they add up to ${(sum * 100).toFixed(2)}%).` });
    }
    if (!(v.incentive_rate > 0 && v.incentive_rate < 1)) return res.status(400).json({ error: 'The incentive rate must be between 0% and 100%.' });
    if (!(v.qualifier_pct > 0 && v.qualifier_pct <= 1)) return res.status(400).json({ error: 'The qualifier must be between 0% and 100%.' });
    await pool.query(
      `INSERT INTO collection_incentive_settings (year, ${SETTING_COLS.join(', ')}, updated_by_user_id)
       VALUES (?, ${SETTING_COLS.map(() => '?').join(', ')}, ?)
       ON DUPLICATE KEY UPDATE ${SETTING_COLS.map((c) => `${c} = VALUES(${c})`).join(', ')},
         updated_by_user_id = VALUES(updated_by_user_id), updated_at = NOW()`,
      [year, ...SETTING_COLS.map((c) => v[c]), req.user.id]);
    res.json(await settingsFor(year));
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await buildReport(req.query)); } catch (err) { next(err); }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rep = await buildReport(req.query);
    const r = rep.result;
    const s = rep.settings;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Incentive');
    const money = '#,##0.00';
    const pct = '0.0%';
    ws.columns = [{ width: 26 }, { width: 14 }, { width: 16 }, { width: 18 }, { width: 14 }, { width: 18 }, { width: 14 }, { width: 18 }];
    ws.addRow([`Collection Incentive — ${rep.label}`]).font = { bold: true, size: 14 };
    ws.addRow([`${rep.mode === 'annual' ? 'Annual' : 'Monthly'} report, payments ${rep.from} to ${rep.to}. Advances from Customers are counted as Current.`]);
    ws.addRow([]);
    const head = ws.addRow(['Aging', 'Target %', 'Target Amount', 'Actual Amount Collected', 'Actual % of Total', 'Expected Incentive', 'Multiplier', 'Actual Incentive']);
    head.font = { bold: true };
    for (const l of r.lines) {
      const row = ws.addRow([l.label, l.target_pct, l.target_amount, l.collected, l.actual_pct, l.expected, l.multiplier, l.incentive]);
      row.getCell(2).numFmt = pct; row.getCell(5).numFmt = pct; row.getCell(7).numFmt = '0.0000';
      [3, 4, 6, 8].forEach((i) => { row.getCell(i).numFmt = money; });
    }
    const tot = ws.addRow(['Total', null, r.target_total, r.total_collected, null, r.expected_total, null, r.incentive_total]);
    tot.font = { bold: true };
    [3, 4, 6, 8].forEach((i) => { tot.getCell(i).numFmt = money; });
    ws.addRow([]);
    const kv = (k, val, fmt) => { const row = ws.addRow([k, val]); if (fmt) row.getCell(2).numFmt = fmt; return row; };
    kv(`Actual collection (${r.months} month${r.months === 1 ? '' : 's'})`, r.total_collected, money);
    kv('Average monthly collection', r.avg_monthly_collection, money);
    kv(`Base incentive (avg monthly x ${(s.incentive_rate * 100).toFixed(2)}%)`, r.base_incentive, money);
    kv('Monthly target', s.monthly_target, money);
    kv(`Qualifies at (${(s.qualifier_pct * 100).toFixed(0)}% of target)`, r.qualify_at, money);
    kv('Qualified', r.qualified ? 'YES' : 'NO');
    kv('Incentive payable', r.incentive_payable, money).font = { bold: true };
    if (rep.mode === 'annual') {
      ws.addRow([]);
      ws.addRow(['Month', 'Collected', '% of Target', 'Qualified', 'Incentive', 'Payable']).font = { bold: true };
      for (const m of rep.months) {
        const row = ws.addRow([m.label, m.collected, m.pct_of_target, m.qualified ? 'YES' : 'NO', m.incentive, m.payable]);
        row.getCell(2).numFmt = money; row.getCell(3).numFmt = pct; row.getCell(5).numFmt = money; row.getCell(6).numFmt = money;
      }
      const e = ws.addRow(['Earned (qualified months)', null, null, `${rep.qualified_months} of ${rep.months.length}`, null, rep.earned_total]);
      e.font = { bold: true }; e.getCell(6).numFmt = money;
    }
    const name = rep.mode === 'annual' ? `${rep.year}-thru-${pad(rep.through)}` : rep.month;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="collection-incentive-${name}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.compute = compute; // checked against the workbook's figures
module.exports.buildReport = buildReport;
