const pool = require('../db');
const { insertFor } = require('./approvalNotifications');

// Performance Evaluation (2026-10-23; db/create-performance-module.js). What the routes share:
// the steps an evaluation goes through, its arithmetic, making a quarter's evaluations, and the
// daily reminders / quarter close.
//
// STEPS (perf_evaluations.status):
//   open              the quarter is running: employee and supervisor log remarks
//   self_rating       quarter closed: the employee rates themself
//   supervisor_rating the supervisor rates, comments, writes the development plan, sets the discussion
//   discussion        the discussion is held; the employee signs conforme
//   dept_head_review  the department head reviews (skipped when there is none, or when the head IS
//                     the supervisor -- they have just rated it)
//   hr_review         HR reviews
//   gm_approval       the General Manager approves
//   approved          final, locked
// A reviewer may RETURN it to the supervisor (supervisor_rating) with a reason.
const STATUSES = ['open', 'self_rating', 'supervisor_rating', 'discussion', 'dept_head_review', 'hr_review', 'gm_approval', 'approved'];
const STATUS_LABELS = {
  open: 'Quarter running', self_rating: 'Self rating', supervisor_rating: "Supervisor's rating", discussion: 'Discussion / conforme',
  dept_head_review: 'Department head review', hr_review: 'HR review', gm_approval: 'GM approval', approved: 'Approved',
};
const RATING_LABELS = { 4: 'Excellent', 3: 'Meets requirements', 2: 'Needs improvement', 1: 'Fail' };

const phToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

// A quarter's dates.
function quarterDates(year, quarter) {
  const q = Number(quarter);
  const start = `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(Number(year), q * 3, 0)).toISOString().slice(0, 10);
  return { start, end };
}

// The overall from the items: each section's subtotal is SUM(rating x weight%) -- on the 1-4 scale,
// since a section's weights add to 100 -- and the overall weighs the two sections (70 / 30). Null
// until every item in the section is rated.
function scores(items, kind, kraWeight, cvWeight) {
  const field = kind === 'self' ? 'self_rating' : 'superior_rating';
  const sub = (section) => {
    const list = items.filter((i) => i.section === section);
    if (!list.length || list.some((i) => !Number(i[field]))) return null;
    return r3(list.reduce((m, i) => m + Number(i[field]) * (Number(i.weight) / 100), 0));
  };
  const kra = sub('kra');
  const cv = sub('cv');
  const overall = kra != null && cv != null ? r3(kra * (Number(kraWeight) / 100) + cv * (Number(cvWeight) / 100)) : null;
  return { kra, cv, overall };
}
// The label of an overall (2.6 -> Meets requirements): rounded to the nearest level.
const overallLabel = (v) => (v == null ? null : RATING_LABELS[Math.min(4, Math.max(1, Math.round(Number(v))))]);

// Who rates a user: their supervisor on the user (users.supervisor_id), else the first one listed.
async function raterOf(conn, userId) {
  const [[u]] = await conn.query('SELECT supervisor_id FROM users WHERE id = ?', [userId]);
  if (u?.supervisor_id) return Number(u.supervisor_id);
  const [[s]] = await conn.query('SELECT supervisor_id FROM user_supervisors WHERE user_id = ? ORDER BY id LIMIT 1', [userId]).catch(() => [[null]]);
  return s?.supervisor_id ? Number(s.supervisor_id) : null;
}

// Makes a quarter's evaluations: every active user whose employee record carries a position with an
// active template gets one (an existing one is left alone). Its KRAs and the core values are COPIED,
// so editing a template later never rewrites a quarter already evaluated. -> { created, skipped }
async function generateEvaluations(cycleId) {
  const [[cycle]] = await pool.query('SELECT * FROM perf_cycles WHERE id = ?', [cycleId]);
  if (!cycle) throw new Error('Cycle not found.');
  const [templates] = await pool.query('SELECT * FROM perf_templates WHERE is_active = 1');
  const byPos = new Map(templates.map((t) => [String(t.position_title).trim().toLowerCase(), t]));
  const [kras] = await pool.query('SELECT * FROM perf_template_kras ORDER BY template_id, sort_order, id');
  const [cvs] = await pool.query('SELECT * FROM perf_core_values WHERE is_active = 1 ORDER BY sort_order, id');
  const [people] = await pool.query(
    `SELECT u.id AS user_id, u.display_name, e.id AS employee_id, e.position_title, e.department_id, d.head_user_id
       FROM users u JOIN employees e ON e.id = u.employee_id LEFT JOIN departments d ON d.id = e.department_id
      WHERE u.is_active = 1`);
  const created = [];
  const skipped = [];
  for (const p of people) {
    const t = byPos.get(String(p.position_title || '').trim().toLowerCase());
    if (!t) { skipped.push({ user_id: p.user_id, name: p.display_name, position_title: p.position_title || null }); continue; }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const rater = await raterOf(conn, p.user_id);
      const head = p.head_user_id && Number(p.head_user_id) !== Number(p.user_id) ? Number(p.head_user_id) : null;
      const [r] = await conn.query(
        `INSERT IGNORE INTO perf_evaluations (cycle_id, user_id, employee_id, template_id, position_title, department_id, rater_user_id, dept_head_user_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cycle.id, p.user_id, p.employee_id, t.id, t.position_title, p.department_id, rater, head, cycle.status === 'open' ? 'open' : 'self_rating']);
      if (!r.affectedRows) { await conn.rollback(); continue; }
      let i = 0;
      for (const k of kras.filter((x) => Number(x.template_id) === Number(t.id))) {
        await conn.query('INSERT INTO perf_evaluation_items (evaluation_id, section, sort_order, label, weight, kpi, timeframe) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [r.insertId, 'kra', i, k.kra, k.weight, k.kpi, k.timeframe]);
        i += 1;
      }
      for (const c of cvs) {
        await conn.query('INSERT INTO perf_evaluation_items (evaluation_id, section, sort_order, label, description, weight) VALUES (?, ?, ?, ?, ?, ?)',
          [r.insertId, 'cv', i, c.name, c.description, c.weight]);
        i += 1;
      }
      await conn.commit();
      created.push(r.insertId);
    } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  }
  return { created, skipped };
}

