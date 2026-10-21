const pool = require('../db');
const { phToday, nowUtc, day, parseJson, targetUserIds, createAttempts, setQuestionCount } = require('./exams');

// HRD > Training (2026-10-21; db/create-training-module.js). What My Training (routes/training.js)
// and HR's side share: an enrollment's progress, assigning a course, and its reminders.
//
// PROGRESS. A course is done when every (active) material is marked Completed and every quiz is
// PASSED. A quiz is the exam schedule made for it with the assignment -- or a retake HR scheduled
// from one of its attempts (routes/examAdmin.js retake), however many deep: passing the retake
// passes the quiz. Materials added to a course later count for everyone already taking it.

// Every attempt of `userId` that answers a course quiz: the assignment's own schedule's, and the
// retakes made from it (and from those).
async function quizAttempts(assignmentId, courseQuizId, userId) {
  const [first] = await pool.query(
    `SELECT a.* FROM exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id
      WHERE s.training_assignment_id = ? AND s.training_course_quiz_id = ? AND a.user_id = ? AND s.status <> 'cancelled'`,
    [assignmentId, courseQuizId, userId]);
  const all = [...first];
  let frontier = first.map((a) => a.id);
  for (let depth = 0; frontier.length && depth < 10; depth += 1) {
    const [next] = await pool.query(
      `SELECT a.* FROM exam_attempts a JOIN exam_schedules s ON s.id = a.schedule_id
        WHERE s.retake_of_attempt_id IN (?) AND a.user_id = ? AND s.status <> 'cancelled'`, [frontier, userId]);
    all.push(...next);
    frontier = next.map((a) => a.id);
  }
  return all;
}

// The quiz's standing from its attempts: passed (any passed attempt), else the latest one's.
function quizStanding(attempts) {
  const passed = attempts.find((a) => a.status === 'submitted' && Number(a.passed) === 1 && !Number(a.essays_pending));
  const latest = [...attempts].sort((x, y) => Number(y.id) - Number(x.id))[0] || null;
  const shown = passed || latest;
  let state = 'not_taken';
  if (passed) state = 'passed';
  else if (latest?.status === 'submitted') state = Number(latest.essays_pending) ? 'grading' : 'failed';
  else if (latest?.status === 'in_progress') state = 'in_progress';
  else if (latest?.status === 'missed') state = 'missed';
  return {
    state, attempt_id: shown?.id || null, status: shown?.status || null, percent: shown?.percent == null ? null : Number(shown.percent),
    best_percent: attempts.reduce((m, a) => (a.status === 'submitted' && a.percent != null ? Math.max(m ?? 0, Number(a.percent)) : m), null),
    attempts: attempts.filter((a) => a.status === 'submitted').length,
  };
}

// One enrollment's progress -- and the moment it completes, stamped once.
async function enrollmentProgress(enrollment) {
  const e = enrollment;
  const [materials] = await pool.query(
    `SELECT m.id, m.title, m.description, m.file_name, m.mime_type, m.file_size, p.completed_at, p.opened_at
       FROM training_materials m LEFT JOIN training_material_progress p ON p.material_id = m.id AND p.enrollment_id = ?
      WHERE m.course_id = ? AND m.is_active = 1 ORDER BY m.sort_order, m.id`, [e.id, e.course_id]);
  const [cqs] = await pool.query(
    `SELECT cq.id, cq.set_id, cq.instructions, st.name AS set_name, st.mode, st.rules, st.time_limit_minutes, st.passing_percent,
            (SELECT COUNT(*) FROM exam_set_questions sq WHERE sq.set_id = st.id) AS fixed_count,
            (SELECT COALESCE(SUM(q.points), 0) FROM exam_set_questions sq JOIN exam_questions q ON q.id = sq.question_id WHERE sq.set_id = st.id) AS fixed_points
       FROM training_course_quizzes cq JOIN exam_sets st ON st.id = cq.set_id
      WHERE cq.course_id = ? AND cq.is_active = 1 ORDER BY cq.sort_order, cq.id`, [e.course_id]);
  const quizzes = [];
  for (const cq of cqs) {
    const standing = quizStanding(await quizAttempts(e.assignment_id, cq.id, e.user_id));
    quizzes.push({
      id: cq.id, set_id: cq.set_id, name: cq.set_name, instructions: cq.instructions,
      questions: setQuestionCount(cq, cq.fixed_count), total_marks: cq.mode === 'random' ? null : Number(cq.fixed_points),
      time_limit_minutes: cq.time_limit_minutes, passing_percent: Number(cq.passing_percent), ...standing,
    });
  }
  const materialsDone = materials.filter((m) => m.completed_at).length;
  const quizzesPassed = quizzes.filter((q) => q.state === 'passed').length;
  const total = materials.length + quizzes.length;
  const done = materialsDone + quizzesPassed;
  let completedAt = e.completed_at;
  if (total > 0 && done === total && !completedAt) {
    completedAt = nowUtc();
    await pool.query('UPDATE training_enrollments SET completed_at = ? WHERE id = ? AND completed_at IS NULL', [completedAt, e.id]);
  }
  // Once completed it stays completed (its certificate stands) -- a material HR adds afterwards
  // does not take it back.
  const complete = !!completedAt;
  return {
    materials: materials.map((m) => ({ ...m, file_size: Number(m.file_size) })), quizzes,
    materials_done: materialsDone, quizzes_passed: quizzesPassed,
    percent: total ? Math.round((done / total) * 100) : 0, complete, completed_at: completedAt,
  };
}

