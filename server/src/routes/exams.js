const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  CHOICE_TYPES, parseJson, nowUtc, phToday, day, utcText, windowEndUtc, shuffle, cleanGiven, sweep, finalize, syncLateJoiner,
  topicBreakdown, setQuestionCount, drawQuestions,
} = require('../lib/exams');
const { certificatePdf } = require('../lib/examCertificate');

const router = express.Router();

// Forms > My Exams (2026-10-21; lib/exams.js): the examinee's side. Each exam is one attempt of a
// schedule HR made. Starting it fixes the examinee's own question order and choice order. An answer
// can be saved and changed, and questions skipped and come back to -- until the examinee CONFIRMS it:
// a confirmed answer is final and its question cannot be opened again. Only confirmed answers count.
//
// After submitting, the examinee sees their score and their own answers marked right or wrong --
// never the correct answer (asked 2026-10-21), so a set can be given again. A retake is a new
// schedule HR makes.
const ROUTE = '/exams';

// How many answer boxes an enumeration shows -- the only thing about its key the examinee sees.
const slotsOf = (q) => (q.type === 'enumeration' ? Number(parseJson(q.answer, {})?.required) || 1 : undefined);

async function ownAttempt(req, res) {
  const [[a]] = await pool.query(
    `SELECT a.*, s.title, s.start_date, s.end_date, s.status AS schedule_status,
            st.name AS set_name, st.description, st.time_limit_minutes, st.passing_percent, st.mode, st.rules,
            u.display_name AS user_name
       FROM exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id JOIN exam_sets st ON st.id = a.set_id
       JOIN users u ON u.id = a.user_id
      WHERE a.id = ?`, [req.params.id]);
  if (!a || Number(a.user_id) !== Number(req.user.id)) { res.status(404).json({ error: 'Exam not found.' }); return null; }
  return a;
}

const openNow = (a) => a.schedule_status === 'active' && phToday() >= day(a.start_date) && phToday() <= day(a.end_date);
const secondsLeft = (a) => Math.max(0, Math.floor((new Date(`${utcText(a.deadline_at).replace(' ', 'T')}Z`) - Date.now()) / 1000));

router.get('/my', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    await syncLateJoiner(req.user.id);
    await sweep({ userId: req.user.id });
    const [rows] = await pool.query(
      `SELECT a.id, a.status, a.started_at, a.submitted_at, a.auto_submitted, a.score, a.max_score, a.percent, a.passed, a.essays_pending,
              s.title, s.start_date, s.end_date, s.status AS schedule_status, st.name AS set_name, st.time_limit_minutes, st.passing_percent,
              st.mode, st.rules, (SELECT COUNT(*) FROM exam_set_questions sq WHERE sq.set_id = a.set_id) AS fixed_count,
              JSON_LENGTH(a.question_order) AS drawn_count
         FROM exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id JOIN exam_sets st ON st.id = a.set_id
        WHERE a.user_id = ? AND s.status <> 'cancelled'
        ORDER BY FIELD(a.status, 'in_progress', 'assigned', 'submitted', 'missed'), s.end_date, a.id DESC`, [req.user.id]);
    res.json(rows.map((r) => ({
      ...r, rules: undefined, fixed_count: undefined, drawn_count: undefined,
      // What was drawn once started; before that what the set will give (a random set's rules).
      question_count: r.drawn_count != null ? Number(r.drawn_count) : setQuestionCount(r, r.fixed_count),
      certificate: r.status === 'submitted' && Number(r.passed) === 1 && !Number(r.essays_pending),
      can_start: ['assigned', 'in_progress'].includes(r.status) && openNow(r),
      not_yet_open: r.status === 'assigned' && phToday() < day(r.start_date),
    })));
  } catch (err) { next(err); }
});

