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
//   enumeration      { items: [[alternatives], ...], required } -- the examinee types `required`
//                    answers (any `required` of the items), in any order; each one that matches an
//                    item not already matched earns points / required (2026-10-21)
//   essay            { guide } -- what a good answer covers, for whoever grades it
// Choice answers are always ORIGINAL indices: the examinee's choices are shown shuffled, and the
// shuffle is mapped back before it is stored, so grading never depends on the order shown.
//
// Typed answers (identification, enumeration) match exactly, ignoring case and spacing. HR may
// mark a wrong one right on the result (a misspelling): exam_attempt_answers.item_overrides, one
// entry per answer box, and the score is re-totalled.
const TYPES = ['true_false', 'multiple_choice', 'multiple_select', 'identification', 'enumeration', 'essay'];
const TYPE_LABELS = {
  true_false: 'True or False', multiple_choice: 'Multiple Choice', multiple_select: 'Multiple Select',
  identification: 'Identification', enumeration: 'Enumeration', essay: 'Essay',
};
const TYPED_TYPES = ['identification', 'enumeration'];
const CHOICE_TYPES = ['multiple_choice', 'multiple_select'];

// mysql2 already decodes JSON columns, so a text answer ("cyan", an essay) arrives as a plain
// string that is not itself JSON: it is kept as it is, never dropped.
const parseJson = (v, fallback = null) => {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
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

// Typed answers compare without capitals, spacing or punctuation -- quotes, periods, commas, dashes
// ("“Thank you for your patience.”" matches "thank you for your patience").
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().replace(/\s+/g, ' ');

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
  } else if (type === 'enumeration') {
    // Items as [[alternatives]], or as lines / strings with alternatives split by "|".
    const raw = q.answer?.items ?? q.answer;
    const lines = Array.isArray(raw) ? raw : String(raw || '').split('\n');
    const items = lines.map((it) => (Array.isArray(it) ? it : String(it ?? '').split('|'))
      .map((s) => String(s ?? '').trim()).filter(Boolean)).filter((alts) => alts.length);
    if (!items.length) return { error: 'List the accepted items, one per line (alternatives separated by | ).' };
    const required = q.answer?.required == null || q.answer?.required === '' ? items.length : Math.floor(Number(q.answer.required));
    if (!(required >= 1 && required <= items.length)) return { error: `"How many to give" must be 1 to ${items.length}.` };
    answer = { items, required };
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

// An enumeration's answer boxes, each matched to an item not already matched (any order; typing
// the same item twice, or two names for it, counts once). -> [true/false per box]
function enumMarks(key, given) {
  const items = Array.isArray(key?.items) ? key.items : [];
  const used = new Set();
  return (Array.isArray(given) ? given : []).map((g) => {
    if (!norm(g)) return false;
    const i = items.findIndex((alts, n) => !used.has(n) && alts.some((a) => norm(a) === norm(g)));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

// Marks per answer box for a typed question, HR's overrides applied. Identification has one box.
function typedMarks(type, key, given, overrides) {
  const auto = type === 'enumeration' ? enumMarks(key, given) : [!!grade(type, key, given)];
  const ov = Array.isArray(overrides) ? overrides : [];
  return auto.map((m, i) => (ov[i] === true || ov[i] === false ? ov[i] : m));
}

// The points a typed answer earns: enumeration pays per correct box out of the number asked for.
function typedPoints(type, key, marks, pts) {
  const right = marks.filter(Boolean).length;
  if (type !== 'enumeration') return right ? pts : 0;
  const required = Number(key?.required) || 1;
  return Math.round((pts * Math.min(right, required)) / required * 100) / 100;
}

// An examinee's answer, checked against the question's shape before it is stored. `slots` is the
// number of answer boxes of an enumeration.
function cleanGiven(type, choicesLen, given, slots = 0) {
  if (type === 'enumeration') {
    const list = (Array.isArray(given) ? given : []).slice(0, slots || 20).map((s) => String(s ?? '').trim().slice(0, 200));
    while (list.length < slots) list.push('');
    return list.some(Boolean) ? list : undefined;
  }
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
      // Typed answers: marked box by box (HR's overrides applied), partial points for enumeration.
      // Re-marked on a regrade too, so an override moves the score.
      if (TYPED_TYPES.includes(q.type)) {
        const key = parseJson(q.answer);
        const marks = confirmed ? typedMarks(q.type, key, parseJson(x.answer), parseJson(x.item_overrides, null)) : [];
        const awarded = confirmed ? typedPoints(q.type, key, marks, pts) : 0;
        score += awarded;
        await conn.query(
          `INSERT INTO exam_attempt_answers (attempt_id, question_id, is_correct, points_awarded, item_marks) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE is_correct = VALUES(is_correct), points_awarded = VALUES(points_awarded), item_marks = VALUES(item_marks)`,
          [attemptId, qid, awarded >= pts ? 1 : 0, awarded, JSON.stringify(marks)]);
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
    if (!t.topic_id) continue;
    if (t.percent >= Number(a.reorient_below_percent)) {
      // Back over the line after a re-grade (an override): a recommendation nobody acted on goes.
      await pool.query("DELETE FROM exam_orientations WHERE attempt_id = ? AND topic_id = ? AND status = 'recommended'", [a.id, t.topic_id]);
      continue;
    }
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

// A Word .docx (asked 2026-10-21) as plain text, one paragraph a line. A .docx is a zip; the text
// is word/document.xml's runs. Text the document made BOLD, underlined or highlighted comes back
// as **text** -- reviewers often mark the right answer that way -- and a numbered or bulleted
// paragraph starts "- " so questions do not run together (Word keeps the numbers out of the text).
async function docxText(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (xml == null) throw new Error('not a .docx');
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const on = (rPr, tag) => new RegExp(`<w:${tag}(?:\\s[^>]*?)?/?>`).test(rPr) && !new RegExp(`<w:${tag}\\s+w:val="(?:0|false|none)"`).test(rPr);
  const lines = [];
  for (const p of xml.split(/<\/w:p>/)) {
    const body = p.slice(p.lastIndexOf('<w:p ') >= 0 ? p.lastIndexOf('<w:p ') : p.lastIndexOf('<w:p>'));
    let line = '';
    let markOpen = false;
    for (const r of body.match(/<w:r[ >][\s\S]*?<\/w:r>/g) || []) {
      const rPr = (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
      const marked = on(rPr, 'b') || on(rPr, 'u') || /<w:highlight /.test(rPr) || /<w:shd [^>]*w:fill="(?!auto|FFFFFF)/i.test(rPr);
      let t = '';
      for (const m of r.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) t += m[1] != null ? decode(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n';
      if (!t) continue;
      if (marked && !markOpen && t.trim()) { line += '**'; markOpen = true; }
      if (!marked && markOpen) { line = `${line.replace(/\s+$/, '')}** `; markOpen = false; }
      line += t;
    }
    if (markOpen) line = `${line.replace(/\s+$/, '')}**`;
    if (!line.trim()) continue;
    lines.push(/<w:numPr>/.test(body) ? `- ${line.trim()}` : line.trim());
  }
  return lines.join('\n');
}

// A PDF (or pasted text, or a Word file's text) of questions read into draft questions in the
// bank's format, for the department head to review before anything is saved. Nothing the AI
// returns is trusted: every draft goes through cleanQuestion, and a draft that fails it comes back
// with its problem shown.
async function extractQuestions({ pdfBase64, fileName, text, marked = false, topics }) {
  const instructions = [
    'You turn an exam or reviewer document from a Philippine printing and signage company into structured questions.',
    'Return JSON: {"questions":[{"type","question","choices","answer","topic","points"}]}.',
    'type is one of: true_false, multiple_choice, multiple_select, identification, essay.',
    'true_false: answer true or false. multiple_choice: choices = array of strings WITHOUT the letter labels, answer = 0-based index of the right choice.',
    'multiple_select: answer = array of 0-based indices. identification: answer = array of accepted answers (alternatives).',
    'enumeration (the question asks to list / enumerate / give N things): answer = {"items": [["item", "alternative name", ...], ...], "required": N},',
    'one inner array per accepted item; required = how many the examinee must give (all of them unless the question says a number).',
    'essay: answer = {"guide": <the points a good answer must cover, ONLY if the document lists them>}, otherwise {"guide": null}.',
    'If the document marks the answers (answer key, bold, check, asterisk, "Ans:"), use them. If it does not, give your best answer.',
    `topic: the subject the question tests. Prefer one of these existing topics when it fits: ${topics.length ? topics.join('; ') : '(none yet)'}; otherwise a short new topic name (2-4 words).`,
    'points: as the document says, else 1 (essay 5). Keep the wording of each question as written; fix only obvious OCR errors.',
    'Include every question in the document, in order. No commentary.',
    ...(marked ? ['In this text, **double asterisks** mark words the document made bold, underlined or highlighted -- often the correct answer.',
      'Do not copy the asterisks into the question or choices.'] : []),
  ].join(' ');
  const content = [];
  if (pdfBase64) content.push({ type: 'file', file: { filename: fileName || 'questions.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` } });
  content.push({ type: 'text', text: text ? `${instructions}\n\nDocument:\n${String(text).slice(0, 60000)}` : instructions });
  let raw;
  try {
    raw = await openai([{ role: 'user', content }], { json: true, temperature: 0 });
  } catch (err) {
    // A long, text-heavy PDF is more than the model reads at once: say so plainly.
    if (/token|context|maximum/i.test(err.message)) {
      const e = new Error('That document is too long for the AI to read at once. Split it into smaller PDFs (about 20 pages or 100 questions each) and import them one by one.');
      e.status = 413;
      throw e;
    }
    throw err;
  }
  const parsed = parseJson(raw, {});
  return (Array.isArray(parsed.questions) ? parsed.questions : []).map((raw) => {
    const q = { ...raw };
    // A True/False sometimes comes back shaped as a choice ("True"/"False" choices, answer 0) or as
    // the word: read it as the boolean the bank stores.
    if (q.type === 'true_false') {
      let a = q.answer;
      if (typeof a === 'number' && Array.isArray(q.choices) && q.choices[a] != null) a = q.choices[a];
      if (typeof a === 'string') a = /^\s*(true|t|tama|oo)\s*$/i.test(a) ? true : /^\s*(false|f|mali|hindi)\s*$/i.test(a) ? false : a;
      q.answer = a;
      q.choices = null;
    }
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

// ---- Random sets (2026-10-21; db/add-exam-advanced.js) ----
// A random set is a list of rules, each "N questions from this department / topic / difficulty".
// Each examinee's questions are drawn when they START, so co-workers do not share one paper.
// Rules are drawn in order and never repeat a question.
const DIFFICULTIES = ['easy', 'average', 'hard'];

function cleanRules(list) {
  const rules = (Array.isArray(list) ? list : []).map((r) => ({
    department_id: Number(r.department_id) || null,
    topic_id: Number(r.topic_id) || null,
    type: TYPES.includes(r.type) ? r.type : null,
    difficulty: DIFFICULTIES.includes(r.difficulty) ? r.difficulty : null,
    count: Math.floor(Number(r.count) || 0),
  }));
  if (!rules.length) return { error: 'Add at least one rule (how many questions from which topic).' };
  if (rules.some((r) => r.count < 1 || r.count > 200)) return { error: 'Each rule draws 1 to 200 questions.' };
  return { rules };
}

function ruleWhere(r) {
  const where = ['q.is_active = 1'];
  const params = [];
  if (r.department_id) { where.push('q.department_id = ?'); params.push(r.department_id); }
  if (r.topic_id) { where.push('q.topic_id = ?'); params.push(r.topic_id); }
  if (r.type) { where.push('q.type = ?'); params.push(r.type); }
  if (r.difficulty) { where.push('q.difficulty = ?'); params.push(r.difficulty); }
  return { sql: where.join(' AND '), params };
}

// How many bank questions each rule can draw from (ignoring overlap between rules).
async function ruleAvailability(conn, rules) {
  const out = [];
  for (const r of rules) {
    const w = ruleWhere(r);
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM exam_questions q WHERE ${w.sql}`, w.params);
    out.push(Number(n));
  }
  return out;
}

// The number of questions an examinee of this set gets.
const setQuestionCount = (st, fixedCount) => (st.mode === 'random'
  ? (parseJson(st.rules, []) || []).reduce((m, r) => m + Number(r.count || 0), 0) : Number(fixedCount || 0));

// The question ids one examinee gets, in their own order.
async function drawQuestions(conn, st) {
  if (st.mode !== 'random') {
    const [qs] = await conn.query('SELECT question_id FROM exam_set_questions WHERE set_id = ? ORDER BY sort_order, id', [st.id]);
    return shuffle(qs.map((q) => Number(q.question_id)));
  }
  const picked = [];
  for (const r of parseJson(st.rules, []) || []) {
    const w = ruleWhere(r);
    const [rows] = await conn.query(
      `SELECT q.id FROM exam_questions q WHERE ${w.sql}${picked.length ? ' AND q.id NOT IN (?)' : ''} ORDER BY RAND() LIMIT ?`,
      [...w.params, ...(picked.length ? [picked] : []), Number(r.count)]);
    picked.push(...rows.map((x) => Number(x.id)));
  }
  return shuffle(picked);
}

// ---- Question pictures ----
// A data URL of a JPEG / PNG / WebP / GIF. The page shrinks a photo before sending it; this only
// refuses what is not a picture or is still too big for the request (the 2MB body limit).
function cleanImage(v) {
  if (v === undefined) return { keep: true };
  if (v === null || v === '') return { value: null };
  const s = String(v);
  if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) return { error: 'The picture must be a JPEG, PNG, WebP or GIF.' };
  if (s.length > 1.6 * 1024 * 1024) return { error: 'The picture is too large. Use a smaller photo (under about 1MB).' };
  return { value: s };
}

// ---- Deadline reminders (daily; EXAM_REMINDER_JOB=1 on ONE box) ----
// Anyone who has not finished an open exam is told 3 days before the deadline and again the day
// before (or on the day). Once a window has closed, the person who scheduled it is told how many
// did not take it. Each reminder is stamped on its row, so a run never repeats one.
async function runExamReminders() {
  const { insertFor, usersWithPermission } = require('./approvalNotifications');
  await sweep();
  const today = phToday();
  let sent = 0;
  const [due] = await pool.query(
    `SELECT a.id, a.user_id, a.status, a.reminded_3_at, a.reminded_1_at, s.title, s.end_date, DATEDIFF(s.end_date, ?) AS days_left
       FROM exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id
      WHERE s.status = 'active' AND a.status IN ('assigned', 'in_progress') AND s.start_date <= ? AND s.end_date >= ?`,
    [today, today, today]);
  for (const a of due) {
    const left = Number(a.days_left);
    let col = null;
    if (left <= 1 && !a.reminded_1_at) col = 'reminded_1_at';
    else if (left <= 3 && left > 1 && !a.reminded_3_at) col = 'reminded_3_at';
    if (!col) continue;
    const [r] = await pool.query(`UPDATE exam_attempts SET ${col} = ? WHERE id = ? AND ${col} IS NULL`, [nowUtc(), a.id]);
    if (!r.affectedRows) continue;
    const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    await insertFor([a.user_id], {
      type: 'exam_reminder', title: `Exam due ${when}: ${a.title}`,
      message: `${a.status === 'in_progress' ? 'Finish' : 'Take'} it by ${day(a.end_date)} (Forms > My Exams).`,
      relatedType: 'ExamAttempt', relatedId: a.id,
    }, null);
    sent += 1;
  }
  const [closed] = await pool.query(
    `SELECT s.id, s.title, s.created_by_user_id, SUM(a.status = 'missed') AS missed, COUNT(a.id) AS assigned
       FROM exam_schedules s LEFT JOIN exam_attempts a ON a.schedule_id = s.id
      WHERE s.status = 'active' AND s.end_date < ? AND s.overdue_notified_at IS NULL GROUP BY s.id`, [today]);
  for (const s of closed) {
    const [r] = await pool.query('UPDATE exam_schedules SET overdue_notified_at = ? WHERE id = ? AND overdue_notified_at IS NULL', [nowUtc(), s.id]);
    if (!r.affectedRows || !Number(s.missed)) continue;
    const to = s.created_by_user_id ? [s.created_by_user_id] : await usersWithPermission('/hrd/exams', 'can_add');
    await insertFor(to, {
      type: 'exam_overdue', title: `${s.missed} of ${s.assigned} did not take ${s.title}`,
      message: 'The exam window has closed. Schedule a retake for them from their result.',
      relatedType: 'ExamSchedule', relatedId: s.id,
    }, null);
    sent += 1;
  }
  // Training courses (lib/training.js) are reminded on the same daily run.
  const training = await require('./training').runTrainingReminders();
  return { reminders: sent, ...training };
}

module.exports = {
  TYPES, TYPE_LABELS, CHOICE_TYPES, parseJson, nowUtc, phToday, day, utcText, windowEndUtc, shuffle,
  TYPED_TYPES, cleanQuestion, cleanGiven, grade, typedMarks, targetUserIds, createAttempts, syncLateJoiner, sweep, finalize,
  topicBreakdown, recommendOrientations, aiAllowed, docxText, extractQuestions, evaluateAttempt, summarizeSchedule,
  DIFFICULTIES, cleanRules, ruleAvailability, setQuestionCount, drawQuestions, cleanImage, runExamReminders,
};
