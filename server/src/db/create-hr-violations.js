// HRD > Violation and Incident Report.
//
// The flow the HR team described: a supervisor searches for an employee, picks the violation from
// the company's own list, and saves. That charge immediately raises an Incident Report, which is
// the document HR evaluates. One action by the person who witnessed it, one queue for the people
// who decide what happens next.
//
// Three tables:
//   hr_violation_types    the lookup -- every violation an employee may be charged with
//   hr_violations         one employee charged with one violation on one date
//   hr_incident_reports   raised automatically by the charge, carrying HR's evaluation
//
// THE LOOKUP IS SEEDED EMPTY, deliberately. A company's list of offences is its code of conduct,
// usually an annexe to the employee handbook and referenced in disciplinary paperwork. Inventing
// plausible-sounding entries would let somebody be charged under a rule the company never adopted,
// which is exactly the kind of error that surfaces at a labour hearing. HR fills it in.
//
// The charge keeps its own copy of the employee's name, code and department, and of the violation's
// name, category and severity. Disciplinary records are read years later: an employee changing
// department, or HR rewording an offence, must not silently rewrite what somebody was charged with.
// Same reasoning as the itinerary stops.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/create-hr-violations.js
const pool = require('../db');

const PAGES = [
  // Two pages, not one. Raising a charge and evaluating it are different jobs done by different
  // people -- a supervisor reports what they saw; HR decides what it means. Granting them
  // separately is the whole point.
  { route: '/hrd/violations', name: 'HR Violations' },
  { route: '/hrd/incident-reports', name: 'Incident Reports' },
];

async function tableExists(name) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [name],
  );
  return r.n > 0;
}

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function createTable(name, ddl) {
  if (await tableExists(name)) {
    console.log(`  Table ${name} already exists.`);
    return;
  }
  await pool.query(ddl);
  console.log(`  Created table ${name}.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  await createTable('hr_violation_types', `
    CREATE TABLE hr_violation_types (
      id BIGINT NOT NULL AUTO_INCREMENT,
      code VARCHAR(30) NULL,
      name VARCHAR(150) NOT NULL,
      category VARCHAR(60) NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'minor',
      description VARCHAR(1000) NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hr_violation_types_name (name),
      KEY idx_hr_violation_types_active (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await createTable('hr_violations', `
    CREATE TABLE hr_violations (
      id BIGINT NOT NULL AUTO_INCREMENT,
      violation_no VARCHAR(30) NOT NULL DEFAULT '',
      employee_id BIGINT NOT NULL,
      violation_type_id BIGINT NULL,
      employee_name VARCHAR(200) NULL,
      employee_code VARCHAR(60) NULL,
      department_name VARCHAR(150) NULL,
      position_title VARCHAR(150) NULL,
      violation_name VARCHAR(150) NULL,
      violation_category VARCHAR(60) NULL,
      violation_severity VARCHAR(20) NULL,
      violation_date DATE NOT NULL,
      place VARCHAR(200) NULL,
      details VARCHAR(4000) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'filed',
      reported_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY idx_hr_violations_employee (employee_id, violation_date),
      KEY idx_hr_violations_type (violation_type_id),
      KEY idx_hr_violations_date (violation_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // One report per charge. The UNIQUE key is what makes "saving a violation generates an incident
  // report" a guarantee rather than a hope -- a retried save cannot raise a second report against
  // the same charge, which would put the same employee in HR's queue twice for one act.
  await createTable('hr_incident_reports', `
    CREATE TABLE hr_incident_reports (
      id BIGINT NOT NULL AUTO_INCREMENT,
      incident_no VARCHAR(30) NOT NULL DEFAULT '',
      violation_id BIGINT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'for_evaluation',
      hr_findings VARCHAR(4000) NULL,
      recommendation VARCHAR(60) NULL,
      recommendation_notes VARCHAR(1000) NULL,
      evaluated_by_user_id BIGINT NULL,
      evaluated_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hr_incident_reports_violation (violation_id),
      KEY idx_hr_incident_reports_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  console.log('');
  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');
  const cols = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print']
    .concat(hasViewAll ? ['can_view_all'] : []);

  for (const pg of PAGES) {
    const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [pg.route]);
    let pageId = existing?.id;
    if (pageId) {
      console.log(`Page ${pg.route}: already registered (id ${pageId}).`);
    } else {
      const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [pg.route, pg.name]);
      pageId = r.insertId;
      console.log(`Page ${pg.route}: registered (id ${pageId}).`);
    }

    await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
       SELECT u.id, ?, ${cols.map(() => 'TRUE').join(', ')} FROM users u
        WHERE u.account_type = 'System Admin'
          AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e
                           WHERE e.user_id = u.id)`,
      [pageId, pageId],
    );
    await pool.query(
      `UPDATE user_page_permissions upp JOIN users u ON u.id = upp.user_id
          SET ${cols.map((c) => `upp.${c} = TRUE`).join(', ')}
        WHERE u.account_type = 'System Admin' AND upp.page_id = ?`, [pageId],
    );
    const [[atp]] = await pool.query(
      "SELECT COUNT(*) AS n FROM account_type_permissions WHERE account_type = 'System Admin' AND page_id = ?",
      [pageId],
    );
    if (!atp.n) {
      await pool.query(
        `INSERT INTO account_type_permissions (account_type, page_id, ${cols.join(', ')})
         VALUES ('System Admin', ?, ${cols.map(() => 'TRUE').join(', ')})`, [pageId],
      );
    }
  }
  console.log('  System Admin granted in full on both.');

  const [[emp]] = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE is_active = 1');
  const [[types]] = await pool.query('SELECT COUNT(*) AS n FROM hr_violation_types');
  console.log(`\n${emp.n} active employees can be charged.`);
  console.log(`${types.n} violations defined -- the lookup starts EMPTY on purpose.`);
  console.log('HR must enter the company code of conduct from Manage Violations before anyone');
  console.log('can be charged; nothing here invents an offence the company has not adopted.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