router.get('/attempts/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    await sweep({ userId: req.user.id });
    const a = await ownAttempt(req, res);
    if (!a) return undefined;
    const head = {
      id: a.id, status: a.status, title: a.title, set_name: a.set_name, description: a.description,
      start_date: a.start_date, end_date: a.end_date, time_limit_minutes: a.time_limit_minutes, passing_percent: a.passing_percent,
      can_start: ['assigned', 'in_progress'].includes(a.status) && openNow(a),
    };
    if (a.status === 'assigned' || a.status === 'missed') {
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM exam_set_questions WHERE set_id = ?', [a.set_id]);
      return res.json({ ...head, question_count: setQuestionCount(a, n) });
    }
    const order = parseJson(a.question_order, []);
    const [qs] = order.length ? await pool.query(
      'SELECT id, type, question, choices, answer, points, image_data IS NOT NULL AS has_image FROM exam_questions WHERE id IN (?)', [order]) : [[]];
    const byId = new Map(qs.map((q) => [Number(q.id), q]));
    const [ans] = await pool.query('SELECT * FROM exam_attempt_answers WHERE attempt_id = ?', [a.id]);
    const ansBy = new Map(ans.map((x) => [Number(x.question_id), x]));
    const shownChoices = (q, x) => {
      const choices = parseJson(q.choices, []) || [];
      const ord = parseJson(x?.choice_order, null) || choices.map((_, i) => i);
      return ord.map((i) => ({ i, text: choices[i] }));
    };

    if (a.status === 'in_progress') {
      const questions = order.map((qid, n) => {
        const q = byId.get(Number(qid));
        const x = ansBy.get(Number(qid));
        if (!q) return null;
        // A confirmed question is closed to the examinee until the exam is submitted.
        if (x?.confirmed_at) return { id: q.id, n: n + 1, confirmed: true, type: q.type, points: Number(q.points) };
        return {
          id: q.id, n: n + 1, confirmed: false, type: q.type, question: q.question, points: Number(q.points),
          has_image: !!Number(q.has_image), slots: slotsOf(q),
          choices: CHOICE_TYPES.includes(q.type) ? shownChoices(q, x) : null, answer: parseJson(x?.answer, null),
        };
      }).filter(Boolean);
      return res.json({ ...head, seconds_left: secondsLeft(a), questions });
    }

    // Submitted: the score, and the examinee's own answers marked -- no answer key.
    const topics = (await topicBreakdown(a.id)).get(Number(a.id)) || [];
    const questions = order.map((qid, n) => {
      const q = byId.get(Number(qid));
      const x = ansBy.get(Number(qid));
      if (!q) return null;
      return {
        id: q.id, n: n + 1, type: q.type, question: q.question, points: Number(q.points), has_image: !!Number(q.has_image),
        choices: CHOICE_TYPES.includes(q.type) ? shownChoices(q, x) : null,
        answer: x?.confirmed_at ? parseJson(x.answer, null) : null, confirmed: !!x?.confirmed_at,
        is_correct: x?.is_correct == null ? null : !!Number(x.is_correct),
        points_awarded: x?.points_awarded == null ? null : Number(x.points_awarded),
        pending: q.type === 'essay' && !!x?.confirmed_at && x?.points_awarded == null,
        feedback: x?.feedback || null, slots: slotsOf(q),
        // A typed answer marked box by box (an enumeration's each item) -- right or wrong, never the key.
        marks: x?.confirmed_at ? parseJson(x.item_marks, null) : null,
      };
    }).filter(Boolean);
    return res.json({
      ...head, submitted_at: a.submitted_at, auto_submitted: !!a.auto_submitted, score: a.score == null ? null : Number(a.score),
      max_score: a.max_score == null ? null : Number(a.max_score), percent: a.percent == null ? null : Number(a.percent),
      passed: a.passed == null ? null : !!a.passed, essays_pending: Number(a.essays_pending || 0),
      certificate: Number(a.passed) === 1 && !Number(a.essays_pending),
      topics: topics.map((t) => ({ topic: t.topic, earned: t.earned, max: t.max, percent: t.percent })), questions,
    });
  } catch (err) { return next(err); }
});

