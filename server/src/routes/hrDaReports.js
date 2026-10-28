const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// HRD > DA Report (2026-10-28). HR's monthly Discipline Management Report, as the company's sheet
// ("DA REPORT FORMAT.xlsx") has it: a title with the month, a section per stage of the disciplinary
// action (NOTICE TO EXPLAIN, ...), each a table of EMPLOYEE NAME / VIOLATION / SECTION VIOLATED /
// FINAL SANCTION. One hr_da_entries row is one line of it; the month's report is every row of that
// month, grouped by stage.
const ROUTE = '/hrd/da-report';
// The usual stages, in the order the report lists them. HR may type another; it prints after these.
const STAGES = ['NOTICE TO EXPLAIN', 'NOTICE OF DECISION', 'WRITTEN WARNING', 'FINAL WARNING', 'SUSPENSION', 'TERMINATION'];
const SANCTIONS = ['ISSUED NTE', 'VERBAL WARNING', 'WRITTEN WARNING', 'FINAL WARNING', 'SUSPENSION', 'TERMINATION', 'NO SANCTION'];

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const isMonth = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));
const stageRank = (s) => { const i = STAGES.indexOf(s); return i < 0 ? STAGES.length : i; };

// The employee as the report prints them: "SUSTITUIDO, LARA".
const reportName = (e) => `${String(e.last_name || '').trim()}, ${String(e.first_name || '').trim()}`.toUpperCase().replace(/^, |, $/g, '');

function readBody(b) {
  const month = String(b.report_month || '').slice(0, 7);
  if (!isMonth(month)) return { error: 'Pick the month this goes in.' };
  const employeeName = trunc(b.employee_name, 150);
  if (!employeeName) return { error: 'Choose the employee.' };
  const violation = trunc(b.violation, 300);
  if (!violation) return { error: 'Enter the violation.' };
  return {
    values: {
      report_month: `${month}-01`,
      stage: (trunc(b.stage, 80) || STAGES[0]).toUpperCase(),
      employee_id: Number(b.employee_id) || null,
      employee_name: employeeName.toUpperCase(),
      violation,
      violation_type_id: Number(b.violation_type_id) || null,
      section_violated: trunc(b.section_violated, 300),
      final_sanction: trunc(b.final_sanction, 200)?.toUpperCase() || null,
      sort_order: Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0,
    },
  };
}

async function monthRows(month) {
  const [rows] = await pool.query(
    `SELECT d.*, DATE_FORMAT(d.report_month, '%Y-%m') AS month, u.display_name AS created_by_name
       FROM hr_da_entries d LEFT JOIN users u ON u.id = d.created_by_user_id
      WHERE d.report_month = ? ORDER BY d.sort_order, d.employee_name, d.id`, [`${month}-01`]);
  return rows.sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0));
}

// The month's lines (default this month), plus the months that have any, newest first.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const month = isMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
    const [months] = await pool.query(
      `SELECT DATE_FORMAT(report_month, '%Y-%m') AS month, COUNT(*) AS n FROM hr_da_entries
        GROUP BY report_month ORDER BY report_month DESC`);
    res.json({ month, rows: await monthRows(month), months });
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
      stages: STAGES,
      sanctions: SANCTIONS,
      employees: emps.map((e) => ({ ...e, report_name: reportName(e) })),
      violation_types: types.map((t) => ({ ...t, label: [t.code, t.name].filter(Boolean).join(' ') })),
    });
  } catch (err) { next(err); }
});

router.get('/print', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    if (!isMonth(req.query.month)) return res.status(400).json({ error: 'Pick a month.' });
    res.json({ month: req.query.month, rows: await monthRows(req.query.month) });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { error, values } = readBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(values);
    const [r] = await pool.query(
      `INSERT INTO hr_da_entries (${cols.join(', ')}, created_by_user_id) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
      [...cols.map((c) => values[c]), req.user.id]);
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { error, values } = readBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(values);
    const [r] = await pool.query(
      `UPDATE hr_da_entries SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => values[c]), req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM hr_da_entries WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
