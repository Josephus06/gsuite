// HRD > DA Report (asked 2026-10-28). HR's monthly Discipline Management Report, on the company's
// own sheet ("DA REPORT FORMAT.xlsx"): "Discipline Management Report (OCTOBER 2026)", then a section
// per stage of the disciplinary action -- NOTICE TO EXPLAIN in the sample -- each a table of
// EMPLOYEE NAME / VIOLATION / SECTION VIOLATED / FINAL SANCTION.
//
// It is ONE form per period, filled in like the sheet (2026-10-28, second ask): the report is the
// document, its lines are rows of it. HR makes a Monthly and a Weekly one.
//   hr_da_reports  (new)  one per type and period: DA-0001, monthly | weekly, the period's first and
//                         last day (a month; a week Monday to Sunday), who made it.
//   hr_da_entries  (new)  the rows: the report they belong to, the stage (section heading), the
//                         employee (name kept as printed), violation, section violated (picked from
//                         HRD > Violation's list, or typed), final sanction, order.
//                         Rows saved before the report existed (report_id NULL) are gathered into
//                         their month's Monthly report.
//   pages /hrd/da-report "DA Report"  View; Add; Edit; Delete; Print. System Admins get every right.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-hr-da-report.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_da_reports (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_no VARCHAR(20) NOT NULL,
      report_type ENUM('monthly', 'weekly') NOT NULL DEFAULT 'monthly',
      period_from DATE NOT NULL,
      period_to DATE NOT NULL,
      remarks VARCHAR(500) NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hr_da_reports_no (report_no),
      UNIQUE KEY uq_hr_da_reports_period (report_type, period_from)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_da_entries (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_id BIGINT NULL,
      report_month DATE NOT NULL,
      stage VARCHAR(80) NOT NULL DEFAULT 'NOTICE TO EXPLAIN',
      employee_id BIGINT NULL,
      employee_name VARCHAR(150) NOT NULL,
      violation VARCHAR(300) NOT NULL,
      violation_type_id BIGINT NULL,
      section_violated VARCHAR(300) NULL,
      final_sanction VARCHAR(200) NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_hr_da_entries_report (report_id),
      KEY idx_hr_da_entries_month (report_month),
      KEY idx_hr_da_entries_employee (employee_id)
    )`);
  // A box that ran the first version has hr_da_entries without report_id.
  const [[hasCol]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'hr_da_entries' AND column_name = 'report_id'`);
  if (!hasCol.n) {
    await pool.query('ALTER TABLE hr_da_entries ADD COLUMN report_id BIGINT NULL AFTER id, ADD KEY idx_hr_da_entries_report (report_id)');
    console.log('  hr_da_entries.report_id added');
  }
  console.log('  hr_da_reports, hr_da_entries ready');

  // Loose rows -> their month's report.
  const [loose] = await pool.query(
    'SELECT report_month, MIN(created_by_user_id) AS by_user, COUNT(*) AS n FROM hr_da_entries WHERE report_id IS NULL GROUP BY report_month');
  for (const m of loose) {
    let [[rep]] = await pool.query("SELECT id FROM hr_da_reports WHERE report_type = 'monthly' AND period_from = ?", [m.report_month]);
    if (!rep) {
      const [[mx]] = await pool.query("SELECT MAX(CAST(SUBSTRING(report_no, 4) AS UNSIGNED)) AS n FROM hr_da_reports WHERE report_no LIKE 'DA-%'");
      const no = `DA-${String((Number(mx.n) || 0) + 1).padStart(4, '0')}`;
      const [r] = await pool.query(
        "INSERT INTO hr_da_reports (report_no, report_type, period_from, period_to, created_by_user_id) VALUES (?, 'monthly', ?, LAST_DAY(?), ?)",
        [no, m.report_month, m.report_month, m.by_user]);
      rep = { id: r.insertId };
    }
    await pool.query('UPDATE hr_da_entries SET report_id = ? WHERE report_id IS NULL AND report_month = ?', [rep.id, m.report_month]);
    console.log(`  ${m.n} earlier line(s) gathered into the Monthly report for ${String(m.report_month).slice(0, 7)}`);
  }

  const ROUTE = '/hrd/da-report';
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [ROUTE, 'DA Report']);
    pageId = r.insertId;
    console.log(`  registered ${ROUTE} (id ${pageId})`);
  } else console.log(`  page ${ROUTE} already registered (id ${pageId})`);
  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const a of admins) {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [a.id, pageId]);
    if (p) await pool.query(`UPDATE user_page_permissions SET ${flags.map((f) => `${f} = TRUE`).join(', ')} WHERE id = ?`, [p.id]);
    else await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')}) VALUES (?, ?, ${flags.map(() => 'TRUE').join(', ')})`, [a.id, pageId]);
  }
  console.log(`  ${admins.length} System Admin(s) given every right on DA Report`);
  console.log('  HR staff: grant View/Add/Edit/Print on "DA Report" in User Permissions.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
