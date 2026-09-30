// Department budgets -- the accounting manager's workbook format (2025 Admin Expenses / Selling
// Expenses / COGS vs Budget), alongside the per-account budgets from create-budgets.js.
//
//   budgets.kind            'account' (per-account grid) or 'department' (this format)
//   budgets.sales_target    the monthly sales figure the budget is sized against ("Budget @ 8.5M
//                           Sales"); a row's % of sales x this = its monthly budget
//   budget_rows             one per department row (Admin / Selling) plus the COGS row. Keyed by
//                           the SOURCE system's department name, because actuals up to the
//                           cut-over come from the source's department income statement and two
//                           of the workbook's departments (Quality Assurance, E-Commerce) do not
//                           exist in T1S; department_id is the T1S department where there is one.
//   budget_row_amounts      the budget per row per month
//   source_dept_actuals     the source's monthly Operating Expenses / Other Expenses / Cost of
//                           Goods Sold per department, loaded by load-source-dept-actuals.js
//
// Needs create-budgets.js first. IDEMPOTENT. Droplet and office replicate: run on ONE. Railway:
// its own run.
//
//   node src/db/create-department-budgets.js
const pool = require('../db');

async function has(sql, params) { const [[r]] = await pool.query(sql, params); return r.n > 0; }
const tableExists = (t) => has('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]);
const columnExists = (t, c) => has('SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [t, c]);

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (!(await tableExists('budgets'))) throw new Error('Run create-budgets.js first.');

  if (!(await columnExists('budgets', 'kind'))) {
    await pool.query("ALTER TABLE budgets ADD COLUMN kind ENUM('account','department') NOT NULL DEFAULT 'account', ALGORITHM=INSTANT");
    console.log('  budgets.kind added.');
  }
  if (!(await columnExists('budgets', 'sales_target'))) {
    await pool.query('ALTER TABLE budgets ADD COLUMN sales_target DECIMAL(16,2) NULL, ALGORITHM=INSTANT');
    console.log('  budgets.sales_target added.');
  }
  if (!(await tableExists('budget_rows'))) {
    await pool.query(`
      CREATE TABLE budget_rows (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        budget_id BIGINT NOT NULL,
        grp ENUM('admin','selling','cogs') NOT NULL,
        label VARCHAR(100) NOT NULL,
        source_department VARCHAR(100) NULL,
        department_id BIGINT NULL,
        sort INT NOT NULL DEFAULT 0,
        pct DECIMAL(9,4) NULL,
        remarks VARCHAR(500) NULL,
        KEY idx_budget_rows_budget (budget_id),
        CONSTRAINT fk_budget_rows_budget FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE
      )`);
    console.log('  budget_rows: created.');
  }
  if (!(await tableExists('budget_row_amounts'))) {
    await pool.query(`
      CREATE TABLE budget_row_amounts (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        row_id BIGINT NOT NULL,
        month TINYINT NOT NULL,
        amount DECIMAL(16,2) NOT NULL DEFAULT 0,
        UNIQUE KEY uq_budget_row_month (row_id, month),
        CONSTRAINT fk_budget_row_amounts_row FOREIGN KEY (row_id) REFERENCES budget_rows(id) ON DELETE CASCADE
      )`);
    console.log('  budget_row_amounts: created.');
  }
  if (!(await tableExists('source_dept_actuals'))) {
    await pool.query(`
      CREATE TABLE source_dept_actuals (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        year SMALLINT NOT NULL,
        month TINYINT NOT NULL,
        source_department VARCHAR(100) NOT NULL,
        section ENUM('opex','other_expense','cogs') NOT NULL,
        amount DECIMAL(16,2) NOT NULL,
        loaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_source_dept_actual (year, month, source_department, section)
      )`);
    console.log('  source_dept_actuals: created.');
  }
  console.log('Done.');
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