// A question's picture, loaded on its own so the exam itself stays light. Only for a question in
// this examinee's exam that they may see now: an open one while taking it, any once submitted.
router.get('/attempts/:id/questions/:qid/image', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const a = await ownAttempt(req, res);
    if (!a) return undefined;
    const qid = Number(req.params.qid);
    if (!['in_progress', 'submitted'].includes(a.status) || !(parseJson(a.question_order, []) || []).map(Number).includes(qid)) {
      return res.status(404).json({ error: 'Not found.' });
    }
    if (a.status === 'in_progress') {
      const [[x]] = await pool.query('SELECT confirmed_at FROM exam_attempt_answers WHERE attempt_id = ? AND question_id = ?', [a.id, qid]);
      if (x?.confirmed_at) return res.status(404).json({ error: 'Not found.' });
    }
    const [[q]] = await pool.query('SELECT image_data FROM exam_questions WHERE id = ?', [qid]);
    return res.json({ image: q?.image_data || null });
  } catch (err) { return next(err); }
});

// Certificate of Completion -- a passed exam with nothing left to grade.
router.get('/attempts/:id/certificate', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const a = await ownAttempt(req, res);
    if (!a) return undefined;
    if (a.status !== 'submitted' || Number(a.passed) !== 1 || Number(a.essays_pending)) {
      return res.status(409).json({ error: 'A certificate is issued for a passed exam once it is fully graded.' });
    }
    return sendCertificate(res, a);
  } catch (err) { return next(err); }
});

