// HRD > Performance Evaluation (asked 2026-10-23; the SYSTEM ANALYST - PEF workbook). A quarterly
// evaluation per employee, built from a TEMPLATE for their position:
//
//   A. Productivity & Efficiency (70%) -- the position's Key Result Areas, each with its weight, KPI
//      (target), timeframe, actual results, self rating and superior's rating;
//   B. Core Values (30%) -- the company's, the same for everyone;
//   ratings 1-4 (Fail / Needs improvement / Meets requirements / Excellent), value points = rating x
//   weight, overall = A x 70% + B x 30%; Part 2 the development plan; Part 3 the discussion and sign-offs.
//
// During the quarter the employee AND their supervisor log dated REMARKS against a KRA or core value
// (both see them); when the quarter closes they pre-fill Actual Results / Critical Incidents. Then:
// self rating -> supervisor's rating -> discussion + employee conforme -> department head review ->
// HR review -> GM approval.
//
//   perf_templates / perf_template_kras   a position's KRAs (weights add to 100%)
//   perf_core_values                      the company's core values (seeded from the PEF)
//   perf_settings                         section weights and the rating scale
//   perf_cycles                           one per quarter
//   perf_evaluations / perf_evaluation_items   one per employee per cycle; its KRAs and core values
//                                         copied from the template when made (later edits never
//                                         rewrite a past evaluation)
//   perf_remarks                          the dated remarks logged during the quarter
//
//   pages  /performance       "My Performance"          everyone (own evaluations; a supervisor's
//                                                         team and a department head's reviews too)
//          /hrd/performance   "Performance Evaluation"  HR: templates, core values, cycles, review;
//                                                         Approve = the GM's approval
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/create-performance-module.js
require('dotenv').config();
const pool = require('../db');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS perf_templates (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     position_title VARCHAR(150) NOT NULL,
     department_id BIGINT NULL,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS perf_template_kras (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     template_id BIGINT NOT NULL,
     sort_order INT NOT NULL DEFAULT 0,
     kra VARCHAR(500) NOT NULL,
     weight DECIMAL(6,2) NOT NULL,
     kpi VARCHAR(500) NULL,
     timeframe VARCHAR(100) NULL,
     KEY idx_perf_kras_template (template_id)
   )`,
  `CREATE TABLE IF NOT EXISTS perf_core_values (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(100) NOT NULL,
     description TEXT NULL,
     weight DECIMAL(6,2) NOT NULL,
     sort_order INT NOT NULL DEFAULT 0,
     is_active TINYINT(1) NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS perf_cycles (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     year INT NOT NULL,
     quarter TINYINT NOT NULL,
     start_date DATE NOT NULL,
     end_date DATE NOT NULL,
     status VARCHAR(15) NOT NULL DEFAULT 'open',
     closed_at DATETIME NULL,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY uq_perf_cycle (year, quarter)
   )`,
  `CREATE TABLE IF NOT EXISTS perf_evaluations (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     cycle_id BIGINT NOT NULL,
     user_id BIGINT NOT NULL,
     employee_id BIGINT NULL,
     template_id BIGINT NULL,
     position_title VARCHAR(150) NULL,
     department_id BIGINT NULL,
     rater_user_id BIGINT NULL,
     dept_head_user_id BIGINT NULL,
     kra_weight DECIMAL(5,2) NOT NULL DEFAULT 70,
     cv_weight DECIMAL(5,2) NOT NULL DEFAULT 30,
     status VARCHAR(20) NOT NULL DEFAULT 'open',
     self_kra DECIMAL(6,3) NULL, self_cv DECIMAL(6,3) NULL, self_overall DECIMAL(6,3) NULL,
     sup_kra DECIMAL(6,3) NULL, sup_cv DECIMAL(6,3) NULL, sup_overall DECIMAL(6,3) NULL,
     superior_comments TEXT NULL,
     strengths TEXT NULL, improvements TEXT NULL, coaching TEXT NULL, career_plans TEXT NULL,
     self_submitted_at DATETIME NULL,
     rated_at DATETIME NULL,
     discussion_date DATE NULL,
     employee_conforme_at DATETIME NULL,
     dept_head_by_user_id BIGINT NULL, dept_head_at DATETIME NULL, dept_head_remarks VARCHAR(1000) NULL,
     hr_by_user_id BIGINT NULL, hr_at DATETIME NULL, hr_remarks VARCHAR(1000) NULL,
     gm_by_user_id BIGINT NULL, gm_at DATETIME NULL, gm_remarks VARCHAR(1000) NULL,
     returned_reason VARCHAR(1000) NULL,
     reminded_at DATETIME NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY uq_perf_eval (cycle_id, user_id),
     KEY idx_perf_eval_rater (rater_user_id),
     KEY idx_perf_eval_head (dept_head_user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS perf_evaluation_items (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     evaluation_id BIGINT NOT NULL,
     section VARCHAR(5) NOT NULL,
     sort_order INT NOT NULL DEFAULT 0,
     label VARCHAR(500) NOT NULL,
     description TEXT NULL,
     weight DECIMAL(6,2) NOT NULL,
     kpi VARCHAR(500) NULL,
     timeframe VARCHAR(100) NULL,
     actual_results TEXT NULL,
     self_rating TINYINT NULL,
     superior_rating TINYINT NULL,
     KEY idx_perf_items_eval (evaluation_id)
   )`,
  `CREATE TABLE IF NOT EXISTS perf_remarks (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     evaluation_id BIGINT NOT NULL,
     item_id BIGINT NULL,
     author_user_id BIGINT NOT NULL,
     author_role VARCHAR(12) NOT NULL,
     remark_date DATE NOT NULL,
     body TEXT NOT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_perf_remarks_eval (evaluation_id)
   )`,
];

// Core values as the PEF states them (B. CORE VALUES 30%).
const CORE_VALUES = [
  ['GROWTH', 'I am motivated to learn and gain experience in the field I chose. I have improved in different aspects specially on my technical skills and capabilities. My goal in life is to reach my full potential and to develop myself.', 15],
  ['FRUGALITY', 'I always make sure to maximize the use of the available resources in the most cost-efficient way.', 15],
  ['EXCELLENCE', 'As an employee, I make sure to make the best out of my abilities to contribute for a superior quality products and services offered. My goal is to contribute in the Mission of the Company.', 14],
  ['STEWARDSHIP', 'I am focused on promoting the well-being of my leaders and co-workers. I ensure that my co-workers work effectively in an healthy kind of environment where individuals can improve their sense of well-being.', 14],
  ['TEAMWORK', 'I feel that I have worked well with my team to achieve our common goals.', 14],
  ['ATTITUDE', "I am an optimistic person that focuses on the good that I can get out of the many tasks assigned to me. I consider myself a constant learner. I always allow myself to listen to other's ideas.", 14],
  ['RESPECT', "I listen to my co-worker's point of view before explaining mine. I treat my co-workers with courtesy, politeness, and respect regardless of rank, gender, religion, size and age.", 14],
];

// The two templates the PEF workbook carries.
const TEMPLATES = [
  ['SYSTEM ANALYST', [
    ['RESOLVES ERP CONCERNS AND SYSTEM ERRORS WITHIN 24 HOURS BY USERS', 40, 'NO. OF RESOLVE ISSUES OVER RAISED CONCERN (95%)'],
    ['PROVIDES ACCURATE REPORTS GENERATED FROM SYSTEM', 20, 'DATA/REPORT REQUESTED VS. DATA/REPORT PRESENTED (100%)'],
    ['FACILITATE PENDING TRANSACTIONS TO PRODUCE ACCURATE SYSTEM AND ACTUAL DATA', 10, 'NO. OF ACCOMPLISHED PENDING TRANSACTIONS VS. NO. UNRESOLVED PENDING TRANSACTIONS (100%)'],
    ['ABLE TO MATCH SYSTEM AND BRANCHES INVOICES', 25, 'NO. OF INVOICES FORWARDED VS. PENDING (100%)'],
    ['ADHERENCE TO COMPANY POLICIES AND PROCEDURES', 5, 'NO. OF NOD VS. NONE (100%)'],
  ]],
  ['ASSISTANT SYSTEM ANALYST', [
    ['RESOLVES ERP CONCERNS AND SYSTEM ERRORS WITHIN 24 HOURS BY USERS', 40, 'NO. OF RESOLVE ISSUES OVER RAISED CONCERN (95%)'],
    ['PROVIDES ACCURATE REPORTS GENERATED FROM SYSTEM', 20, 'DATA/REPORT REQUESTED VS. DATA/REPORT PRESENTED (100%)'],
    ['FACILITATE PENDING TRANSACTIONS TO PRODUCE ACCURATE SYSTEM AND ACTUAL DATA', 20, 'NO. OF ACCOMPLISHED PENDING TRANSACTIONS VS. NO. UNRESOLVED PENDING TRANSACTIONS (100%)'],
    ['RESOLVED TICKETS', 15, 'NUMBER OF TICKETS RECEIVED VS RESOLVED (95%-100%)'],
    ['ADHERENCE TO COMPANY POLICIES AND PROCEDURES', 5, 'NO. OF NOD VS. NONE (100%)'],
  ]],
];

const PAGES = [['/performance', 'My Performance'], ['/hrd/performance', 'Performance Evaluation']];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const sql of TABLES) { await pool.query(sql); console.log(`  table ${sql.match(/EXISTS (\w+)/)[1]} ready`); }

  const [[{ n: cv }]] = await pool.query('SELECT COUNT(*) AS n FROM perf_core_values');
  if (!Number(cv)) {
    for (let i = 0; i < CORE_VALUES.length; i += 1) {
      await pool.query('INSERT INTO perf_core_values (name, description, weight, sort_order) VALUES (?, ?, ?, ?)', [...CORE_VALUES[i], i]);
    }
    console.log(`  seeded ${CORE_VALUES.length} core values`);
  } else console.log('  core values already there -- skipped');

  for (const [pos, kras] of TEMPLATES) {
    const [[t]] = await pool.query('SELECT id FROM perf_templates WHERE position_title = ?', [pos]);
    if (t) { console.log(`  template ${pos} already there -- skipped`); continue; }
    const [r] = await pool.query('INSERT INTO perf_templates (position_title) VALUES (?)', [pos]);
    for (let i = 0; i < kras.length; i += 1) {
      await pool.query('INSERT INTO perf_template_kras (template_id, sort_order, kra, weight, kpi, timeframe) VALUES (?, ?, ?, ?, ?, ?)',
        [r.insertId, i, kras[i][0], kras[i][1], kras[i][2], 'Quarterly']);
    }
    console.log(`  seeded template ${pos}`);
  }

  const ids = {};
  for (const [route, name] of PAGES) {
    const [[e]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    if (e) { ids[route] = e.id; console.log(`  page ${route} already registered`); continue; }
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
  const [users] = await pool.query('SELECT id FROM users');
  let n = 0;
  for (const u of users) n += await grant(u.id, ids['/performance'], ['can_view']);
  console.log(`  My Performance: view granted to ${n} more user(s)`);
  const [types] = await pool.query('SELECT DISTINCT account_type FROM account_type_permissions');
  for (const t of types) {
    const [[row]] = await pool.query('SELECT 1 AS x FROM account_type_permissions WHERE account_type = ? AND page_id = ?', [t.account_type, ids['/performance']]);
    if (!row) await pool.query('INSERT INTO account_type_permissions (account_type, page_id, can_view, updated_at) VALUES (?, ?, TRUE, NOW())', [t.account_type, ids['/performance']]);
  }
  // The General Managers approve: Approve on Performance Evaluation.
  const [gms] = await pool.query(
    `SELECT id FROM users WHERE is_active = 1 AND (account_type = 'General Manager' OR id IN (SELECT user_id FROM general_managers))`).catch(() => [[]]);
  for (const g of gms) await grant(g.id, ids['/hrd/performance'], ['can_view', 'can_approve']);
  console.log(`  ${gms.length} General Manager(s) given View + Approve on Performance Evaluation`);
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const a of admins) for (const [route] of PAGES) await grant(a.id, ids[route], flags);
  console.log(`  ${admins.length} System Admin(s) given every right`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
