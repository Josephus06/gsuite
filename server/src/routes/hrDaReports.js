const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// HRD > DA Report (2026-10-28). HR's monthly Discipline Management Report, as the company's sheet
// ("DA REPORT FORMAT.xlsx") has it: a title with the month, a section per stage of the disciplinary
// action (NOTICE TO EXPLAIN, ...), each a table of EMPLOYEE NAME / VIOLATION / SECTION VIOLATED /
// FINAL SANCTION.
//
// One form per period (hr_da_reports), filled in and saved whole like the sheet: its sections and
// rows are sent together and replace what was there (hr_da_entries). HR keeps a Monthly report and a
// Weekly one (Monday to Sunday); one of each per period.
//
// Each row carries the day it was logged (entry_date, 2026-10-28): HR adds to the week's report day
// by day and presents it once a week -- HrDaReportPresent.jsx, a slide deck of the saved report.
const ROUTE = '/hrd/da-report';
// The usual stages, in the order the report lists them. HR may type another.
const STAGES = ['NOTICE TO EXPLAIN', 'NOTICE OF DECISION', 'WRITTEN WARNING', 'FINAL WARNING', 'SUSPENSION', 'TERMINATION'];
const SANCTIONS = ['ISSUED NTE', 'VERBAL WARNING', 'WRITTEN WARNING', 'FINAL WARNING', 'SUSPENSION', 'TERMINATION', 'NO SANCTION'];
const MAX_SECTIONS = 12;
const MAX_ROWS = 200;

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const TYPES = ['monthly', 'weekly'];
const ymd = (d) => d.toISOString().slice(0, 10);

// The period a report covers: a monthly one the month of the date given, a weekly one the Monday to
// Sunday week it falls in. Worked in UTC on the bare date so no timezone moves a day.
function periodOf(type, date) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(date || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1)));
  if (Number.isNaN(d.getTime())) return null;
  if (type === 'weekly') {
    const from = new Date(d);
    from.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const to = new Date(from);
    to.setUTCDate(from.getUTCDate() + 6);
    return { from: ymd(from), to: ymd(to) };
  }
  return { from: ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))), to: ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) };
}

// The employee as the report prints them: "SUSTITUIDO, LARA".
const reportName = (e) => [e.last_name, e.first_name].map((x) => String(x || '').trim()).filter((x) => x && x !== '-').join(', ').toUpperCase();

// The form's sections -> rows to store. A row needs an employee and a violation; blank rows (the
// sheet's empty lines) are dropped, and so is a section left with none.
function readSections(input, period) {
  const rows = [];
  let sort = 0;
  for (const s of (Array.isArray(input) ? input : []).slice(0, MAX_SECTIONS)) {
    const stage = (trunc(s?.stage, 80) || STAGES[0]).toUpperCase();
    for (const r of (Array.isArray(s?.rows) ? s.rows : [])) {
      const employeeName = trunc(r?.employee_name, 150);
      const violation = trunc(r?.violation, 300);
      const section = trunc(r?.section_violated, 300);
      const sanction = trunc(r?.final_sanction, 200);
      // Inside the report's period, else its first day.
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(r?.entry_date || '')) ? String(r.entry_date) : null;
      const entryDate = day && period && day >= period.from && day <= period.to ? day : (period?.from || null);
      if (!employeeName && !violation && !section) continue;
      if (!employeeName) return { error: `A row under ${stage} has no employee.` };
      if (!violation) return { error: `${employeeName.toUpperCase()} under ${stage} has no violation.` };
      sort += 1;
      rows.push({
        stage, employee_id: Number(r.employee_id) || null, employee_name: employeeName.toUpperCase(), violation,
        violation_type_id: Number(r.violation_type_id) || null, section_violated: section,
        final_sanction: sanction ? sanction.toUpperCase() : null, entry_date: entryDate, sort_order: sort,
      });
      if (rows.length > MAX_ROWS) return { error: `A report holds up to ${MAX_ROWS} rows.` };
    }
  }
  return { rows };
}

// Rows back into sections, in the order they were saved.
function toSections(rows) {
  const sections = [];
  for (const r of rows) {
    let s = sections.find((x) => x.stage === r.stage);
    if (!s) { s = { stage: r.stage, rows: [] }; sections.push(s); }
    s.rows.push(r);
  }
  return sections;
}