// Gives a course to departments / people: the assignment, an enrollment each, and an exam schedule
// for each of the course's quizzes over the same window and the same people.
async function assignCourse(conn, { courseId, start, end, departmentIds, userIds }, actorId) {
  const [[course]] = await conn.query('SELECT * FROM training_courses WHERE id = ?', [courseId]);
  const [r] = await conn.query('INSERT INTO training_assignments (course_id, start_date, end_date, created_by_user_id) VALUES (?, ?, ?, ?)',
    [courseId, start, end, actorId]);
  const assignmentId = r.insertId;
  for (const d of departmentIds) await conn.query('INSERT INTO training_assignment_targets (assignment_id, department_id) VALUES (?, ?)', [assignmentId, d]);
  for (const u of userIds) await conn.query('INSERT INTO training_assignment_targets (assignment_id, user_id) VALUES (?, ?)', [assignmentId, u]);
  const people = await targetUserIds(conn, departmentIds, userIds);
  const added = await enroll(conn, { id: assignmentId, course_id: courseId }, people);
  const [cqs] = await conn.query(
    `SELECT cq.id, cq.set_id, st.name FROM training_course_quizzes cq JOIN exam_sets st ON st.id = cq.set_id
      WHERE cq.course_id = ? AND cq.is_active = 1 ORDER BY cq.sort_order, cq.id`, [courseId]);
  for (const cq of cqs) {
    const [s] = await conn.query(
      `INSERT INTO exam_schedules (set_id, title, start_date, end_date, training_assignment_id, training_course_quiz_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [cq.set_id, `${course.title} -- ${cq.name}`.slice(0, 200), start, end, assignmentId, cq.id, actorId]);
    for (const d of departmentIds) await conn.query('INSERT INTO exam_schedule_targets (schedule_id, department_id) VALUES (?, ?)', [s.insertId, d]);
    for (const u of userIds) await conn.query('INSERT INTO exam_schedule_targets (schedule_id, user_id) VALUES (?, ?)', [s.insertId, u]);
    await createAttempts(conn, { id: s.insertId, set_id: cq.set_id }, people);
  }
  return { assignmentId, added, course };
}

async function enroll(conn, assignment, userIds) {
  const added = [];
  for (const uid of userIds) {
    const [x] = await conn.query('INSERT IGNORE INTO training_enrollments (assignment_id, course_id, user_id) VALUES (?, ?, ?)',
      [assignment.id, assignment.course_id, uid]);
    if (x.affectedRows) added.push(uid);
  }
  return added;
}

// Someone who joined a targeted department after the course was assigned is enrolled while it is
// open. (Its quizzes' exam schedules pick them up the same way -- lib/exams.js syncLateJoiner.)
async function syncLateJoiner(userId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT ta.id, ta.course_id FROM training_assignments ta
       JOIN training_assignment_targets t ON t.assignment_id = ta.id
       JOIN employees e ON e.department_id = t.department_id
       JOIN users u ON u.employee_id = e.id AND u.id = ?
      WHERE ta.status = 'active' AND ta.end_date >= ?
        AND NOT EXISTS (SELECT 1 FROM training_enrollments en WHERE en.assignment_id = ta.id AND en.user_id = u.id)`,
    [userId, phToday()]);
  for (const a of rows) await enroll(pool, a, [userId]);
}

// Daily with the exam reminders: an unfinished course 3 days before its end date and the day before.
async function runTrainingReminders() {
  const { insertFor } = require('./approvalNotifications');
  const today = phToday();
  const [rows] = await pool.query(
    `SELECT en.*, ta.end_date, c.title, DATEDIFF(ta.end_date, ?) AS days_left
       FROM training_enrollments en JOIN training_assignments ta ON ta.id = en.assignment_id JOIN training_courses c ON c.id = en.course_id
      WHERE ta.status = 'active' AND en.completed_at IS NULL AND ta.start_date <= ? AND ta.end_date >= ?`, [today, today, today]);
  let sent = 0;
  for (const e of rows) {
    const left = Number(e.days_left);
    let col = null;
    if (left <= 1 && !e.reminded_1_at) col = 'reminded_1_at';
    else if (left <= 3 && left > 1 && !e.reminded_3_at) col = 'reminded_3_at';
    if (!col) continue;
    if ((await enrollmentProgress(e)).complete) continue;
    const [r] = await pool.query(`UPDATE training_enrollments SET ${col} = ? WHERE id = ? AND ${col} IS NULL`, [nowUtc(), e.id]);
    if (!r.affectedRows) continue;
    const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    await insertFor([e.user_id], {
      type: 'training_reminder', title: `Training due ${when}: ${e.title}`,
      message: `Finish the materials and quiz by ${day(e.end_date)} (Forms > My Training).`,
      relatedType: 'TrainingEnrollment', relatedId: e.id,
    }, null);
    sent += 1;
  }
  return { training_reminders: sent };
}

module.exports = { enrollmentProgress, assignCourse, enroll, syncLateJoiner, runTrainingReminders, quizStanding, parseJson };