// The remarks of the quarter written into each item's Actual Results / Critical Incidents, oldest
// first, marked by who logged them -- the starting point the employee and supervisor rate from.
// On a core value the supervisor's remarks go to the rater's own field (rater_results).
async function prefillFromRemarks(evaluationId) {
  const [remarks] = await pool.query(
    `SELECT r.item_id, r.remark_date, r.author_role, r.body, i.section FROM perf_remarks r
       JOIN perf_evaluation_items i ON i.id = r.item_id
      WHERE r.evaluation_id = ? ORDER BY r.remark_date, r.id`, [evaluationId]);
  const byField = new Map();
  for (const r of remarks) {
    const sup = r.author_role === 'supervisor';
    const col = r.section === 'cv' && sup ? 'rater_results' : 'actual_results';
    const line = `${String(r.remark_date).slice(0, 10)} (${sup ? 'Supervisor' : 'Employee'}): ${r.body}`;
    const k = `${r.item_id}|${col}`;
    byField.set(k, [...(byField.get(k) || []), line]);
  }
  for (const [k, lines] of byField) {
    const [itemId, col] = k.split('|');
    await pool.query(`UPDATE perf_evaluation_items SET ${col} = ? WHERE id = ? AND (${col} IS NULL OR ${col} = '')`,
      [lines.join('\n'), itemId]);
  }
}

// Closes a quarter: its open evaluations move to self rating, their remarks fill Actual Results, and
// each employee is told to rate themself.
async function closeCycle(cycleId, actorId = null) {
  const [r] = await pool.query("UPDATE perf_cycles SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'", [nowUtc(), cycleId]);
  const [[cycle]] = await pool.query('SELECT * FROM perf_cycles WHERE id = ?', [cycleId]);
  const [evals] = await pool.query("SELECT id, user_id FROM perf_evaluations WHERE cycle_id = ? AND status = 'open'", [cycleId]);
  for (const e of evals) {
    await prefillFromRemarks(e.id);
    await pool.query("UPDATE perf_evaluations SET status = 'self_rating' WHERE id = ? AND status = 'open'", [e.id]);
    await insertFor([e.user_id], {
      type: 'performance', title: `Q${cycle.quarter} ${cycle.year} evaluation: rate yourself`,
      message: 'The quarter has closed. Give your self rating, then your supervisor rates you (Forms > My Performance).',
      relatedType: 'PerfEvaluation', relatedId: e.id,
    }, actorId).catch(() => {});
  }
  return { closed: !!r.affectedRows, evaluations: evals.length };
}

// Daily (with the exam reminders): a quarter past its end closes; two weeks before a quarter ends,
// a supervisor with no remark yet on someone they rate is reminded, once per evaluation.
async function runPerformanceJobs() {
  const today = phToday();
  let closed = 0;
  let reminded = 0;
  const [due] = await pool.query("SELECT id FROM perf_cycles WHERE status = 'open' AND end_date < ?", [today]).catch(() => [[]]);
  for (const c of due) { await closeCycle(c.id); closed += 1; }
  const [quiet] = await pool.query(
    `SELECT e.id, e.rater_user_id, c.quarter, c.year, c.end_date, u.display_name
       FROM perf_evaluations e JOIN perf_cycles c ON c.id = e.cycle_id JOIN users u ON u.id = e.user_id
      WHERE c.status = 'open' AND e.status = 'open' AND e.rater_user_id IS NOT NULL AND e.reminded_at IS NULL
        AND DATEDIFF(c.end_date, ?) BETWEEN 0 AND 14
        AND NOT EXISTS (SELECT 1 FROM perf_remarks r WHERE r.evaluation_id = e.id AND r.author_role = 'supervisor')`, [today]).catch(() => [[]]);
  for (const e of quiet) {
    const [r] = await pool.query('UPDATE perf_evaluations SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL', [nowUtc(), e.id]);
    if (!r.affectedRows) continue;
    await insertFor([e.rater_user_id], {
      type: 'performance_reminder', title: `Remarks for ${e.display_name} before Q${e.quarter} ends`,
      message: `You have no remarks yet on ${e.display_name} this quarter (ends ${String(e.end_date).slice(0, 10)}).`,
      relatedType: 'PerfEvaluation', relatedId: e.id,
    }, null).catch(() => {});
    reminded += 1;
  }
  return { performance_closed: closed, performance_reminders: reminded };
}

module.exports = {
  STATUSES, STATUS_LABELS, RATING_LABELS, phToday, nowUtc, quarterDates, scores, overallLabel,
  generateEvaluations, prefillFromRemarks, closeCycle, runPerformanceJobs,
};
