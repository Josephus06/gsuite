// source_loc_account_actuals -- the source system's income statement BY LOCATION, per account per
// month, up to the cut-over. The Income Statement's Location breakdown splits the source's month
// lines by it (lib/openingBalances.js splitSourceLines), as the Department breakdown is split by
// source_dept_account_actuals. Loaded by load-source-dept-actuals.js --by=location.
//
// IDEMPOTENT. Droplet and office replicate: run on ONE. Railway: its own run.
//
//   node src/db/create-source-loc-actuals.js
//   node src/db/create-source-loc-actuals.js --down      drops the table
const pool = require('../db');

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (process.argv.includes('--down')) {
    await pool.query('DROP TABLE IF EXISTS source_loc_account_actuals');
    console.log('  source_loc_account_actuals: dropped.');
  } else {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS source_loc_account_actuals (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        year SMALLINT NOT NULL,
        month TINYINT NOT NULL,
        source_location VARCHAR(100) NOT NULL,
        section ENUM('opex','other_expense','cogs','revenue','other_income') NOT NULL,
        account_code VARCHAR(30) NOT NULL,
        amount DECIMAL(16,2) NOT NULL,
        UNIQUE KEY uq_source_loc_account_actual (year, month, source_location, section, account_code)
      )`);
    console.log('  source_loc_account_actuals: ready.');
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
