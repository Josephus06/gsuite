const pool = require('../db');

// HRD > Examinations (2026-10-21; db/create-exam-module.js). What both the examinee's routes
// (routes/exams.js) and HR's (routes/examAdmin.js) need: the answer formats and grading, the
// shuffles, closing an attempt, the per-topic evaluation and the AI calls.
//
// ANSWER FORMATS (exam_questions.answer, and what an examinee's answer looks like):
//   true_false       true | false
//   multiple_choice  index into choices
//   multiple_select  [indices] -- right only when exactly the right set is picked
//   identification   [accepted answers]; the examinee types text, compared case/space-insensitively
//   essay            { guide } -- what a good answer covers, for whoever grades it
// Choice answers are always ORIGINAL indices: the examinee's choices are shown shuffled, and the
// shuffle is mapped back before it is stored, so grading never depends on the order shown.
const TYPES = ['true_false', 'multiple_choice', 'multiple_select', 'identification', 'essay'];
const TYPE_LABELS = {
  true_false: 'True or False', multiple_choice: 'Multiple Choice', multiple_select: 'Multiple Select',
  identification: 'Identification', essay: 'Essay',
};
const CHOICE_TYPES = ['multiple_choice', 'multiple_select'];

const parseJson = (v, fallback = null) => {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

// Times are UTC 'YYYY-MM-DD HH:MM:SS', written and compared here in JS so a database clock in
// another zone cannot shift a deadline. Dates (the window) are Philippine calendar days.
const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const phToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
const utcText = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v || ''));
// The last second of a Philippine day, in UTC: 23:59:59 +08:00 is 15:59:59Z.
const windowEndUtc = (endDate) => `${day(endDate)} 15:59:59`;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// A question as the bank stores it, checked: returns { error } or the clean fields to save.
function cleanQuestion(q) {
  const type = TYPES.includes(q.type) ? q.type : null;
  if (!type) return { error: 'Pick the question type.' };
  const question = String(q.question || '').trim();
  if (!question) return { error: 'Write the question.' };
  const points = Number(q.points ?? 1);
  if (!(points > 0) || points > 100) return { error: 'Points must be more than 0 (up to 100).' };
  let choices = null;
  let answer = null;
  if (CHOICE_TYPES.includes(type)) {
    choices = (Array.isArray(q.choices) ? q.choices : []).map((c) => String(c ?? '').trim()).filter(Boolean);
    if (choices.length < 2) return { error: 'A choice question needs at least 2 choices.' };
    if (type === 'multiple_choice') {
      answer = Number(q.answer);
      if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) return { error: 'Mark the correct choice.' };
    } else {
      answer = [...new Set((Array.isArray(q.answer) ? q.answer : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < choices.length).sort((x, y) => x - y);
      if (!answer.length) return { error: 'Mark at least one correct choice.' };
    }
  } else if (type === 'true_false') {
    if (q.answer !== true && q.answer !== false && q.answer !== 'true' && q.answer !== 'false') return { error: 'Mark True or False as the answer.' };
    answer = q.answer === true || q.answer === 'true';
  } else if (type === 'identification') {
    const list = Array.isArray(q.answer) ? q.answer : String(q.answer || '').split('|');
    answer = list.map((s) => String(s ?? '').trim()).filter(Boolean);
    if (!answer.length) return { error: 'Give the accepted answer (separate alternatives with | ).' };
  } else {
    answer = { guide: String(q.answer?.guide ?? q.guide ?? '').trim() || null };
  }
  const difficulty = ['easy', 'average', 'hard'].includes(q.difficulty) ? q.difficulty : null;
  return { type, question, choices, answer, points, difficulty };
}

// Whether an examinee's answer is right. Essays are graded by a person: null.
function grade(type, key, given) {
  if (given == null || given === '') return false;
  switch (type) {
    case 'true_false': return (given === true || given === 'true') === key;
    case 'multiple_choice': return Number(given) === Number(key);
    case 'multiple_select': {
      const g = [...new Set((Array.isArray(given) ? given : []).map(Number))].sort((x, y) => x - y);
      const k = (Array.isArray(key) ? key : []).map(Number).sort((x, y) => x - y);
      return g.length === k.length && g.every((v, i) => v === k[i]);
    }
    case 'identification': return (Array.isArray(key) ? key : []).some((k) => norm(k) === norm(given));
    default: return null;
  }
}

// An examinee's answer, checked against the question's shape before it is stored.
function cleanGiven(type, choicesLen, given) {
  if (type === 'true_false') return given === true || given === 'true' ? true : given === false || given === 'false' ? false : undefined;
  if (type === 'multiple_choice') { const i = Number(given); return Number.isInteger(i) && i >= 0 && i < choicesLen ? i : undefined; }
  if (type === 'multiple_select') {
    const a = [...new Set((Array.isArray(given) ? given : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < choicesLen);
    return a.length ? a.sort((x, y) => x - y) : undefined;
  }
  const s = String(given ?? '').trim();
  if (!s) return undefined;
  return s.slice(0, type === 'essay' ? 8000 : 500);
}

// Active users a schedule's targets reach: the users named, and the active users whose employee
// record is in a department named.
async function targetUserIds(conn, departmentIds, userIds) {
  const ids = new Set((userIds || []).map(Number).filter(Boolean));
  if (departmentIds && departmentIds.length) {
    const [rows] = await conn.query(
      `SELECT u.id FROM users u JOIN employees e ON e.id = u.employee_id
        WHERE u.is_active = 1 AND e.department_id IN (?)`, [departmentIds.map(Number)]);
    rows.forEach((r) => ids.add(Number(r.id)));
  }
  if (!ids.size) return [];
  const [active] = await conn.query('SELECT id FROM users WHERE id IN (?) AND is_active = 1', [[...ids]]);
  return active.map((r) => Number(r.id));
}

// The attempt rows for a schedule's examinees (one each; existing ones are left alone). Returns
// the user ids newly given the exam.
async function createAttempts(conn, schedule, userIds) {
  const added = [];
  for (const uid of userIds) {
    const [r] = await conn.query(
      'INSERT IGNORE INTO exam_attempts (schedule_id, set_id, user_id, status) VALUES (?, ?, ?, ?)',
      [schedule.id, schedule.set_id, uid, 'assigned']);
    if (r.affectedRows) added.push(uid);
  }
  return added;
}

// Someone who joined a targeted department after the exam was scheduled still gets it while the
// window is open.
async function syncLateJoiner(userId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT s.id, s.set_id FROM exam_schedules s
       JOIN exam_schedule_targets t ON t.schedule_id = s.id
       JOIN employees e ON e.department_id = t.department_id
       JOIN users u ON u.employee_id = e.id AND u.id = ?
      WHERE s.status = 'active' AND s.end_date >= ?
        AND NOT EXISTS (SELECT 1 FROM exam_attempts a WHERE a.schedule_id = s.id AND a.user_id = u.id)`,
    [userId, phToday()]);
  for (const s of rows) await createAttempts(pool, s, [userId]);
}

// Closes what time has run out on: an attempt in progress past its deadline is submitted as it
// stands (only confirmed answers count); one never started before its window closed is Missed.
async function sweep({ userId = null, scheduleId = null } = {}) {
  const scope = userId ? 'AND a.user_id = ?' : scheduleId ? 'AND a.schedule_id = ?' : '';
  const arg = userId || scheduleId;
  const [late] = await pool.query(
    `SELECT a.id FROM exam_attempts a WHERE a.status = 'in_progress' AND a.deadline_at < ? ${scope}`,
    arg ? [nowUtc(), arg] : [nowUtc()]);
  for (const a of late) await finalize(a.id, { auto: true });
  await pool.query(
    `UPDATE exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id SET a.status = 'missed'
      WHERE a.status = 'assigned' AND s.end_date < ? ${scope}`,
    arg ? [phToday(), arg] : [phToday()]);
}

// Scores an attempt and closes it (submit, time up), or re-totals it after an essay is graded.
// Every question in the attempt counts: unanswered or unconfirmed is 0. Essays wait for a grader;
// until then the attempt shows the score so far and "essays pending", and no pass / fail.
async function finalize(attemptId, { auto = false, regrade = false } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[a]] = await conn.query(
      `SELECT a.*, st.passing_percent, st.reorient_below_percent FROM exam_attempts a
         JOIN exam_sets st ON st.id = a.set_id WHERE a.id = ? FOR UPDATE`, [attemptId]);
    if (!a) { await conn.rollback(); return null; }
    if (!regrade && a.status !== 'in_progress') { await conn.rollback(); return a; }
    const order = parseJson(a.question_order, []);
    const [qs] = order.length ? await conn.query('SELECT id, type, answer, points FROM exam_questions WHERE id IN (?)', [order]) : [[]];
    const byId = new Map(qs.map((q) => [Number(q.id), q]));
    const [ans] = await conn.query('SELECT * FROM exam_attempt_answers WHERE attempt_id = ?', [attemptId]);
    const ansBy = new Map(ans.map((x) => [Number(x.question_id), x]));
    let score = 0;
    let max = 0;
    let pending = 0;
    for (const qid of order) {
      const q = byId.get(Number(qid));
      if (!q) continue;
      const pts = Number(q.points);
      max += pts;
      const x = ansBy.get(Number(qid));
      const confirmed = x && x.confirmed_at;
      if (q.type === 'essay') {
        if (!confirmed) {
          if (!regrade) await upsertAnswer(conn, attemptId, qid, { is_correct: 0, points_awarded: 0 });
          continue;
        }
        if (x.points_awarded == null) { pending += 1; continue; }
        score += Number(x.points_awarded);
        continue;
      }
      const ok = confirmed ? grade(q.type, parseJson(q.answer), parseJson(x.answer)) : false;
      const awarded = ok ? pts : 0;
      score += awarded;
      if (!regrade) await upsertAnswer(conn, attemptId, qid, { is_correct: ok ? 1 : 0, points_awarded: awarded });
    }
    const percent = max ? Math.round((score / max) * 10000) / 100 : 0;
    const passed = pending ? null : (percent >= Number(a.passing_percent) ? 1 : 0);
    await conn.query(
      `UPDATE exam_attempts SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?), auto_submitted = IF(submitted_at IS NULL, ?, auto_submitted),
              score = ?, max_score = ?, percent = ?, passed = ?, essays_pending = ? WHERE id = ?`,
      [nowUtc(), auto ? 1 : 0, score, max, percent, passed, pending, attemptId]);
    await conn.commit();
    if (!pending) await recommendOrientations(attemptId);
    return { ...a, status: 'submitted', score, max_score: max, percent, passed, essays_pending: pending };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally { conn.release(); }
}

async function upsertAnswer(conn, attemptId, questionId, { is_correct, points_awarded }) {
  await conn.query(
    `INSERT INTO exam_attempt_answers (attempt_id, question_id, is_correct, points_awarded) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE is_correct = VALUES(is_correct), points_awarded = VALUES(points_awarded)`,
    [attemptId, questionId, is_correct, points_awarded]);
}

// Per-topic result of one attempt: [{ topic_id, topic, orientation_name, earned, max, percent, questions, wrong }].
// Ungraded essays are left out until graded.
async function topicBreakdown(attemptIds) {
  const ids = (Array.isArray(attemptIds) ? attemptIds : [attemptIds]).map(Number).filter(Boolean);
  if (!ids.length) return new Map();
  const [rows] = await pool.query(
    `SELECT a.id AS attempt_id, q.id AS question_id, q.topic_id, t.name AS topic, t.orientation_name, q.points, q.type,
            x.points_awarded, x.is_correct
       FROM exam_attempts a
       JOIN JSON_TABLE(a.question_order, '$[*]' COLUMNS (qid BIGINT PATH '$')) o
       JOIN exam_questions q ON q.id = o.qid
       LEFT JOIN exam_topics t ON t.id = q.topic_id
       LEFT JOIN exam_attempt_answers x ON x.attempt_id = a.id AND x.question_id = q.id
      WHERE a.id IN (?) AND a.status = 'submitted'`, [ids]);
  const out = new Map();
  for (const r of rows) {
    if (r.type === 'essay' && r.points_awarded == null) continue;
    const list = out.get(Number(r.attempt_id)) || new Map();
    const key = r.topic_id ? Number(r.topic_id) : 0;
    const t = list.get(key) || { topic_id: r.topic_id ? Number(r.topic_id) : null, topic: r.topic || 'General', orientation_name: r.orientation_name || null, earned: 0, max: 0, questions: 0, wrong: 0 };
    t.earned += Number(r.points_awarded || 0);
    t.max += Number(r.points);
    t.questions += 1;
    if (Number(r.points_awarded || 0) < Number(r.points)) t.wrong += 1;
    list.set(key, t);
    out.set(Number(r.attempt_id), list);
  }
  const result = new Map();
  for (const [aid, list] of out) {
    result.set(aid, [...list.values()].map((t) => ({ ...t, percent: t.max ? Math.round((t.earned / t.max) * 1000) / 10 : 0 }))
      .sort((x, y) => x.percent - y.percent));
  }
  return result;
}

// A topic the examinee scored under the set's re-orientation line recommends that topic's
// orientation -- one row per attempt per topic, never duplicated by a re-grade.
async function recommendOrientations(attemptId) {
  const [[a]] = await pool.query(
    `SELECT a.id, a.user_id, st.reorient_below_percent FROM exam_attempts a JOIN exam_sets st ON st.id = a.set_id WHERE a.id = ?`, [attemptId]);
  if (!a) return;
  const topics = (await topicBreakdown(attemptId)).get(Number(attemptId)) || [];
  for (const t of topics) {
    if (!t.topic_id || t.percent >= Number(a.reorient_below_percent)) continue;
    await pool.query(
      `INSERT INTO exam_orientations (user_id, topic_id, attempt_id, topic_percent, status) VALUES (?, ?, ?, ?, 'recommended')
       ON DUPLICATE KEY UPDATE topic_percent = VALUES(topic_percent)`,
      [a.user_id, t.topic_id, a.id, t.percent]);
  }
}

// ---- AI (same OpenAI account and model as Translate, Chat summary) ----
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const WINDOW_MS = 60000;
const recent = new Map();
function aiAllowed(userId, perWindow = 6) {
  const now = Date.now();
  const hits = (recent.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= perWindow) { recent.set(userId, hits); return false; }
  hits.push(now);
  recent.set(userId, hits);
  return true;
}

async function openai(messages, { json = false, temperature = 0.2 } = {}) {
  if (!process.env.OPENAI_API_KEY) { const e = new Error('The AI is not set up on this server (OPENAI_API_KEY).'); e.status = 503; throw e; }
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, temperature, messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`OpenAI ${response.status}: ${detail.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

// A PDF (or pasted text) of questions read into draft questions in the bank's format, for the
// department head to review before anything is saved. Nothing the AI returns is trusted: every
// draft goes through cleanQuestion, and a draft that fails it comes back with its problem shown.
async function extractQuestions({ pdfBase64, fileName, text, topics }) {
  const instructions = [
    'You turn an exam or reviewer document from a Philippine printing and signage company into structured questions.',
    'Return JSON: {"questions":[{"type","question","choices","answer","topic","points"}]}.',
    'type is one of: true_false, multiple_choice, multiple_select, identification, essay.',
    'true_false: answer true or false. multiple_choice: choices = array of strings WITHOUT the letter labels, answer = 0-based index of the right choice.',
    'multiple_select: answer = array of 0-based indices. identification: answer = array of accepted answers (alternatives).',
    'essay: answer = {"guide": "what a good answer covers"} if the document says, else {"guide": null}.',
    'If the document marks the answers (answer key, bold, check, asterisk, "Ans:"), use them. If it does not, give your best answer.',
    `topic: the subject the question tests. Prefer one of these existing topics when it fits: ${topics.length ? topics.join('; ') : '(none yet)'}; otherwise a short new topic name (2-4 words).`,
    'points: as the document says, else 1 (essay 5). Keep the wording of each question as written; fix only obvious OCR errors.',
    'Include every question in the document, in order. No commentary.',
  ].join(' ');
  const content = [];
  if (pdfBase64) content.push({ type: 'file', file: { filename: fileName || 'questions.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` } });
  content.push({ type: 'text', text: text ? `${instructions}\n\nDocument:\n${String(text).slice(0, 60000)}` : instructions });
  const raw = await openai([{ role: 'user', content }], { json: true, temperature: 0 });
  const parsed = parseJson(raw, {});
  return (Array.isArray(parsed.questions) ? parsed.questions : []).map((q) => {
    const c = cleanQuestion({ ...q, points: q.points ?? (q.type === 'essay' ? 5 : 1) });
    return {
      type: q.type, question: String(q.question || ''), choices: Array.isArray(q.choices) ? q.choices.map(String) : null,
      answer: c.error ? q.answer : c.answer, points: Number(q.points) || 1, topic: String(q.topic || '').trim() || null,
      problem: c.error || null,
    };
  });
}

// One examinee's evaluation: what they are strong and weak in, and which orientation to attend.
// Only scores, topics and question wording go to the AI -- never the employee's name.
async function evaluateAttempt({ setName, department, threshold, passing, percent, topics, deptAvg, missed }) {
  const lines = topics.map((t) => `- ${t.topic}: ${t.earned}/${t.max} (${t.percent}%)${deptAvg[t.topic_id || 0] != null ? `, group average ${deptAvg[t.topic_id || 0]}%` : ''}${t.orientation_name ? `, orientation: ${t.orientation_name}` : ''}`);
  return openai([
    {
      role: 'system',
      content: [
        'You are an HR training adviser at a Philippine printing and signage company. You read one employee\'s exam result',
        'and tell HR, in plain English, what the employee is strong and weak in and which orientation they should attend.',
        'Format: 3 to 6 short bullet points ("- "). First the overall result, then each weak topic with its score and what the',
        'missed questions suggest they do not know, then "Recommend:" bullets naming the orientation for each topic below the',
        'line (use the orientation name given; if none, "<topic> orientation"). If nothing is below the line, say no re-orientation',
        'is needed and name the weakest area to watch. Base everything only on the numbers and questions given. No heading.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Exam: ${setName}${department ? ` (${department})` : ''}\nOverall: ${percent}% (passing ${passing}%). Re-orientation line per topic: below ${threshold}%.\nBy topic:\n${lines.join('\n')}\n${missed.length ? `Questions missed:\n${missed.map((m) => `- [${m.topic}] ${m.question}`).join('\n')}` : 'No questions missed.'}`,
    },
  ]);
}

// A whole schedule at once, for HR: where the group is weak and who needs re-orientation.
async function summarizeSchedule({ title, setName, threshold, stats, topicAvg, weakCounts, hardest }) {
  return openai([
    {
      role: 'system',
      content: [
        'You are an HR training adviser at a Philippine printing and signage company. Summarize a group exam result for HR.',
        'Format: 3 to 6 short bullet points ("- "): turnout and pass rate, the weakest topics across the group, how many need',
        're-orientation in each, the questions most people missed and what that suggests to cover in the orientation. Base',
        'everything only on the numbers given. No heading, no closing remark.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Exam: ${title} (set ${setName}). Re-orientation line: below ${threshold}% in a topic.\n${stats}\nTopic averages:\n${topicAvg.map((t) => `- ${t.topic}: ${t.percent}% (${weakCounts[t.topic_id || 0] || 0} below the line)`).join('\n')}\nMost missed:\n${hardest.map((h) => `- [${h.topic}] ${h.question} -- ${h.wrong}/${h.n} wrong`).join('\n') || '- none'}`,
    },
  ]);
}

module.exports = {
  TYPES, TYPE_LABELS, CHOICE_TYPES, parseJson, nowUtc, phToday, day, utcText, windowEndUtc, shuffle,
  cleanQuestion, cleanGiven, grade, targetUserIds, createAttempts, syncLateJoiner, sweep, finalize,
  topicBreakdown, recommendOrientations, aiAllowed, extractQuestions, evaluateAttempt, summarizeSchedule,
};