async function sendCertificate(res, a) {
  const pdf = await certificatePdf({
    name: a.user_name, title: a.title, setName: a.set_name, percent: a.percent,
    date: day(a.submitted_at), certificateNo: `EXC-${String(a.id).padStart(6, '0')}`,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="certificate-${String(a.user_name || 'exam').replace(/[^\w.-]+/g, '-')}-${a.id}.pdf"`);
  return res.send(pdf);
}

router.post('/attempts/:id/start', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const a = await ownAttempt(req, res);
    if (!a) return undefined;
    if (a.status === 'in_progress') return res.json({ ok: true });
    if (a.status !== 'assigned') return res.status(409).json({ error: 'This exam is already closed.' });
    if (!openNow(a)) {
      return res.status(409).json({ error: phToday() < day(a.start_date) ? `This exam opens on ${day(a.start_date)}.` : 'This exam is no longer open.' });
    }
    // A fixed set: the same questions for everyone, each in their own order. A random set: this
    // examinee's own draw from the bank by the set's rules. Either way the choices are shuffled too.
    const order = await drawQuestions(conn, { id: a.set_id, mode: a.mode, rules: a.rules });
    if (!order.length) return res.status(409).json({ error: 'This exam has no questions yet. Tell HR.' });
    const [qs] = await conn.query('SELECT id, type, choices FROM exam_questions WHERE id IN (?)', [order]);
    await conn.beginTransaction();
    for (const q of qs) {
      const choices = parseJson(q.choices, []) || [];
      const choiceOrder = CHOICE_TYPES.includes(q.type) ? shuffle(choices.map((_, i) => i)) : null;
      await conn.query(
        'INSERT IGNORE INTO exam_attempt_answers (attempt_id, question_id, choice_order) VALUES (?, ?, ?)',
        [a.id, q.id, choiceOrder ? JSON.stringify(choiceOrder) : null]);
    }
    // The deadline: the time limit from now, but never past the window's last day.
    const now = nowUtc();
    const end = windowEndUtc(a.end_date);
    let deadline = end;
    if (Number(a.time_limit_minutes) > 0) {
      const lim = new Date(Date.now() + Number(a.time_limit_minutes) * 60000).toISOString().slice(0, 19).replace('T', ' ');
      if (lim < end) deadline = lim;
    }
    const [r] = await conn.query(
      "UPDATE exam_attempts SET status = 'in_progress', question_order = ?, started_at = ?, deadline_at = ? WHERE id = ? AND status = 'assigned'",
      [JSON.stringify(order), now, deadline, a.id]);
    await conn.commit();
    return r.affectedRows ? res.json({ ok: true }) : res.status(409).json({ error: 'This exam was already started.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    return next(err);
  } finally { conn.release(); }
});

// The question an answer is for, when the attempt is still open to answering it.
async function answerable(req, res) {
  const a = await ownAttempt(req, res);
  if (!a) return null;
  if (a.status === 'in_progress' && utcText(a.deadline_at) < nowUtc()) {
    await finalize(a.id, { auto: true });
    res.status(409).json({ error: 'Time is up -- your exam was submitted with your confirmed answers.', closed: true });
    return null;
  }
  if (a.status !== 'in_progress') { res.status(409).json({ error: 'This exam is closed.', closed: true }); return null; }
  const qid = Number(req.params.qid);
  if (!(parseJson(a.question_order, []) || []).map(Number).includes(qid)) { res.status(404).json({ error: 'Not a question in this exam.' }); return null; }
  const [[q]] = await pool.query('SELECT id, type, choices, answer FROM exam_questions WHERE id = ?', [qid]);
  const [[x]] = await pool.query('SELECT confirmed_at FROM exam_attempt_answers WHERE attempt_id = ? AND question_id = ?', [a.id, qid]);
  if (x?.confirmed_at) { res.status(409).json({ error: 'That answer is already confirmed and final.' }); return null; }
  const given = cleanGiven(q.type, (parseJson(q.choices, []) || []).length, req.body?.answer, slotsOf(q));
  return { a, q, given };
}

// Save (or clear) an answer without confirming it -- the examinee may still change it.
router.put('/attempts/:id/answers/:qid', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const ctx = await answerable(req, res);
    if (!ctx) return undefined;
    await pool.query(
      `INSERT INTO exam_attempt_answers (attempt_id, question_id, answer) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE answer = VALUES(answer)`,
      [ctx.a.id, ctx.q.id, ctx.given === undefined ? null : JSON.stringify(ctx.given)]);
    return res.json({ ok: true, seconds_left: secondsLeft(ctx.a) });
  } catch (err) { return next(err); }
});

// Confirm: the answer is final and its question closes.
router.post('/attempts/:id/answers/:qid/confirm', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const ctx = await answerable(req, res);
    if (!ctx) return undefined;
    if (ctx.given === undefined) return res.status(400).json({ error: 'Answer the question before confirming it.' });
    const [r] = await pool.query(
      `INSERT INTO exam_attempt_answers (attempt_id, question_id, answer, confirmed_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE answer = IF(confirmed_at IS NULL, VALUES(answer), answer), confirmed_at = COALESCE(confirmed_at, VALUES(confirmed_at))`,
      [ctx.a.id, ctx.q.id, JSON.stringify(ctx.given), nowUtc()]);
    return res.json({ ok: !!r.affectedRows, seconds_left: secondsLeft(ctx.a) });
  } catch (err) { return next(err); }
});

router.post('/attempts/:id/submit', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const a = await ownAttempt(req, res);
    if (!a) return undefined;
    if (a.status !== 'in_progress') return res.status(409).json({ error: 'This exam is already closed.' });
    const auto = utcText(a.deadline_at) < nowUtc();
    const done = await finalize(a.id, { auto });
    return res.json({ ok: true, percent: done?.percent, essays_pending: done?.essays_pending });
  } catch (err) { return next(err); }
});

// Leaving the exam tab is counted (shown to HR beside the score) -- a deterrent, not a block.
router.post('/attempts/:id/tab-switch', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    await pool.query("UPDATE exam_attempts SET tab_switches = tab_switches + 1 WHERE id = ? AND user_id = ? AND status = 'in_progress'",
      [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.sendCertificate = sendCertificate;
