const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { insertFor } = require('../lib/approvalNotifications');
const { phToday, nowUtc, day, syncLateJoiner: syncExamLateJoiner, sweep } = require('../lib/exams');
const { enrollmentProgress, assignCourse, enroll, syncLateJoiner } = require('../lib/training');
const { certificatePdf } = require('../lib/examCertificate');

const router = express.Router();

// Training (2026-10-21; lib/training.js) -- the "T1S Improvement Plan (Training)" course page.
//
//   Forms > My Training (/trainings)   the courses assigned to you: the course page (title,
//     progress, certificate), its learning materials (open, then Mark as Completed), its quizzes
//     (the exam screen, unchanged), your notes, and the certificate once everything is done.
//   HRD > Training Courses (/hrd/training)   HR: courses, their materials and quizzes, assigning a
//     course to departments / people over a date window, and everyone's progress.
const MY = '/trainings';
const HR = '/hrd/training';
const MAX_FILE = 25 * 1024 * 1024; // as the Archiver keeps a file in the database

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---------------------------------------------------------------- My Training

async function ownEnrollment(req, res) {
  const [[e]] = await pool.query(
    `SELECT en.*, c.title, c.description, ta.start_date, ta.end_date, ta.status AS assignment_status, u.display_name AS user_name
       FROM training_enrollments en JOIN training_courses c ON c.id = en.course_id
       JOIN training_assignments ta ON ta.id = en.assignment_id JOIN users u ON u.id = en.user_id
      WHERE en.id = ?`, [req.params.id]);
  if (!e || Number(e.user_id) !== Number(req.user.id) || e.assignment_status === 'cancelled') {
    res.status(404).json({ error: 'Course not found.' });
    return null;
  }
  return e;
}

