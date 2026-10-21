// HRD > Training (asked 2026-10-21, "T1S Improvement Plan (Training)"): COURSES -- a title and
// instructions, learning MATERIALS (uploaded files the employee opens and marks Completed), and
// QUIZZES (exam sets from Examinations, taken on the same exam screen). HR assigns a course to
// departments / people over a date window like an exam; finishing every material and passing every
// quiz completes it and unlocks its certificate.
//
//   training_courses / _materials / _course_quizzes   the course, its files (in the database, up
//                                                       to 25MB each, as the Archiver keeps small
//                                                       files), and its quizzes
//   training_assignments / _targets                     a course given to departments / people
//   training_enrollments                                one per person per assignment (+ their notes)
//   training_material_progress                          the materials each enrollee marked Completed
//   exam_schedules.training_assignment_id / .training_course_quiz_id
//                                                       a course quiz's exam schedule, made with the
//                                                       assignment
//
//   pages  /trainings     "My Training"       every user
//          /hrd/training  "Training Courses"  HR. System Admins get every right.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/create-training-module.js
require('dotenv').config();
const pool = require('../db');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS training_courses (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     title VARCHAR(200) NOT NULL,
     description TEXT NULL,
     department_id BIGINT NULL,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS training_materials (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     course_id BIGINT NOT NULL,
     title VARCHAR(200) NOT NULL,
     description VARCHAR(1000) NULL,
     file_name VARCHAR(255) NOT NULL,
     mime_type VARCHAR(150) NULL,
     file_size BIGINT NOT NULL DEFAULT 0,
     file_data LONGBLOB NULL,
     sort_order INT NOT NULL DEFAULT 0,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_training_materials_course (course_id, is_active)
   )`,
  `CREATE TABLE IF NOT EXISTS training_course_quizzes (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     course_id BIGINT NOT NULL,
     set_id BIGINT NOT NULL,
     instructions TEXT NULL,
     sort_order INT NOT NULL DEFAULT 0,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     KEY idx_training_quizzes_course (course_id)
   )`,
  `CREATE TABLE IF NOT EXISTS training_assignments (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     course_id BIGINT NOT NULL,
     start_date DATE NOT NULL,
     end_date DATE NOT NULL,
     status VARCHAR(15) NOT NULL DEFAULT 'active',
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_training_assignments_course (course_id)
   )`,
  `CREATE TABLE IF NOT EXISTS training_assignment_targets (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     assignment_id BIGINT NOT NULL,
     department_id BIGINT NULL,
     user_id BIGINT NULL,
     KEY idx_training_targets_assignment (assignment_id),
     KEY idx_training_targets_dept (department_id)
   )`,
  `CREATE TABLE IF NOT EXISTS training_enrollments (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     assignment_id BIGINT NOT NULL,
     course_id BIGINT NOT NULL,
     user_id BIGINT NOT NULL,
     started_at DATETIME NULL,
     completed_at DATETIME NULL,
     notes TEXT NULL,
     reminded_3_at DATETIME NULL,
     reminded_1_at DATETIME NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY uq_training_enrollment (assignment_id, user_id),
     KEY idx_training_enrollments_user (user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS training_material_progress (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     enrollment_id BIGINT NOT NULL,
     material_id BIGINT NOT NULL,
     opened_at DATETIME NULL,
     completed_at DATETIME NULL,
     UNIQUE KEY uq_training_progress (enrollment_id, material_id)
   )`,
];

const PAGES = [['/trainings', 'My Training'], ['/hrd/training', 'Training Courses']];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const sql of TABLES) {
    await pool.query(sql);
    console.log(`  table ${sql.match(/EXISTS (\w+)/)[1]} ready`);
  }
  for (const [col, def] of [['training_assignment_id', 'BIGINT NULL'], ['training_course_quiz_id', 'BIGINT NULL']]) {
    const [c] = await pool.query('SHOW COLUMNS FROM exam_schedules LIKE ?', [col]);
    if (c.length) console.log(`  exam_schedules.${col} already there -- skipped`);
    else { await pool.query(`ALTER TABLE exam_schedules ADD COLUMN ${col} ${def}, ADD INDEX idx_exam_schedules_${col} (${col})`); console.log(`  added exam_schedules.${col}`); }
  }

  // Pre-Test / Post-Test (2026-10-21): what each course quiz is -- pre_test, quiz or post_test.
  const [kc] = await pool.query("SHOW COLUMNS FROM training_course_quizzes LIKE 'kind'");
  if (kc.length) console.log('  training_course_quizzes.kind already there -- skipped');
  else { await pool.query("ALTER TABLE training_course_quizzes ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'quiz'"); console.log('  added training_course_quizzes.kind'); }

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

  // My Training: everyone, and every account-type template so a later user has it too.
  const [users] = await pool.query('SELECT id FROM users');
  let n = 0;
  for (const u of users) n += await grant(u.id, ids['/trainings'], ['can_view']);
  console.log(`  My Training: view granted to ${n} more user(s)`);
  const [types] = await pool.query('SELECT DISTINCT account_type FROM account_type_permissions');
  for (const t of types) {
    const [[row]] = await pool.query('SELECT 1 AS x FROM account_type_permissions WHERE account_type = ? AND page_id = ?', [t.account_type, ids['/trainings']]);
    if (!row) await pool.query('INSERT INTO account_type_permissions (account_type, page_id, can_view, updated_at) VALUES (?, ?, TRUE, NOW())', [t.account_type, ids['/trainings']]);
  }
  // Training Courses: whoever runs Examinations runs Training too; System Admins get everything.
  const [hr] = await pool.query(
    `SELECT p.user_id, p.can_view, p.can_add, p.can_edit, p.can_delete FROM user_page_permissions p JOIN pages pg ON pg.id = p.page_id
      WHERE pg.route = '/hrd/exams' AND p.can_view = 1`);
  for (const h of hr) {
    const rights = ['can_view', ...['can_add', 'can_edit', 'can_delete'].filter((f) => Number(h[f]))];
    await grant(h.user_id, ids['/hrd/training'], rights);
  }
  console.log(`  Training Courses: carried over to ${hr.length} Examinations user(s)`);
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const a of admins) for (const [route] of PAGES) await grant(a.id, ids[route], flags);
  console.log(`  ${admins.length} System Admin(s) given every right on the training pages`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