// entry_date arrives with add-hr-da-report.js's re-run; until then rows are saved without it.
let entryDateCol = null;
async function hasEntryDate() {
  if (entryDateCol === null) {
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'hr_da_entries' AND column_name = 'entry_date'`);
    entryDateCol = c.n > 0;
  }
  return entryDateCol;
}

async function loadReport(id) {
  const [[rep]] = await pool.query(
    `SELECT r.*, DATE_FORMAT(r.period_from, '%Y-%m-%d') AS period_from, DATE_FORMAT(r.period_to, '%Y-%m-%d') AS period_to,
            u.display_name AS created_by_name
       FROM hr_da_reports r LEFT JOIN users u ON u.id = r.created_by_user_id WHERE r.id = ?`, [id]);
  if (!rep) return null;
  const [rows] = await pool.query(
    `SELECT x.id, x.stage, x.employee_id, x.employee_name, x.violation, x.violation_type_id, x.section_violated, x.final_sanction,
            ${(await hasEntryDate()) ? "DATE_FORMAT(x.entry_date, '%Y-%m-%d')" : 'NULL'} AS entry_date,
            d.name AS department_name, e.position_title AS position
       FROM hr_da_entries x LEFT JOIN employees e ON e.id = x.employee_id LEFT JOIN departments d ON d.id = e.department_id
      WHERE x.report_id = ? ORDER BY x.sort_order, x.id`, [id]);
  return { ...rep, sections: toSections(rows) };
}

async function writeRows(conn, report, rows, userId) {
  await conn.query('DELETE FROM hr_da_entries WHERE report_id = ?', [report.id]);
  const withDate = await hasEntryDate();
  for (const r of rows) {
    const cols = Object.keys(r).filter((c) => withDate || c !== 'entry_date');
    await conn.query(
      `INSERT INTO hr_da_entries (report_id, report_month, ${cols.join(', ')}, created_by_user_id)
       VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`,
      [report.id, report.period_from, ...cols.map((c) => r[c]), userId]);
  }
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.report_no, r.report_type, DATE_FORMAT(r.period_from, '%Y-%m-%d') AS period_from,
              DATE_FORMAT(r.period_to, '%Y-%m-%d') AS period_to, r.updated_at, u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM hr_da_entries e WHERE e.report_id = r.id) AS line_count,
              (SELECT GROUP_CONCAT(DISTINCT e.stage ORDER BY e.stage SEPARATOR ', ') FROM hr_da_entries e WHERE e.report_id = r.id) AS stages
         FROM hr_da_reports r LEFT JOIN users u ON u.id = r.created_by_user_id
        ${TYPES.includes(req.query.type) ? 'WHERE r.report_type = ?' : ''}
        ORDER BY r.period_from DESC, r.report_type`, TYPES.includes(req.query.type) ? [req.query.type] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

// What the form picks from: active employees (named as printed) and HRD > Violation's list, whose
// code + name is the "Section Violated" ("Section 3.49 Tardiness and Absenteeism").
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [emps] = await pool.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, d.name AS department_name
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.is_active = 1 ORDER BY e.last_name, e.first_name`);
    let types = [];
    try {
      [types] = await pool.query(
        `SELECT id, code, name FROM hr_violation_types WHERE is_active = TRUE
          ORDER BY (code IS NULL OR code = ''),
                   CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(code, '.', 1), ' ', -1) AS UNSIGNED),
                   CAST(SUBSTRING_INDEX(code, '.', -1) AS UNSIGNED), name`);
    } catch { /* no Violation module on this box -- the section is typed */ }
    res.json({
      types: TYPES,
      stages: STAGES,
      sanctions: SANCTIONS,
      employees: emps.map((e) => ({ ...e, report_name: reportName(e) })),
      violation_types: types.map((t) => ({ ...t, label: [t.code, t.name].filter(Boolean).join(' ') })),
    });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rep = await loadReport(req.params.id);
    if (!rep) return res.status(404).json({ error: 'Not found' });
    res.json(rep);
  } catch (err) { next(err); }
});

router.get('/:id/print', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const rep = await loadReport(req.params.id);
    if (!rep) return res.status(404).json({ error: 'Not found' });
    res.json(rep);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const b = req.body || {};
  const type = TYPES.includes(b.report_type) ? b.report_type : 'monthly';
  const period = periodOf(type, b.period_from);
  if (!period) return res.status(400).json({ error: `Pick the ${type === 'weekly' ? 'week' : 'month'} of the report.` });
  const { error, rows } = readSections(b.sections, period);
  if (error) return res.status(400).json({ error });
  const conn = await pool.getConnection();
  try {
    const [[dupe]] = await conn.query('SELECT id, report_no FROM hr_da_reports WHERE report_type = ? AND period_from = ?', [type, period.from]);
    if (dupe) {
      return res.status(409).json({ error: `${dupe.report_no} is already the ${type} report for that ${type === 'weekly' ? 'week' : 'month'} -- open it and add to it.`, id: dupe.id });
    }
    await conn.beginTransaction();
    const [[mx]] = await conn.query("SELECT MAX(CAST(SUBSTRING(report_no, 4) AS UNSIGNED)) AS n FROM hr_da_reports WHERE report_no LIKE 'DA-%' FOR UPDATE");
    const no = `DA-${String((Number(mx.n) || 0) + 1).padStart(4, '0')}`;
    const [r] = await conn.query(
      'INSERT INTO hr_da_reports (report_no, report_type, period_from, period_to, remarks, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [no, type, period.from, period.to, trunc(b.remarks, 500), req.user.id]);
    await writeRows(conn, { id: r.insertId, period_from: period.from }, rows, req.user.id);
    await conn.commit();
    res.status(201).json({ id: r.insertId, report_no: no });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const b = req.body || {};
  const conn = await pool.getConnection();
  try {
    const [[rep]] = await conn.query("SELECT id, DATE_FORMAT(period_from, '%Y-%m-%d') AS period_from, DATE_FORMAT(period_to, '%Y-%m-%d') AS period_to FROM hr_da_reports WHERE id = ?", [req.params.id]);
    if (!rep) return res.status(404).json({ error: 'Not found' });
    const { error, rows } = readSections(b.sections, { from: rep.period_from, to: rep.period_to });
    if (error) return res.status(400).json({ error });
    await conn.beginTransaction();
    await conn.query('UPDATE hr_da_reports SET remarks = ? WHERE id = ?', [trunc(b.remarks, 500), rep.id]);
    await writeRows(conn, rep, rows, req.user.id);
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM hr_da_entries WHERE report_id = ?', [req.params.id]);
    const [r] = await pool.query('DELETE FROM hr_da_reports WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
