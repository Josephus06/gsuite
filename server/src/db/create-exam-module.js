// HRD > Examinations (asked 2026-10-21). Department heads keep a bank of questions for their
// department (typed in, or read from a PDF by the AI and reviewed); HR builds exam SETS from it,
// schedules a set for departments and/or users over a date window, and every examinee gets the
// same set in their own shuffled order. Scores are evaluated per TOPIC, and a topic below the
// set's re-orientation line recommends that topic's orientation -- "attended on date X" once done.
//
//   exam_topics              a subject a question tests (Machinery Knowledge), + its orientation's name
//   exam_questions           the bank: department, topic, type, question, choices, answer key, points
//   exam_sets / _questions   a fixed list of questions with time limit, passing % and re-orientation %
//   exam_schedules / _targets  a set given to departments and/or users between two dates
//   exam_attempts            one per examinee per schedule: shuffled order, status, score
//   exam_attempt_answers     each answer: confirmed (locked) or not, graded, essay points/feedback
//   exam_orientations        recommended / scheduled / attended / dismissed re-orientation per topic
//
//   pages  /exams                "My Exams"       every user (taking the exams scheduled for them)
//          /hrd/exams            "Examinations"   HR: sets, schedules, results, grading, re-orientation
//          /hrd/exam-questions   "Question Bank"  department heads (their own department) and HR (View All)
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/create-exam-module.js
require('dotenv').config();
const pool = require('../db');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS exam_topics (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     department_id BIGINT NULL,
     name VARCHAR(150) NOT NULL,
     orientation_name VARCHAR(200) NULL,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_exam_topics_dept (department_id)
   )`,
  `CREATE TABLE IF NOT EXISTS exam_questions (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     department_id BIGINT NOT NULL,
     topic_id BIGINT NULL,
     type VARCHAR(20) NOT NULL,
     question TEXT NOT NULL,
     choices JSON NULL,
     answer JSON NULL,
     points DECIMAL(6,2) NOT NULL DEFAULT 1,
     difficulty VARCHAR(10) NULL,
     source VARCHAR(10) NOT NULL DEFAULT 'manual',
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_exam_questions_dept (department_id, is_active),
     KEY idx_exam_questions_topic (topic_id)
   )`,
  `CREATE TABLE IF NOT EXISTS exam_sets (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(150) NOT NULL,
     department_id BIGINT NULL,
     description VARCHAR(500) NULL,
     time_limit_minutes INT NULL,
     passing_percent DECIMAL(5,2) NOT NULL DEFAULT 75,
     reorient_below_percent DECIMAL(5,2) NOT NULL DEFAULT 60,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS exam_set_questions (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     set_id BIGINT NOT NULL,
     question_id BIGINT NOT NULL,
     sort_order INT NOT NULL DEFAULT 0,
     UNIQUE KEY uq_exam_set_question (set_id, question_id)
   )`,
  `CREATE TABLE IF NOT EXISTS exam_schedules (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     set_id BIGINT NOT NULL,
     title VARCHAR(200) NOT NULL,
     start_date DATE NOT NULL,
     end_date DATE NOT NULL,
     status VARCHAR(15) NOT NULL DEFAULT 'active',
     retake_of_attempt_id BIGINT NULL,
     ai_summary TEXT NULL,
     ai_summary_at DATETIME NULL,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_exam_schedules_dates (start_date, end_date)
   )`,
  `CREATE TABLE IF NOT EXISTS exam_schedule_targets (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     schedule_id BIGINT NOT NULL,
     department_id BIGINT NULL,
     user_id BIGINT NULL,
     KEY idx_exam_targets_schedule (schedule_id),
     KEY idx_exam_targets_dept (department_id),
     KEY idx_exam_targets_user (user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS exam_attempts (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     schedule_id BIGINT NOT NULL,
     set_id BIGINT NOT NULL,
     user_id BIGINT NOT NULL,
     status VARCHAR(15) NOT NULL DEFAULT 'assigned',
     question_order JSON NULL,
     started_at DATETIME NULL,
     deadline_at DATETIME NULL,
     submitted_at DATETIME NULL,
     auto_submitted TINYINT(1) NOT NULL DEFAULT 0,
     score DECIMAL(8,2) NULL,
     max_score DECIMAL(8,2) NULL,
     percent DECIMAL(5,2) NULL,
     passed TINYINT(1) NULL,
     essays_pending INT NOT NULL DEFAULT 0,
     tab_switches INT NOT NULL DEFAULT 0,
     ai_evaluation TEXT NULL,
     ai_evaluation_at DATETIME NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY uq_exam_attempt (schedule_id, user_id),
     KEY idx_exam_attempts_user (user_id, status)
   )`,
  `CREATE TABLE IF NOT EXISTS exam_attempt_answers (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     attempt_id BIGINT NOT NULL,
     question_id BIGINT NOT NULL,
     choice_order JSON NULL,
     answer JSON NULL,
     confirmed_at DATETIME NULL,
     is_correct TINYINT(1) NULL,
     points_awarded DECIMAL(6,2) NULL,
     graded_by_user_id BIGINT NULL,
     graded_at DATETIME NULL,
     feedback VARCHAR(1000) NULL,
     UNIQUE KEY uq_exam_answer (attempt_id, question_id)
   )`,
  `CREATE TABLE IF NOT EXISTS exam_orientations (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     user_id BIGINT NOT NULL,
     topic_id BIGINT NULL,
     attempt_id BIGINT NULL,
     topic_percent DECIMAL(5,2) NULL,
     status VARCHAR(15) NOT NULL DEFAULT 'recommended',
     scheduled_date DATE NULL,
     attended_date DATE NULL,
     notes VARCHAR(500) NULL,
     updated_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY uq_exam_orientation (attempt_id, topic_id),
     KEY idx_exam_orientations_user (user_id, status)
   )`,
];

const PAGES = [
  ['/exams', 'My Exams'],
  ['/hrd/exams', 'Examinations'],
  ['/hrd/exam-questions', 'Question Bank'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const sql of TABLES) {
    const name = sql.match(/EXISTS (\w+)/)[1];
    await pool.query(sql);
    console.log(`  table ${name} ready`);
  }

  const ids = {};
  for (const [route, name] of PAGES) {
    const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    if (existing) { ids[route] = existing.id; console.log(`  page ${route} already registered (id ${existing.id})`); continue; }
    const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [route, name]);
    ids[route] = r.insertId;
    console.log(`  registered ${route} (id ${r.insertId})`);
  }

  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
  const grant = async (userId, pageId, rights) => {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [userId, pageId]);
    if (p) { await pool.query(`UPDATE user_page_permissions SET ${rights.map((f) => `${f} = TRUE`).join(', ')} WHERE id = ?`, [p.id]); return 0; }
    await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, ${rights.join(', ')}) VALUES (?, ?, ${rights.map(() => 'TRUE').join(', ')})`, [userId, pageId]);
    return 1;
  };

  // My Exams: everyone takes the exams scheduled for them -- every user, and every account-type
  // template so a user created later has it too.
  const [users] = await pool.query('SELECT id FROM users');
  let n = 0;
  for (const u of users) n += await grant(u.id, ids['/exams'], ['can_view']);
  console.log(`  My Exams: view granted to ${n} more user(s)`);
  const [types] = await pool.query('SELECT DISTINCT account_type FROM account_type_permissions');
  for (const t of types) {
    const [[row]] = await pool.query('SELECT 1 AS x FROM account_type_permissions WHERE account_type = ? AND page_id = ?', [t.account_type, ids['/exams']]);
    if (!row) await pool.query('INSERT INTO account_type_permissions (account_type, page_id, can_view, updated_at) VALUES (?, ?, TRUE, NOW())', [t.account_type, ids['/exams']]);
  }
  console.log(`  My Exams: on ${types.length} account-type template(s)`);

  // Question Bank: each department head, for their own department (the route scopes it).
  const [heads] = await pool.query('SELECT DISTINCT head_user_id AS id FROM departments WHERE head_user_id IS NOT NULL AND is_active = 1');
  n = 0;
  for (const h of heads) n += await grant(h.id, ids['/hrd/exam-questions'], ['can_view', 'can_add', 'can_edit', 'can_delete']);
  console.log(`  Question Bank: ${heads.length} department head(s) (${n} new)`);

  // System Admins: every right on all three.
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const a of admins) for (const [route] of PAGES) await grant(a.id, ids[route], flags);
  console.log(`  ${admins.length} System Admin(s) given every right on the exam pages`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
