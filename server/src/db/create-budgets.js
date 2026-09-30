// Budgets and the Budget vs Actual report.
//
// A budget is one fiscal year (January-December), set for the whole company, one department or
// one location, covering the P&L accounts and optionally Fixed Assets (capital spending). It is
// entered per posting account per month. Draft -> Approved: only an approved budget is what the
// report compares against by default, and approving a newer version of the same year / dimension
// supersedes the old one, so there is never more than one live figure for a thing.
//
// Pages: /budgets (view, add, edit, delete a draft, APPROVE) and /reports/budget-vs-actual (view).
// Seeded to System Admin everywhere and to the General Manager -- who approves budgets -- by
// account type and on that user's own rows. Nobody else is granted anything; hand it out from
// Users & Permissions.
//
// IDEMPOTENT: tables are created only if missing; grants are only inserted where no row exists.
// Droplet and office replicate: run on ONE of them. Railway: its own run.
//
//   node src/db/create-budgets.js
const pool = require('../db');

async function tableExists(name) {
  const [[r]] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]);
  return r.n > 0;
}

const PAGES = [
  // route, name, rights for System Admin / General Manager
  ['/budgets', 'Budgets', { can_view: 1, can_add: 1, can_edit: 1, can_delete: 1, can_approve: 1 }],
  ['/reports/budget-vs-actual', 'Budget vs Actual', { can_view: 1 }],
];

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  if (!(await tableExists('budgets'))) {
    await pool.query(`
      CREATE TABLE budgets (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(150) NOT NULL,
        fiscal_year SMALLINT NOT NULL,
        dimension ENUM('company','department','location') NOT NULL DEFAULT 'company',
        department_id BIGINT NULL,
        location_id BIGINT NULL,
        scope ENUM('pl','pl_capex') NOT NULL DEFAULT 'pl',
        status ENUM('draft','approved','superseded') NOT NULL DEFAULT 'draft',
        version INT NOT NULL DEFAULT 1,
        notes VARCHAR(1000) NULL,
        created_by_user_id BIGINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL,
        approved_by_user_id BIGINT NULL,
        approved_at DATETIME NULL,
        KEY idx_budgets_year (fiscal_year, dimension, department_id, location_id, status)
      )`);
    console.log('  budgets: created.');
  } else console.log('  budgets: exists.');

  if (!(await tableExists('budget_lines'))) {
    await pool.query(`
      CREATE TABLE budget_lines (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        budget_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        month TINYINT NOT NULL,
        amount DECIMAL(16,2) NOT NULL DEFAULT 0,
        UNIQUE KEY uq_budget_line (budget_id, account_id, month),
        CONSTRAINT fk_budget_lines_budget FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE
      )`);
    console.log('  budget_lines: created.');
  } else console.log('  budget_lines: exists.');

  for (const [route, name, rights] of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    if (!page) {
      const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [route, name]);
      page = { id: r.insertId };
      console.log(`  page ${route}: registered (id ${page.id}).`);
    } else console.log(`  page ${route}: exists (id ${page.id}).`);

    const cols = Object.keys(rights);
    const vals = cols.map((c) => rights[c]);
    for (const accountType of ['System Admin', 'General Manager']) {
      const [a] = await pool.query(
        `INSERT INTO account_type_permissions (account_type, page_id, ${cols.join(', ')}, updated_at)
         SELECT ?, ?, ${cols.map(() => '?').join(', ')}, NOW() FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM account_type_permissions WHERE account_type = ? AND page_id = ?)`,
        [accountType, page.id, ...vals, accountType, page.id]);
      const [u] = await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
         SELECT u.id, ?, ${cols.map(() => '?').join(', ')} FROM users u
          WHERE u.account_type = ?
            AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = u.id AND x.page_id = ?)`,
        [page.id, ...vals, accountType, page.id]);
      console.log(`    ${accountType}: ${a.affectedRows} template row, ${u.affectedRows} user row(s).`);
    }
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
