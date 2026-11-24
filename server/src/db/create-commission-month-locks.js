// One-off migration (2026-11-24): commission_month_locks -- a rep's month whose Commission figures
// were handed over for release, kept as they were instead of recomputed from live invoices (see
// lib/commissionReport.js applyMonthLock). Filled by src/db/lock-commission-from-file.js.
//
//   node src/db/create-commission-month-locks.js [--dry-run]
//
// The droplet, office and SM boxes replicate: run on ONE box (the droplet). Railway: run it there too.
// Until it runs, the Commission report simply finds nothing locked.
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const DDL = `CREATE TABLE IF NOT EXISTS commission_month_locks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  year SMALLINT NOT NULL,
  month TINYINT NOT NULL,
  weighted_sales DECIMAL(15,2) NOT NULL DEFAULT 0,
  performance_pct DECIMAL(8,2) NOT NULL DEFAULT 0,
  estimated_commission DECIMAL(15,2) NOT NULL DEFAULT 0,
  passing_gp_total DECIMAL(15,2) NOT NULL DEFAULT 0,
  expected_commission DECIMAL(15,2) NOT NULL DEFAULT 0,
  confirmed_commission DECIMAL(15,2) NOT NULL DEFAULT 0,
  live_confirmed_at_lock DECIMAL(15,2) NULL,
  source VARCHAR(255) NULL,
  locked_by_user_id INT NULL,
  locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cml_emp_month (employee_id, year, month),
  KEY idx_cml_year (year)
)`;

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [[exists]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'commission_month_locks'");
  if (Number(exists.n)) { console.log('  = commission_month_locks already exists'); return; }
  if (DRY_RUN) { console.log('  ~ would create commission_month_locks'); return; }
  await pool.query(DDL);
  console.log('  + created commission_month_locks');
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
