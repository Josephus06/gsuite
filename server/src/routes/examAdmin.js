const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { insertFor } = require('../lib/approvalNotifications');
const {
  TYPES, CHOICE_TYPES, parseJson, phToday, day, cleanQuestion, targetUserIds, createAttempts, sweep, finalize,
  topicBreakdown, recommendOrientations, aiAllowed, extractQuestions, evaluateAttempt, summarizeSchedule, nowUtc,
} = require('../lib/exams');

const router = express.Router();

// HRD > Examinations and HRD > Question Bank (2026-10-21; lib/exams.js).
//
//   Question Bank (/hrd/exam-questions)  department heads keep their own department's questions --
//     typed in, or a PDF read by the AI into drafts they review and save. View All (HR) reaches
//     every department; anyone else only the departments they head (departments.head_user_id).
//   Examinations (/hrd/exams)  HR: exam sets built from the bank, schedules (a set for departments
//     and/or users over a date window), results per topic, essay grading, the AI evaluation,
//     re-orientation (recommended -> scheduled -> attended on date X) and retakes.
const QB = '/hrd/exam-questions';
const EX = '/hrd/exams';

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Departments, labelled by location where a name repeats (three "Sales").
async function departments() {
  const [rows] = await pool.query(
    `SELECT d.id, d.name, d.head_user_id, l.location_name, hu.display_name AS head_name
       FROM departments d LEFT JOIN locations l ON l.id = d.job_location_id LEFT JOIN users hu ON hu.id = d.head_user_id
      WHERE d.is_active = 1 ORDER BY d.name, l.location_name`);
  const count = rows.reduce((m, r) => m.set(r.name, (m.get(r.name) || 0) + 1), new Map());
  return rows.map((r) => ({ ...r, label: count.get(r.name) > 1 && r.location_name ? `${r.name} (${r.location_name})` : r.name }));
}

// Which departments' questions this user keeps: all (View All on the bank) or those they head.
async function bankScope(userId) {
  if (await userCan(userId, QB, 'can_view_all')) return { all: true, ids: [] };
  const [rows] = await pool.query('SELECT id FROM departments WHERE head_user_id = ? AND is_active = 1', [userId]);
  return { all: false, ids: rows.map((r) => Number(r.id)) };
}
const inScope = (scope, deptId) => scope.all || scope.ids.includes(Number(deptId));

const shapeQuestion = (q) => ({
  ...q, choices: parseJson(q.choices, null), answer: parseJson(q.answer, null), points: Number(q.points),
  used: Number(q.used || 0) > 0,
});

// ---------------------------------------------------------------- Question Bank

router.get('/bank/meta', requireAuth, requirePermission(QB, 'can_view'), async (req, res, next) => {
  try {
    const scope = await bankScope(req.user.id);
    const depts = (await departments()).filter((d) => inScope(scope, d.id));
    const [topics] = await pool.query('SELECT id, department_id, name, orientation_name, is_active FROM exam_topics ORDER BY name');
    res.json({ departments: depts, topics: topics.filter((t) => !t.department_id || inScope(scope, t.department_id)), all: scope.all, types: TYPES });
  } catch (err) { next(err); }
});