router.get('/my', requireAuth, requirePermission(MY, 'can_view'), async (req, res, next) => {
  try {
    await syncLateJoiner(req.user.id);
    await syncExamLateJoiner(req.user.id);
    await sweep({ userId: req.user.id });
    const [rows] = await pool.query(
      `SELECT en.*, c.title, c.description, ta.start_date, ta.end_date
         FROM training_enrollments en JOIN training_courses c ON c.id = en.course_id JOIN training_assignments ta ON ta.id = en.assignment_id
        WHERE en.user_id = ? AND ta.status <> 'cancelled' ORDER BY en.completed_at IS NOT NULL, ta.end_date, en.id DESC`, [req.user.id]);
    const out = [];
    for (const e of rows) {
      const p = await enrollmentProgress(e);
      out.push({
        id: e.id, title: e.title, start_date: e.start_date, end_date: e.end_date, completed_at: p.completed_at,
        materials: p.materials.length, materials_done: p.materials_done, quizzes: p.quizzes.length, quizzes_passed: p.quizzes_passed,
        percent: p.percent, overdue: !p.complete && day(e.end_date) < phToday(),
      });
    }
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/enrollments/:id', requireAuth, requirePermission(MY, 'can_view'), async (req, res, next) => {
  try {
    await sweep({ userId: req.user.id });
    const e = await ownEnrollment(req, res);
    if (!e) return undefined;
    const p = await enrollmentProgress(e);
    const [others] = await pool.query(
      `SELECT en.id, c.title, en.completed_at FROM training_enrollments en JOIN training_courses c ON c.id = en.course_id
         JOIN training_assignments ta ON ta.id = en.assignment_id
        WHERE en.user_id = ? AND en.id <> ? AND ta.status <> 'cancelled' ORDER BY en.id DESC LIMIT 20`, [req.user.id, e.id]);
    return res.json({
      id: e.id, title: e.title, description: e.description, start_date: e.start_date, end_date: e.end_date,
      notes: e.notes || '', open: phToday() >= day(e.start_date), ...p, others,
    });
  } catch (err) { return next(err); }
});

// The material's file -- opened in the page (PDF, picture) or downloaded. Opening it is recorded.
async function sendMaterial(res, materialId, inline) {
  const [[m]] = await pool.query('SELECT file_name, mime_type, file_data FROM training_materials WHERE id = ?', [materialId]);
  if (!m || !m.file_data) return res.status(404).json({ error: 'File not found.' });
  res.setHeader('Content-Type', m.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(m.file_name).replace(/["\r\n]/g, '')}"`);
  return res.send(m.file_data);
}

// Materials open only after the Pre-Test (when the course has one).
async function ownMaterial(req, res, e) {
  if ((await enrollmentProgress(e)).materials_locked) { res.status(409).json({ error: 'Take the Pre-Test first -- the materials open after it.' }); return null; }
  const [[m]] = await pool.query('SELECT id FROM training_materials WHERE id = ? AND course_id = ? AND is_active = 1', [req.params.mid, e.course_id]);
  if (!m) { res.status(404).json({ error: 'Material not found.' }); return null; }
  return m;
}

router.get('/enrollments/:id/materials/:mid/file', requireAuth, requirePermission(MY, 'can_view'), async (req, res, next) => {
  try {
    const e = await ownEnrollment(req, res);
    if (!e) return undefined;
    if (!(await ownMaterial(req, res, e))) return undefined;
    await pool.query(
      `INSERT INTO training_material_progress (enrollment_id, material_id, opened_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE opened_at = COALESCE(opened_at, VALUES(opened_at))`, [e.id, req.params.mid, nowUtc()]);
    if (!e.started_at) await pool.query('UPDATE training_enrollments SET started_at = ? WHERE id = ? AND started_at IS NULL', [nowUtc(), e.id]);
    return sendMaterial(res, req.params.mid, req.query.inline === '1');
  } catch (err) { return next(err); }
});

// Mark as Completed (asked 2026-10-21: a button, not a watch timer) -- and undo.
router.post('/enrollments/:id/materials/:mid/complete', requireAuth, requirePermission(MY, 'can_view'), async (req, res, next) => {
  try {
    const e = await ownEnrollment(req, res);
    if (!e) return undefined;
    if (!(await ownMaterial(req, res, e))) return undefined;
    if (phToday() < day(e.start_date)) return bad(res, `This course opens on ${day(e.start_date)}.`, 409);
    const done = req.body?.completed !== false;
    if (!done && e.completed_at) return bad(res, 'This course is already completed.', 409);
    await pool.query(
      `INSERT INTO training_material_progress (enrollment_id, material_id, opened_at, completed_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE completed_at = VALUES(completed_at), opened_at = COALESCE(opened_at, VALUES(opened_at))`,
      [e.id, req.params.mid, nowUtc(), done ? nowUtc() : null]);
    if (!e.started_at) await pool.query('UPDATE training_enrollments SET started_at = ? WHERE id = ? AND started_at IS NULL', [nowUtc(), e.id]);
    const p = await enrollmentProgress(e);
    return res.json({ ok: true, percent: p.percent, complete: p.complete });
  } catch (err) { return next(err); }
});

router.put('/enrollments/:id/notes', requireAuth, requirePermission(MY, 'can_view'), async (req, res, next) => {
  try {
    const e = await ownEnrollment(req, res);
    if (!e) return undefined;
    await pool.query('UPDATE training_enrollments SET notes = ? WHERE id = ?', [String(req.body?.notes || '').slice(0, 20000) || null, e.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

async function sendCourseCertificate(res, e) {
  const p = await enrollmentProgress(e);
  if (!p.complete) return bad(res, 'Finish every material and pass every quiz to get the certificate.', 409);
  const scores = p.quizzes.map((q) => q.best_percent).filter((v) => v != null);
  const avg = scores.length ? scores.reduce((m, v) => m + v, 0) / scores.length : null;
  const pdf = await certificatePdf({
    name: e.user_name, title: e.title, date: day(p.completed_at),
    heading: 'has successfully completed the training course',
    detail: `${p.materials.length} learning material(s)${p.quizzes.length ? ` · quiz score ${avg.toFixed(1).replace(/\.0$/, '')}%` : ''} · completed on ${new Date(`${day(p.completed_at)}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
    certificateNo: `TRC-${String(e.id).padStart(6, '0')}`,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="certificate-${String(e.title).replace(/[^\w.-]+/g, '-')}-${e.id}.pdf"`);
  return res.send(pdf);
}

router.get('/enrollments/:id/certificate', requireAuth, requirePermission(MY, 'can_view'), async (req, res, next) => {
  try {
    const e = await ownEnrollment(req, res);
    if (!e) return undefined;
    return sendCourseCertificate(res, e);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------- Courses (HR)

router.get('/courses', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, d.name AS department, u.display_name AS created_by,
              (SELECT COUNT(*) FROM training_materials m WHERE m.course_id = c.id AND m.is_active = 1) AS materials,
              (SELECT COUNT(*) FROM training_course_quizzes q WHERE q.course_id = c.id AND q.is_active = 1) AS quizzes,
              (SELECT COUNT(*) FROM training_enrollments en JOIN training_assignments ta ON ta.id = en.assignment_id
                WHERE en.course_id = c.id AND ta.status <> 'cancelled') AS enrolled,
              (SELECT COUNT(*) FROM training_enrollments en JOIN training_assignments ta ON ta.id = en.assignment_id
                WHERE en.course_id = c.id AND ta.status <> 'cancelled' AND en.completed_at IS NOT NULL) AS completed
         FROM training_courses c LEFT JOIN departments d ON d.id = c.department_id LEFT JOIN users u ON u.id = c.created_by_user_id
        WHERE c.is_active = 1 ORDER BY c.id DESC`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/courses/:id', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM training_courses WHERE id = ?', [req.params.id]);
    if (!c) return bad(res, 'Course not found.', 404);
    const [materials] = await pool.query(
      'SELECT id, title, description, file_name, mime_type, file_size, sort_order FROM training_materials WHERE course_id = ? AND is_active = 1 ORDER BY sort_order, id', [c.id]);
    const [quizzes] = await pool.query(
      `SELECT cq.id, cq.set_id, cq.instructions, cq.kind, st.name AS set_name FROM training_course_quizzes cq JOIN exam_sets st ON st.id = cq.set_id
        WHERE cq.course_id = ? AND cq.is_active = 1 ORDER BY cq.sort_order, cq.id`, [c.id]);
    const [assignments] = await pool.query(
      `SELECT ta.*, COUNT(en.id) AS enrolled, SUM(en.completed_at IS NOT NULL) AS completed,
              (SELECT GROUP_CONCAT(COALESCE(d.name, tu.display_name) SEPARATOR ', ') FROM training_assignment_targets t
                 LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN users tu ON tu.id = t.user_id WHERE t.assignment_id = ta.id) AS targets
         FROM training_assignments ta LEFT JOIN training_enrollments en ON en.assignment_id = ta.id
        WHERE ta.course_id = ? GROUP BY ta.id ORDER BY ta.id DESC`, [c.id]);
    return res.json({ ...c, materials: materials.map((m) => ({ ...m, file_size: Number(m.file_size) })), quizzes, assignments });
  } catch (err) { return next(err); }
});

// Title, instructions, department, and the quizzes (exam sets, each with its own instructions).
async function saveCourse(conn, id, b, userId) {
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return { error: 'Give the course a title.' };
  const KINDS = ['pre_test', 'quiz', 'post_test'];
  const quizzes = (Array.isArray(b.quizzes) ? b.quizzes : []).map((q) => ({
    set_id: Number(q.set_id), instructions: String(q.instructions || '').trim() || null, kind: KINDS.includes(q.kind) ? q.kind : 'quiz',
  }))
    .filter((q) => q.set_id);
  if (quizzes.length) {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM exam_sets WHERE id IN (?) AND is_active = 1', [quizzes.map((q) => q.set_id)]);
    if (Number(n) !== new Set(quizzes.map((q) => q.set_id)).size) return { error: 'One of the quizzes is no longer an active exam set.' };
    if (quizzes.filter((q) => q.kind === 'pre_test').length > 1 || quizzes.filter((q) => q.kind === 'post_test').length > 1) {
      return { error: 'A course has at most one Pre-Test and one Post-Test.' };
    }
  }
  const fields = [title, String(b.description || '').trim() || null, Number(b.department_id) || null];
  let courseId = id;
  if (id) await conn.query('UPDATE training_courses SET title = ?, description = ?, department_id = ? WHERE id = ?', [...fields, id]);
  else {
    const [r] = await conn.query('INSERT INTO training_courses (title, description, department_id, created_by_user_id) VALUES (?, ?, ?, ?)', [...fields, userId]);
    courseId = r.insertId;
  }
  // Quizzes are matched by set: a kept quiz keeps its id (its schedules and attempts stay linked);
  // one taken off is retired, not deleted.
  // Matched by set AND kind: a Pre-Test and a Post-Test may be the same exam set.
  const [cur] = await conn.query('SELECT id, set_id, kind FROM training_course_quizzes WHERE course_id = ? AND is_active = 1', [courseId]);
  const keep = new Set();
  for (let i = 0; i < quizzes.length; i += 1) {
    const q = quizzes[i];
    const found = cur.find((x) => Number(x.set_id) === q.set_id && (x.kind || 'quiz') === q.kind && !keep.has(x.id));
    if (found) {
      keep.add(found.id);
      await conn.query('UPDATE training_course_quizzes SET instructions = ?, sort_order = ? WHERE id = ?', [q.instructions, i, found.id]);
    } else {
      await conn.query('INSERT INTO training_course_quizzes (course_id, set_id, instructions, kind, sort_order) VALUES (?, ?, ?, ?, ?)', [courseId, q.set_id, q.instructions, q.kind, i]);
    }
  }
  for (const x of cur) if (!keep.has(x.id)) await conn.query('UPDATE training_course_quizzes SET is_active = 0 WHERE id = ?', [x.id]);
  return { id: courseId };
}

router.post('/courses', requireAuth, requirePermission(HR, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await saveCourse(conn, null, req.body, req.user.id);
    if (r.error) { await conn.rollback(); return bad(res, r.error); }
    await conn.commit();
    return res.json(r);
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

router.put('/courses/:id', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[c]] = await conn.query('SELECT id FROM training_courses WHERE id = ? AND is_active = 1', [req.params.id]);
    if (!c) return bad(res, 'Course not found.', 404);
    await conn.beginTransaction();
    const r = await saveCourse(conn, c.id, req.body, req.user.id);
    if (r.error) { await conn.rollback(); return bad(res, r.error); }
    await conn.commit();
    return res.json(r);
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

router.delete('/courses/:id', requireAuth, requirePermission(HR, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('UPDATE training_courses SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// A learning material: any file up to 25MB (PDF, Word, PowerPoint, Excel, pictures...).
router.post('/courses/:id/materials', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query('SELECT id FROM training_courses WHERE id = ? AND is_active = 1', [req.params.id]);
    if (!c) return bad(res, 'Course not found.', 404);
    const raw = String(req.body.file_data || '');
    const mime = (raw.match(/^data:([^;,]+)[;,]/) || [])[1] || null;
    const buf = Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64');
    const fileName = String(req.body.file_name || '').trim().slice(0, 255);
    if (!buf.length || !fileName) return bad(res, 'Attach the file.');
    if (buf.length > MAX_FILE) return bad(res, 'The file is over 25MB.');
    const title = String(req.body.title || '').trim().slice(0, 200) || fileName.replace(/\.[^.]+$/, '');
    const [[{ n }]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM training_materials WHERE course_id = ?', [c.id]);
    const [r] = await pool.query(
      `INSERT INTO training_materials (course_id, title, description, file_name, mime_type, file_size, file_data, sort_order, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, title, String(req.body.description || '').trim().slice(0, 1000) || null, fileName, mime, buf.length, buf, n, req.user.id]);
    return res.json({ id: r.insertId });
  } catch (err) { return next(err); }
});

router.put('/materials/:id', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  try {
    const [[m]] = await pool.query('SELECT id, course_id, title, description FROM training_materials WHERE id = ? AND is_active = 1', [req.params.id]);
    if (!m) return bad(res, 'Material not found.', 404);
    const title = String(req.body.title ?? m.title).trim().slice(0, 200);
    if (!title) return bad(res, 'Give the material a title.');
    await pool.query('UPDATE training_materials SET title = ?, description = ? WHERE id = ?',
      [title, String(req.body.description ?? m.description ?? '').trim().slice(0, 1000) || null, m.id]);
    // Moving up / down swaps places with the neighbour.
    if (req.body.move === 'up' || req.body.move === 'down') {
      const [list] = await pool.query('SELECT id FROM training_materials WHERE course_id = ? AND is_active = 1 ORDER BY sort_order, id', [m.course_id]);
      const ids = list.map((x) => Number(x.id));
      const i = ids.indexOf(Number(m.id));
      const j = req.body.move === 'up' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < ids.length) {
        [ids[i], ids[j]] = [ids[j], ids[i]];
        for (let k = 0; k < ids.length; k += 1) await pool.query('UPDATE training_materials SET sort_order = ? WHERE id = ?', [k, ids[k]]);
      }
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Taken off the course (kept, so who completed it still shows).
router.delete('/materials/:id', requireAuth, requirePermission(HR, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('UPDATE training_materials SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/materials/:id/file', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try { await sendMaterial(res, req.params.id, req.query.inline === '1'); } catch (err) { next(err); }
});

// ---------------------------------------------------------------- Assigning (HR)

router.post('/courses/:id/assign', requireAuth, requirePermission(HR, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[c]] = await conn.query('SELECT id, title FROM training_courses WHERE id = ? AND is_active = 1', [req.params.id]);
    if (!c) return bad(res, 'Course not found.', 404);
    const [[{ n }]] = await conn.query(
      `SELECT (SELECT COUNT(*) FROM training_materials WHERE course_id = ? AND is_active = 1)
            + (SELECT COUNT(*) FROM training_course_quizzes WHERE course_id = ? AND is_active = 1) AS n`, [c.id, c.id]);
    if (!Number(n)) return bad(res, 'Add learning materials or a quiz to the course first.');
    if (!isDate(req.body.start_date) || !isDate(req.body.end_date)) return bad(res, 'Set the date the course opens and the date it must be done by.');
    if (req.body.end_date < req.body.start_date) return bad(res, 'The end date is before the start date.');
    if (req.body.end_date < phToday()) return bad(res, 'The end date has already passed.');
    const departmentIds = [...new Set((req.body.department_ids || []).map(Number).filter(Boolean))];
    const userIds = [...new Set((req.body.user_ids || []).map(Number).filter(Boolean))];
    if (!departmentIds.length && !userIds.length) return bad(res, 'Assign it to at least one department or person.');
    await conn.beginTransaction();
    const { assignmentId, added } = await assignCourse(conn, { courseId: c.id, start: req.body.start_date, end: req.body.end_date, departmentIds, userIds }, req.user.id);
    await conn.commit();
    try {
      const [rows] = added.length ? await pool.query('SELECT id, user_id FROM training_enrollments WHERE assignment_id = ? AND user_id IN (?)', [assignmentId, added]) : [[]];
      for (const e of rows) {
        await insertFor([e.user_id], {
          type: 'training', title: `Training: ${c.title}`, message: `Finish it between ${req.body.start_date} and ${req.body.end_date} (Forms > My Training).`,
          relatedType: 'TrainingEnrollment', relatedId: e.id,
        }, req.user.id);
      }
    } catch (err) { console.error('[training] notify:', err.message); }
    return res.json({ id: assignmentId, enrolled: added.length });
  } catch (err) { await conn.rollback().catch(() => {}); return next(err); } finally { conn.release(); }
});

// One assignment: everyone in it with their progress.
router.get('/assignments/:id', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [[ta]] = await pool.query(
      `SELECT ta.*, c.title FROM training_assignments ta JOIN training_courses c ON c.id = ta.course_id WHERE ta.id = ?`, [req.params.id]);
    if (!ta) return bad(res, 'Not found.', 404);
    await sweep();
    const [ens] = await pool.query(
      `SELECT en.*, u.display_name AS name, d.name AS department FROM training_enrollments en JOIN users u ON u.id = en.user_id
         LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN departments d ON d.id = e.department_id
        WHERE en.assignment_id = ? ORDER BY d.name, u.display_name`, [ta.id]);
    const rows = [];
    let quizNames = [];
    for (const e of ens) {
      const p = await enrollmentProgress(e);
      quizNames = p.quizzes.map((q) => ({ id: q.id, name: q.name, kind: q.kind }));
      rows.push({
        id: e.id, user_id: e.user_id, name: e.name, department: e.department, started_at: e.started_at, completed_at: p.completed_at,
        materials: p.materials.length, materials_done: p.materials_done, percent: p.percent,
        quizzes: p.quizzes.map((q) => ({ id: q.id, kind: q.kind, state: q.state, done: q.done, percent: q.kind === 'pre_test' ? q.first_percent : q.best_percent, attempt_id: q.attempt_id })),
        gain: p.gain,
      });
    }
    const [targets] = await pool.query(
      `SELECT d.name AS department, u.display_name AS user FROM training_assignment_targets t
         LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN users u ON u.id = t.user_id WHERE t.assignment_id = ?`, [ta.id]);
    return res.json({ assignment: ta, targets, quizzes: quizNames, rows });
  } catch (err) { return next(err); }
});

router.post('/assignments/:id/cancel', requireAuth, requirePermission(HR, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query("UPDATE training_assignments SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    await pool.query("UPDATE exam_schedules SET status = 'cancelled' WHERE training_assignment_id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// HR's copy of a course certificate.
router.get('/enrollments/:id/certificate-hr', requireAuth, requirePermission(HR, 'can_view'), async (req, res, next) => {
  try {
    const [[e]] = await pool.query(
      `SELECT en.*, c.title, u.display_name AS user_name FROM training_enrollments en JOIN training_courses c ON c.id = en.course_id
         JOIN users u ON u.id = en.user_id WHERE en.id = ?`, [req.params.id]);
    if (!e) return bad(res, 'Not found.', 404);
    return sendCourseCertificate(res, e);
  } catch (err) { return next(err); }
});

// An employee's courses, for their training record (Examinations > Employees).
router.get('/users/:userId', requireAuth, async (req, res, next) => {
  try {
    if (!(await userCan(req.user.id, HR, 'can_view')) && !(await userCan(req.user.id, '/hrd/exams', 'can_view'))) {
      return bad(res, 'You do not have permission to perform this action', 403);
    }
    const [ens] = await pool.query(
      `SELECT en.*, c.title, ta.start_date, ta.end_date FROM training_enrollments en JOIN training_courses c ON c.id = en.course_id
         JOIN training_assignments ta ON ta.id = en.assignment_id
        WHERE en.user_id = ? AND ta.status <> 'cancelled' ORDER BY en.id DESC`, [req.params.userId]);
    const out = [];
    for (const e of ens) {
      const p = await enrollmentProgress(e);
      out.push({
        id: e.id, assignment_id: e.assignment_id, title: e.title, start_date: e.start_date, end_date: e.end_date, completed_at: p.completed_at,
        percent: p.percent, materials: p.materials.length, materials_done: p.materials_done, quizzes: p.quizzes.length, quizzes_passed: p.quizzes_passed,
        gain: p.gain,
      });
    }
    return res.json(out);
  } catch (err) { return next(err); }
});

module.exports = router;
module.exports.enroll = enroll;