router.post('/topics', requireAuth, requirePermission(QB, 'can_add'), async (req, res, next) => {
  try {
    const scope = await bankScope(req.user.id);
    const deptId = Number(req.body.department_id) || null;
    if (deptId ? !inScope(scope, deptId) : !scope.all) return bad(res, 'You can only add topics for a department you head.', 403);
    const name = String(req.body.name || '').trim().slice(0, 150);
    if (!name) return bad(res, 'Name the topic.');
    const [[dup]] = await pool.query('SELECT id FROM exam_topics WHERE name = ? AND (department_id <=> ?)', [name, deptId]);
    if (dup) return bad(res, 'That topic already exists.');
    const orientation = String(req.body.orientation_name || '').trim().slice(0, 200) || `${name} Orientation`;
    const [r] = await pool.query('INSERT INTO exam_topics (department_id, name, orientation_name, created_by_user_id) VALUES (?, ?, ?, ?)',
      [deptId, name, orientation, req.user.id]);
    res.json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.put('/topics/:id', requireAuth, requirePermission(QB, 'can_edit'), async (req, res, next) => {
  try {
    const scope = await bankScope(req.user.id);
    const [[t]] = await pool.query('SELECT * FROM exam_topics WHERE id = ?', [req.params.id]);
    if (!t) return bad(res, 'Topic not found.', 404);
    if (t.department_id ? !inScope(scope, t.department_id) : !scope.all) return bad(res, 'Not your department\'s topic.', 403);
    const name = String(req.body.name ?? t.name).trim().slice(0, 150);
    if (!name) return bad(res, 'Name the topic.');
    await pool.query('UPDATE exam_topics SET name = ?, orientation_name = ?, is_active = ? WHERE id = ?',
      [name, String(req.body.orientation_name ?? t.orientation_name ?? '').trim().slice(0, 200) || null,
        req.body.is_active === undefined ? t.is_active : (req.body.is_active ? 1 : 0), t.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/questions', requireAuth, requirePermission(QB, 'can_view'), async (req, res, next) => {
  try {
    const scope = await bankScope(req.user.id);
    const where = ['q.is_active = 1'];
    const params = [];
    if (!scope.all) {
      if (!scope.ids.length) return res.json({ rows: [], total: 0 });
      where.push('q.department_id IN (?)'); params.push(scope.ids);
    }
    if (Number(req.query.department_id)) { where.push('q.department_id = ?'); params.push(Number(req.query.department_id)); }
    if (Number(req.query.topic_id)) { where.push('q.topic_id = ?'); params.push(Number(req.query.topic_id)); }
    if (TYPES.includes(req.query.type)) { where.push('q.type = ?'); params.push(req.query.type); }
    if (req.query.q) { where.push('q.question LIKE ?'); params.push(`%${req.query.q}%`); }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM exam_questions q WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(
      `SELECT q.*, t.name AS topic, d.name AS department, u.display_name AS created_by,
              (SELECT COUNT(*) FROM exam_attempt_answers x WHERE x.question_id = q.id) AS used
         FROM exam_questions q LEFT JOIN exam_topics t ON t.id = q.topic_id LEFT JOIN departments d ON d.id = q.department_id
         LEFT JOIN users u ON u.id = q.created_by_user_id
        WHERE ${where.join(' AND ')} ORDER BY q.id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ rows: rows.map(shapeQuestion), total: Number(total), page, limit });
  } catch (err) { next(err); }
});

// A topic named in a draft (from the PDF import) that is not in the bank yet is created for the
// department.
async function topicIdFor(conn, deptId, q, userId) {
  if (Number(q.topic_id)) return Number(q.topic_id);
  const name = String(q.topic || '').trim().slice(0, 150);
  if (!name) return null;
  const [[t]] = await conn.query('SELECT id FROM exam_topics WHERE name = ? AND (department_id = ? OR department_id IS NULL) ORDER BY department_id IS NULL LIMIT 1', [name, deptId]);
  if (t) return Number(t.id);
  const [r] = await conn.query('INSERT INTO exam_topics (department_id, name, orientation_name, created_by_user_id) VALUES (?, ?, ?, ?)',
    [deptId, name, `${name} Orientation`, userId]);
  return r.insertId;
}

async function saveQuestions(req, res, list, source) {
  const scope = await bankScope(req.user.id);
  const deptId = Number(req.body.department_id);
  if (!deptId || !inScope(scope, deptId)) return bad(res, 'Pick a department you keep questions for.', 403);
  const cleaned = list.map((q, i) => ({ i, q, c: cleanQuestion(q) }));
  const errors = cleaned.filter((x) => x.c.error).map((x) => `#${x.i + 1}: ${x.c.error}`);
  if (errors.length) return bad(res, errors.slice(0, 8).join(' '));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const ids = [];
    for (const { q, c } of cleaned) {
      const topicId = await topicIdFor(conn, deptId, q, req.user.id);
      const [r] = await conn.query(
        `INSERT INTO exam_questions (department_id, topic_id, type, question, choices, answer, points, difficulty, source, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [deptId, topicId, c.type, c.question, c.choices ? JSON.stringify(c.choices) : null, JSON.stringify(c.answer), c.points, c.difficulty, source, req.user.id]);
      ids.push(r.insertId);
    }
    await conn.commit();
    return res.json({ ok: true, ids, count: ids.length });
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
}

router.post('/questions', requireAuth, requirePermission(QB, 'can_add'), async (req, res, next) => {
  try { await saveQuestions(req, res, [req.body], 'manual'); } catch (err) { next(err); }
});

// The reviewed drafts of a PDF import, saved together.
router.post('/questions/bulk', requireAuth, requirePermission(QB, 'can_add'), async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.questions) ? req.body.questions : [];
    if (!list.length) return bad(res, 'No questions to save.');
    if (list.length > 300) return bad(res, 'Save at most 300 questions at a time.');
    await saveQuestions(req, res, list, req.body.source === 'pdf' ? 'pdf' : 'manual');
  } catch (err) { next(err); }
});

// Read a PDF (up to 10MB) or pasted text into DRAFT questions -- nothing is saved here.
router.post('/questions/import', requireAuth, requirePermission(QB, 'can_add'), async (req, res, next) => {
  try {
    const scope = await bankScope(req.user.id);
    const deptId = Number(req.body.department_id);
    if (!deptId || !inScope(scope, deptId)) return bad(res, 'Pick a department you keep questions for.', 403);
    const pdf = String(req.body.file_data || '').replace(/^data:[^,]*,/, '');
    const text = String(req.body.text || '').trim();
    if (!pdf && !text) return bad(res, 'Attach a PDF or paste the questions.');
    if (pdf && pdf.length > 14 * 1024 * 1024) return bad(res, 'The PDF is over 10MB.');
    if (!aiAllowed(req.user.id, 4)) return bad(res, 'Too many imports at once -- wait a minute.', 429);
    const [topics] = await pool.query('SELECT name FROM exam_topics WHERE is_active = 1 AND (department_id = ? OR department_id IS NULL)', [deptId]);
    const drafts = await extractQuestions({ pdfBase64: pdf || null, fileName: req.body.file_name, text: pdf ? null : text, topics: topics.map((t) => t.name) });
    res.json({ drafts });
  } catch (err) { next(err); }
});

router.put('/questions/:id', requireAuth, requirePermission(QB, 'can_edit'), async (req, res, next) => {
  try {
    const scope = await bankScope(req.user.id);
    const [[q]] = await pool.query('SELECT q.*, (SELECT COUNT(*) FROM exam_attempt_answers x WHERE x.question_id = q.id) AS used FROM exam_questions q WHERE q.id = ?', [req.params.id]);
    if (!q || !q.is_active) return bad(res, 'Question not found.', 404);
    if (!inScope(scope, q.department_id)) return bad(res, 'Not your department\'s question.', 403);
    const c = cleanQuestion(req.body);
    if (c.error) return bad(res, c.error);
    // Once someone has taken it, its answer key is part of their score: wording and topic may be
    // corrected, but the type, choices, answer and points stay. A changed question is a new one.
    if (Number(q.used) > 0 && (c.type !== q.type || JSON.stringify(c.choices) !== JSON.stringify(parseJson(q.choices, null))
      || JSON.stringify(c.answer) !== JSON.stringify(parseJson(q.answer, null)) || c.points !== Number(q.points))) {
      return bad(res, 'This question has already been answered in an exam, so its choices, answer and points cannot change. Add a new question instead.');
    }
    const topicId = await topicIdFor(pool, q.department_id, req.body, req.user.id);
    await pool.query('UPDATE exam_questions SET topic_id = ?, type = ?, question = ?, choices = ?, answer = ?, points = ?, difficulty = ? WHERE id = ?',
      [topicId, c.type, c.question, c.choices ? JSON.stringify(c.choices) : null, JSON.stringify(c.answer), c.points, c.difficulty, q.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Removed from the bank. One already in a set or an exam is only retired, so results keep it.
router.delete('/questions/:id', requireAuth, requirePermission(QB, 'can_delete'), async (req, res, next) => {
  try {
    const scope = await bankScope(req.user.id);
    const [[q]] = await pool.query('SELECT * FROM exam_questions WHERE id = ?', [req.params.id]);
    if (!q) return bad(res, 'Question not found.', 404);
    if (!inScope(scope, q.department_id)) return bad(res, 'Not your department\'s question.', 403);
    const [[{ n }]] = await pool.query(
      'SELECT (SELECT COUNT(*) FROM exam_set_questions WHERE question_id = ?) + (SELECT COUNT(*) FROM exam_attempt_answers WHERE question_id = ?) AS n', [q.id, q.id]);
    if (Number(n)) await pool.query('UPDATE exam_questions SET is_active = 0 WHERE id = ?', [q.id]);
    else await pool.query('DELETE FROM exam_questions WHERE id = ?', [q.id]);
    res.json({ ok: true, retired: Number(n) > 0 });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- Exam sets

router.get('/meta', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    const [topics] = await pool.query('SELECT id, department_id, name, orientation_name FROM exam_topics WHERE is_active = 1 ORDER BY name');
    const [users] = await pool.query(
      `SELECT u.id, u.display_name, e.department_id, d.name AS department
         FROM users u LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN departments d ON d.id = e.department_id
        WHERE u.is_active = 1 ORDER BY u.display_name`);
    res.json({ departments: await departments(), topics, users, types: TYPES });
  } catch (err) { next(err); }
});

// Every department's questions, for building a set (HR reads across the bank).
router.get('/question-pool', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    const where = ['q.is_active = 1'];
    const params = [];
    if (Number(req.query.department_id)) { where.push('q.department_id = ?'); params.push(Number(req.query.department_id)); }
    if (Number(req.query.topic_id)) { where.push('q.topic_id = ?'); params.push(Number(req.query.topic_id)); }
    if (TYPES.includes(req.query.type)) { where.push('q.type = ?'); params.push(req.query.type); }
    if (req.query.q) { where.push('q.question LIKE ?'); params.push(`%${req.query.q}%`); }
    const [rows] = await pool.query(
      `SELECT q.id, q.department_id, q.topic_id, q.type, q.question, q.points, q.difficulty, t.name AS topic, d.name AS department
         FROM exam_questions q LEFT JOIN exam_topics t ON t.id = q.topic_id LEFT JOIN departments d ON d.id = q.department_id
        WHERE ${where.join(' AND ')} ORDER BY t.name, q.id LIMIT 2000`, params);
    res.json(rows.map((r) => ({ ...r, points: Number(r.points) })));
  } catch (err) { next(err); }
});

router.get('/sets', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT st.*, d.name AS department, u.display_name AS created_by,
              (SELECT COUNT(*) FROM exam_set_questions sq WHERE sq.set_id = st.id) AS question_count,
              (SELECT COALESCE(SUM(q.points), 0) FROM exam_set_questions sq JOIN exam_questions q ON q.id = sq.question_id WHERE sq.set_id = st.id) AS total_points,
              (SELECT COUNT(*) FROM exam_schedules s WHERE s.set_id = st.id AND s.status <> 'cancelled') AS schedule_count
         FROM exam_sets st LEFT JOIN departments d ON d.id = st.department_id LEFT JOIN users u ON u.id = st.created_by_user_id
        WHERE st.is_active = 1 ORDER BY st.id DESC`);
    res.json(rows.map((r) => ({ ...r, total_points: Number(r.total_points) })));
  } catch (err) { next(err); }
});

router.get('/sets/:id', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    const [[st]] = await pool.query('SELECT * FROM exam_sets WHERE id = ?', [req.params.id]);
    if (!st) return bad(res, 'Set not found.', 404);
    const [qs] = await pool.query(
      `SELECT q.*, t.name AS topic, d.name AS department FROM exam_set_questions sq JOIN exam_questions q ON q.id = sq.question_id
         LEFT JOIN exam_topics t ON t.id = q.topic_id LEFT JOIN departments d ON d.id = q.department_id
        WHERE sq.set_id = ? ORDER BY sq.sort_order, sq.id`, [st.id]);
    const [[{ started }]] = await pool.query(
      "SELECT COUNT(*) AS started FROM exam_attempts WHERE set_id = ? AND status IN ('in_progress', 'submitted')", [st.id]);
    return res.json({ ...st, questions: qs.map(shapeQuestion), locked: Number(started) > 0 });
  } catch (err) { return next(err); }
});

function cleanSet(b) {
  const name = String(b.name || '').trim().slice(0, 150);
  if (!name) return { error: 'Name the set (e.g. SET 1).' };
  const ids = [...new Set((Array.isArray(b.question_ids) ? b.question_ids : []).map(Number).filter(Boolean))];
  if (!ids.length) return { error: 'Add at least one question.' };
  const passing = Number(b.passing_percent ?? 75);
  const reorient = Number(b.reorient_below_percent ?? 60);
  if (!(passing > 0 && passing <= 100) || !(reorient >= 0 && reorient <= 100)) return { error: 'Percentages must be between 0 and 100.' };
  const limit = b.time_limit_minutes === '' || b.time_limit_minutes == null ? null : Number(b.time_limit_minutes);
  if (limit != null && !(limit > 0 && limit <= 600)) return { error: 'The time limit is in minutes (1 to 600), or blank for none.' };
  return {
    name, ids, passing, reorient, limit, department_id: Number(b.department_id) || null,
    description: String(b.description || '').trim().slice(0, 500) || null,
  };
}

async function writeSetQuestions(conn, setId, ids) {
  await conn.query('DELETE FROM exam_set_questions WHERE set_id = ?', [setId]);
  for (let i = 0; i < ids.length; i += 1) {
    await conn.query('INSERT INTO exam_set_questions (set_id, question_id, sort_order) VALUES (?, ?, ?)', [setId, ids[i], i]);
  }
}

router.post('/sets', requireAuth, requirePermission(EX, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const c = cleanSet(req.body);
    if (c.error) return bad(res, c.error);
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM exam_questions WHERE id IN (?) AND is_active = 1', [c.ids]);
    if (Number(n) !== c.ids.length) return bad(res, 'Some of those questions are no longer in the bank.');
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO exam_sets (name, department_id, description, time_limit_minutes, passing_percent, reorient_below_percent, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [c.name, c.department_id, c.description, c.limit, c.passing, c.reorient, req.user.id]);
    await writeSetQuestions(conn, r.insertId, c.ids);
    await conn.commit();
    return res.json({ id: r.insertId });
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

router.put('/sets/:id', requireAuth, requirePermission(EX, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[st]] = await conn.query('SELECT * FROM exam_sets WHERE id = ?', [req.params.id]);
    if (!st) return bad(res, 'Set not found.', 404);
    const c = cleanSet(req.body);
    if (c.error) return bad(res, c.error);
    const [[{ started }]] = await conn.query("SELECT COUNT(*) AS started FROM exam_attempts WHERE set_id = ? AND status IN ('in_progress', 'submitted')", [st.id]);
    const [cur] = await conn.query('SELECT question_id FROM exam_set_questions WHERE set_id = ? ORDER BY sort_order, id', [st.id]);
    const same = JSON.stringify(cur.map((r) => Number(r.question_id))) === JSON.stringify(c.ids);
    // Once anyone has taken it, the set's questions and scoring are what their result was measured
    // against -- copy it to a new set instead.
    if (Number(started) && (!same || c.passing !== Number(st.passing_percent))) {
      return bad(res, 'This set has already been taken, so its questions and passing score cannot change. Make a new set.');
    }
    await conn.beginTransaction();
    await conn.query(
      'UPDATE exam_sets SET name = ?, department_id = ?, description = ?, time_limit_minutes = ?, passing_percent = ?, reorient_below_percent = ? WHERE id = ?',
      [c.name, c.department_id, c.description, c.limit, c.passing, c.reorient, st.id]);
    if (!same) await writeSetQuestions(conn, st.id, c.ids);
    await conn.commit();
    return res.json({ ok: true });
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

router.delete('/sets/:id', requireAuth, requirePermission(EX, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('UPDATE exam_sets SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- Schedules

router.get('/schedules', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    await sweep();
    const [rows] = await pool.query(
      `SELECT s.*, st.name AS set_name, u.display_name AS created_by,
              COUNT(a.id) AS assigned, SUM(a.status = 'submitted') AS submitted, SUM(a.status = 'in_progress') AS in_progress,
              SUM(a.status = 'missed') AS missed, SUM(a.passed = 1) AS passed, AVG(CASE WHEN a.status = 'submitted' THEN a.percent END) AS avg_percent,
              SUM(a.essays_pending > 0) AS to_grade,
              (SELECT GROUP_CONCAT(COALESCE(d.name, tu.display_name) SEPARATOR ', ') FROM exam_schedule_targets t
                 LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN users tu ON tu.id = t.user_id WHERE t.schedule_id = s.id) AS targets
         FROM exam_schedules s JOIN exam_sets st ON st.id = s.set_id LEFT JOIN users u ON u.id = s.created_by_user_id
         LEFT JOIN exam_attempts a ON a.schedule_id = s.id
        GROUP BY s.id ORDER BY s.status = 'cancelled', s.end_date DESC, s.id DESC`);
    const today = phToday();
    res.json(rows.map((r) => ({
      ...r,
      window: r.status === 'cancelled' ? 'cancelled' : today < day(r.start_date) ? 'upcoming' : today > day(r.end_date) ? 'closed' : 'open',
      avg_percent: r.avg_percent == null ? null : Math.round(Number(r.avg_percent) * 10) / 10,
      ai_summary: undefined,
    })));
  } catch (err) { next(err); }
});

async function scheduleFor(conn, { setId, title, start, end, departmentIds, userIds, retakeOf }, actorId) {
  const [r] = await conn.query(
    'INSERT INTO exam_schedules (set_id, title, start_date, end_date, retake_of_attempt_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    [setId, title, start, end, retakeOf || null, actorId]);
  const schedule = { id: r.insertId, set_id: setId };
  for (const d of departmentIds) await conn.query('INSERT INTO exam_schedule_targets (schedule_id, department_id) VALUES (?, ?)', [schedule.id, d]);
  for (const u of userIds) await conn.query('INSERT INTO exam_schedule_targets (schedule_id, user_id) VALUES (?, ?)', [schedule.id, u]);
  const added = await createAttempts(conn, schedule, await targetUserIds(conn, departmentIds, userIds));
  return { schedule, added };
}

async function notifyExaminees(scheduleId, userIds, title, start, end, actorId) {
  try {
    const [rows] = userIds.length ? await pool.query('SELECT id, user_id FROM exam_attempts WHERE schedule_id = ? AND user_id IN (?)', [scheduleId, userIds]) : [[]];
    for (const a of rows) {
      await insertFor([a.user_id], {
        type: 'exam', title: `Exam: ${title}`, message: `Take it between ${start} and ${end} (Forms > My Exams).`,
        relatedType: 'ExamAttempt', relatedId: a.id,
      }, actorId);
    }
  } catch (err) { console.error('[exams] notify:', err.message); }
}

function cleanWindow(b) {
  if (!isDate(b.start_date) || !isDate(b.end_date)) return { error: 'Set the date the exam opens and the date it must be done by.' };
  if (b.end_date < b.start_date) return { error: 'The end date is before the start date.' };
  if (b.end_date < phToday()) return { error: 'The end date has already passed.' };
  return { start: b.start_date, end: b.end_date };
}

router.post('/schedules', requireAuth, requirePermission(EX, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[st]] = await conn.query('SELECT id, name, (SELECT COUNT(*) FROM exam_set_questions WHERE set_id = exam_sets.id) AS n FROM exam_sets WHERE id = ? AND is_active = 1', [req.body.set_id]);
    if (!st) return bad(res, 'Pick the exam set.');
    if (!Number(st.n)) return bad(res, 'That set has no questions.');
    const w = cleanWindow(req.body);
    if (w.error) return bad(res, w.error);
    const departmentIds = [...new Set((req.body.department_ids || []).map(Number).filter(Boolean))];
    const userIds = [...new Set((req.body.user_ids || []).map(Number).filter(Boolean))];
    if (!departmentIds.length && !userIds.length) return bad(res, 'Assign it to at least one department or person.');
    const title = String(req.body.title || '').trim().slice(0, 200) || st.name;
    await conn.beginTransaction();
    const { schedule, added } = await scheduleFor(conn, { setId: st.id, title, start: w.start, end: w.end, departmentIds, userIds }, req.user.id);
    await conn.commit();
    notifyExaminees(schedule.id, added, title, w.start, w.end, req.user.id);
    return res.json({ id: schedule.id, assigned: added.length });
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

// More departments or people on an open schedule.
router.post('/schedules/:id/targets', requireAuth, requirePermission(EX, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[s]] = await conn.query('SELECT * FROM exam_schedules WHERE id = ?', [req.params.id]);
    if (!s || s.status !== 'active') return bad(res, 'Schedule not found or cancelled.', 404);
    if (day(s.end_date) < phToday()) return bad(res, 'This schedule has closed. Make a new one.');
    const departmentIds = [...new Set((req.body.department_ids || []).map(Number).filter(Boolean))];
    const userIds = [...new Set((req.body.user_ids || []).map(Number).filter(Boolean))];
    await conn.beginTransaction();
    for (const d of departmentIds) await conn.query('INSERT INTO exam_schedule_targets (schedule_id, department_id) VALUES (?, ?)', [s.id, d]);
    for (const u of userIds) await conn.query('INSERT INTO exam_schedule_targets (schedule_id, user_id) VALUES (?, ?)', [s.id, u]);
    const added = await createAttempts(conn, s, await targetUserIds(conn, departmentIds, userIds));
    await conn.commit();
    notifyExaminees(s.id, added, s.title, day(s.start_date), day(s.end_date), req.user.id);
    return res.json({ assigned: added.length });
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

router.post('/schedules/:id/cancel', requireAuth, requirePermission(EX, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query("UPDATE exam_schedules SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// One schedule's results: every examinee with their score, and the topic matrix -- each examinee's
// percent per topic, under the set's re-orientation line flagged.
async function scheduleResults(scheduleId) {
  const [[s]] = await pool.query(
    `SELECT s.*, st.name AS set_name, st.passing_percent, st.reorient_below_percent, st.time_limit_minutes
       FROM exam_schedules s JOIN exam_sets st ON st.id = s.set_id WHERE s.id = ?`, [scheduleId]);
  if (!s) return null;
  const [attempts] = await pool.query(
    `SELECT a.id, a.user_id, a.status, a.started_at, a.submitted_at, a.auto_submitted, a.score, a.max_score, a.percent, a.passed,
            a.essays_pending, a.tab_switches, a.ai_evaluation IS NOT NULL AS has_ai, u.display_name AS name, d.name AS department
       FROM exam_attempts a JOIN users u ON u.id = a.user_id LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE a.schedule_id = ? ORDER BY d.name, u.display_name`, [scheduleId]);
  const breakdown = await topicBreakdown(attempts.filter((a) => a.status === 'submitted').map((a) => a.id));
  const topics = new Map();
  for (const list of breakdown.values()) for (const t of list) if (!topics.has(t.topic_id || 0)) topics.set(t.topic_id || 0, { topic_id: t.topic_id, topic: t.topic, orientation_name: t.orientation_name });
  const topicList = [...topics.values()].sort((a, b) => a.topic.localeCompare(b.topic));
  const avg = {};
  const weak = {};
  for (const t of topicList) {
    const vals = [...breakdown.values()].map((list) => list.find((x) => (x.topic_id || 0) === (t.topic_id || 0))).filter(Boolean);
    avg[t.topic_id || 0] = vals.length ? Math.round((vals.reduce((m, v) => m + v.percent, 0) / vals.length) * 10) / 10 : null;
    weak[t.topic_id || 0] = vals.filter((v) => v.percent < Number(s.reorient_below_percent)).length;
  }
  return {
    schedule: s, topics: topicList, topic_avg: avg, weak_counts: weak,
    attempts: attempts.map((a) => ({
      ...a, has_ai: !!Number(a.has_ai),
      topics: Object.fromEntries((breakdown.get(Number(a.id)) || []).map((t) => [t.topic_id || 0, { percent: t.percent, earned: t.earned, max: t.max }])),
    })),
  };
}

router.get('/schedules/:id', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    await sweep({ scheduleId: Number(req.params.id) });
    const r = await scheduleResults(Number(req.params.id));
    if (!r) return bad(res, 'Schedule not found.', 404);
    const [targets] = await pool.query(
      `SELECT t.department_id, t.user_id, d.name AS department, u.display_name AS user FROM exam_schedule_targets t
         LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN users u ON u.id = t.user_id WHERE t.schedule_id = ?`, [req.params.id]);
    return res.json({ ...r, targets });
  } catch (err) { return next(err); }
});

router.post('/schedules/:id/ai-summary', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    if (!aiAllowed(req.user.id)) return bad(res, 'Too many AI requests -- wait a minute.', 429);
    const r = await scheduleResults(Number(req.params.id));
    if (!r) return bad(res, 'Schedule not found.', 404);
    const done = r.attempts.filter((a) => a.status === 'submitted');
    if (!done.length) return bad(res, 'Nobody has submitted this exam yet.');
    const [hard] = await pool.query(
      `SELECT q.question, t.name AS topic, COUNT(*) AS n, SUM(COALESCE(x.points_awarded, 0) < q.points) AS wrong
         FROM exam_attempt_answers x JOIN exam_attempts a ON a.id = x.attempt_id JOIN exam_questions q ON q.id = x.question_id
         LEFT JOIN exam_topics t ON t.id = q.topic_id
        WHERE a.schedule_id = ? AND a.status = 'submitted' AND NOT (q.type = 'essay' AND x.points_awarded IS NULL)
        GROUP BY q.id HAVING wrong > 0 ORDER BY wrong / n DESC, wrong DESC LIMIT 8`, [req.params.id]);
    const passed = done.filter((a) => Number(a.passed) === 1).length;
    const text = await summarizeSchedule({
      title: r.schedule.title, setName: r.schedule.set_name, threshold: Number(r.schedule.reorient_below_percent),
      stats: `Assigned ${r.attempts.length}, submitted ${done.length}, missed ${r.attempts.filter((a) => a.status === 'missed').length}, passed ${passed} (passing ${Number(r.schedule.passing_percent)}%).`,
      topicAvg: r.topics.map((t) => ({ ...t, percent: r.topic_avg[t.topic_id || 0] })), weakCounts: r.weak_counts,
      hardest: hard.map((h) => ({ ...h, question: String(h.question).slice(0, 200), topic: h.topic || 'General' })),
    });
    await pool.query('UPDATE exam_schedules SET ai_summary = ?, ai_summary_at = ? WHERE id = ?', [text, nowUtc(), req.params.id]);
    return res.json({ ai_summary: text });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------- One attempt (HR)

router.get('/attempts/:id', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    const [[a]] = await pool.query(
      `SELECT a.*, u.display_name AS name, d.name AS department, s.title, s.start_date, s.end_date, st.name AS set_name,
              st.passing_percent, st.reorient_below_percent
         FROM exam_attempts a JOIN users u ON u.id = a.user_id LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN departments d ON d.id = e.department_id JOIN exam_schedules s ON s.id = a.schedule_id JOIN exam_sets st ON st.id = a.set_id
        WHERE a.id = ?`, [req.params.id]);
    if (!a) return bad(res, 'Not found.', 404);
    const order = parseJson(a.question_order, null);
    let qs;
    if (order && order.length) {
      [qs] = await pool.query(
        `SELECT q.*, t.name AS topic, x.answer AS given, x.confirmed_at, x.is_correct, x.points_awarded, x.feedback, x.choice_order, gu.display_name AS graded_by
           FROM JSON_TABLE(?, '$[*]' COLUMNS (n FOR ORDINALITY, qid BIGINT PATH '$')) o
           JOIN exam_questions q ON q.id = o.qid LEFT JOIN exam_topics t ON t.id = q.topic_id
           LEFT JOIN exam_attempt_answers x ON x.attempt_id = ? AND x.question_id = q.id
           LEFT JOIN users gu ON gu.id = x.graded_by_user_id
          ORDER BY o.n`, [JSON.stringify(order), a.id]);
    } else qs = [];
    const topics = (await topicBreakdown(a.id)).get(Number(a.id)) || [];
    const [orientations] = await pool.query(
      `SELECT o.*, t.name AS topic, t.orientation_name FROM exam_orientations o LEFT JOIN exam_topics t ON t.id = o.topic_id WHERE o.attempt_id = ?`, [a.id]);
    return res.json({
      ...a, question_order: undefined, topics, orientations,
      questions: qs.map((q) => ({
        id: q.id, type: q.type, question: q.question, topic: q.topic, points: Number(q.points),
        choices: parseJson(q.choices, null), answer_key: parseJson(q.answer, null), given: q.confirmed_at ? parseJson(q.given, null) : null,
        confirmed: !!q.confirmed_at, is_correct: q.is_correct == null ? null : !!Number(q.is_correct),
        points_awarded: q.points_awarded == null ? null : Number(q.points_awarded), feedback: q.feedback, graded_by: q.graded_by,
      })),
    });
  } catch (err) { return next(err); }
});

// An essay's points (and a note the examinee sees). The attempt is re-totalled; once nothing is
// left to grade it gets its pass / fail and its re-orientation recommendations.
router.post('/attempts/:id/grade', requireAuth, requirePermission(EX, 'can_edit'), async (req, res, next) => {
  try {
    const [[a]] = await pool.query('SELECT a.*, s.title FROM exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id WHERE a.id = ?', [req.params.id]);
    if (!a || a.status !== 'submitted') return bad(res, 'Only a submitted exam can be graded.', 409);
    const [[q]] = await pool.query('SELECT id, type, points FROM exam_questions WHERE id = ?', [req.body.question_id]);
    if (!q || q.type !== 'essay') return bad(res, 'Only essay answers are graded by hand.');
    const [[x]] = await pool.query('SELECT * FROM exam_attempt_answers WHERE attempt_id = ? AND question_id = ?', [a.id, q.id]);
    if (!x || !x.confirmed_at) return bad(res, 'That essay was not answered.');
    const pts = Number(req.body.points);
    if (!(pts >= 0 && pts <= Number(q.points))) return bad(res, `Points are 0 to ${Number(q.points)}.`);
    await pool.query(
      'UPDATE exam_attempt_answers SET points_awarded = ?, is_correct = ?, feedback = ?, graded_by_user_id = ?, graded_at = ? WHERE id = ?',
      [pts, pts >= Number(q.points) ? 1 : 0, String(req.body.feedback || '').trim().slice(0, 1000) || null, req.user.id, nowUtc(), x.id]);
    const wasPending = Number(a.essays_pending) > 0;
    const done = await finalize(a.id, { regrade: true });
    if (wasPending && done && !done.essays_pending) {
      await insertFor([a.user_id], {
        type: 'exam', title: `Exam result: ${a.title}`, message: `Your essays are graded -- final score ${done.percent}%.`,
        relatedType: 'ExamAttempt', relatedId: a.id,
      }, req.user.id).catch(() => {});
    }
    return res.json({ ok: true, percent: done?.percent, essays_pending: done?.essays_pending });
  } catch (err) { return next(err); }
});

router.post('/attempts/:id/ai-evaluation', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    if (!aiAllowed(req.user.id)) return bad(res, 'Too many AI requests -- wait a minute.', 429);
    const [[a]] = await pool.query(
      `SELECT a.*, st.name AS set_name, st.passing_percent, st.reorient_below_percent, d.name AS department
         FROM exam_attempts a JOIN exam_sets st ON st.id = a.set_id LEFT JOIN departments d ON d.id = st.department_id WHERE a.id = ?`, [req.params.id]);
    if (!a || a.status !== 'submitted') return bad(res, 'Only a submitted exam can be evaluated.', 409);
    const topics = (await topicBreakdown(a.id)).get(Number(a.id)) || [];
    const r = await scheduleResults(a.schedule_id);
    const [missed] = await pool.query(
      `SELECT q.question, t.name AS topic FROM exam_attempt_answers x JOIN exam_questions q ON q.id = x.question_id
         LEFT JOIN exam_topics t ON t.id = q.topic_id
        WHERE x.attempt_id = ? AND x.points_awarded IS NOT NULL AND x.points_awarded < q.points LIMIT 25`, [a.id]);
    const text = await evaluateAttempt({
      setName: a.set_name, department: a.department, threshold: Number(a.reorient_below_percent), passing: Number(a.passing_percent),
      percent: Number(a.percent), topics, deptAvg: r.topic_avg,
      missed: missed.map((m) => ({ topic: m.topic || 'General', question: String(m.question).slice(0, 200) })),
    });
    await pool.query('UPDATE exam_attempts SET ai_evaluation = ?, ai_evaluation_at = ? WHERE id = ?', [text, nowUtc(), a.id]);
    await recommendOrientations(a.id);
    return res.json({ ai_evaluation: text });
  } catch (err) { return next(err); }
});

// A retake is another schedule for this one person (asked 2026-10-21: HR schedules it), with the
// same set or another.
router.post('/attempts/:id/retake', requireAuth, requirePermission(EX, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[a]] = await conn.query('SELECT a.*, s.title FROM exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id WHERE a.id = ?', [req.params.id]);
    if (!a) return bad(res, 'Not found.', 404);
    if (!['submitted', 'missed'].includes(a.status)) return bad(res, 'Only a submitted or missed exam can be retaken.', 409);
    const setId = Number(req.body.set_id) || a.set_id;
    const [[st]] = await conn.query('SELECT id FROM exam_sets WHERE id = ? AND is_active = 1', [setId]);
    if (!st) return bad(res, 'Pick the exam set.');
    const w = cleanWindow(req.body);
    if (w.error) return bad(res, w.error);
    const title = String(req.body.title || '').trim().slice(0, 200) || `${a.title} (Retake)`;
    await conn.beginTransaction();
    const { schedule, added } = await scheduleFor(conn, { setId, title, start: w.start, end: w.end, departmentIds: [], userIds: [a.user_id], retakeOf: a.id }, req.user.id);
    await conn.commit();
    notifyExaminees(schedule.id, added, title, w.start, w.end, req.user.id);
    return res.json({ id: schedule.id });
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

// ---------------------------------------------------------------- Re-orientation

router.get('/orientations', requireAuth, requirePermission(EX, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (['recommended', 'scheduled', 'attended', 'dismissed'].includes(req.query.status)) { where.push('o.status = ?'); params.push(req.query.status); }
    const [rows] = await pool.query(
      `SELECT o.*, u.display_name AS name, d.name AS department, t.name AS topic, t.orientation_name, s.title AS exam_title,
              a.percent AS exam_percent, uu.display_name AS updated_by,
              (SELECT s2.id FROM exam_schedules s2 WHERE s2.retake_of_attempt_id = o.attempt_id AND s2.status <> 'cancelled' ORDER BY s2.id DESC LIMIT 1) AS retake_schedule_id
         FROM exam_orientations o JOIN users u ON u.id = o.user_id LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN exam_topics t ON t.id = o.topic_id
         LEFT JOIN exam_attempts a ON a.id = o.attempt_id LEFT JOIN exam_schedules s ON s.id = a.schedule_id
         LEFT JOIN users uu ON uu.id = o.updated_by_user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY FIELD(o.status, 'recommended', 'scheduled', 'attended', 'dismissed'), o.created_at DESC LIMIT 1000`, params);
    const [counts] = await pool.query('SELECT status, COUNT(*) AS n FROM exam_orientations GROUP BY status');
    res.json({ rows, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
  } catch (err) { next(err); }
});

// Recommended -> scheduled (a date) -> attended (on date X), or dismissed.
router.put('/orientations/:id', requireAuth, requirePermission(EX, 'can_edit'), async (req, res, next) => {
  try {
    const [[o]] = await pool.query('SELECT * FROM exam_orientations WHERE id = ?', [req.params.id]);
    if (!o) return bad(res, 'Not found.', 404);
    const status = ['recommended', 'scheduled', 'attended', 'dismissed'].includes(req.body.status) ? req.body.status : o.status;
    const scheduled = isDate(req.body.scheduled_date) ? req.body.scheduled_date : (req.body.scheduled_date === '' ? null : o.scheduled_date);
    const attended = isDate(req.body.attended_date) ? req.body.attended_date : (req.body.attended_date === '' ? null : o.attended_date);
    if (status === 'scheduled' && !scheduled) return bad(res, 'Set the orientation date.');
    if (status === 'attended' && !attended) return bad(res, 'Set the date it was attended.');
    await pool.query(
      'UPDATE exam_orientations SET status = ?, scheduled_date = ?, attended_date = ?, notes = ?, updated_by_user_id = ? WHERE id = ?',
      [status, scheduled, status === 'attended' ? attended : null, String(req.body.notes ?? o.notes ?? '').trim().slice(0, 500) || null, req.user.id, o.id]);
    if (status === 'scheduled' && o.status !== 'scheduled') {
      const [[t]] = await pool.query('SELECT name, orientation_name FROM exam_topics WHERE id = ?', [o.topic_id]);
      await insertFor([o.user_id], {
        type: 'exam', title: `Orientation: ${t?.orientation_name || t?.name || 'Re-orientation'}`, message: `Scheduled on ${scheduled}.`,
        relatedType: 'ExamAttempt', relatedId: o.attempt_id,
      }, req.user.id).catch(() => {});
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

module.exports = router;
