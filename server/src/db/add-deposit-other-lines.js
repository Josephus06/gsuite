// Adds Other Deposit and Cash Back lines to Bank Deposits (BD-####).
//
// A deposit used to be nothing but the customer payments swept into it. The slip that goes to the
// bank rarely is: money arrives that no customer payment explains (a refund, a sale of scrap, a
// staff reimbursement) and gets deposited alongside, and part of the cash is sometimes kept back
// (petty cash, change fund) rather than banked. Those are the two line kinds:
//
//   other     Other Deposit -- ADDED to the deposit total.     CR its account.
//   cashback  Cash Back     -- DEDUCTED from the deposit total. DR its account.
//
// total_amount on bank_deposits stays the NET figure (payments + other - cash back), because that
// is what reaches the bank and what lib/bankLedger.js reconciles against the statement. The
// payments share is never stored: GL Impact credits Undeposited Funds with whatever the lines do
// not explain (total - other + cash back), which for every deposit that predates this -- and every
// one imported from live, whose payments were never linked -- is the whole total, as before.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-deposit-other-lines.js --dry-run
//   node src/db/add-deposit-other-lines.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const [tbl] = await pool.query("SHOW TABLES LIKE 'bank_deposit_lines'");
  if (tbl.length) console.log('Table bank_deposit_lines already exists.');
  else if (DRY_RUN) console.log('Would create table bank_deposit_lines.');
  else {
    await pool.query(`
CREATE TABLE bank_deposit_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    deposit_id BIGINT NOT NULL,
    line_type VARCHAR(20) NOT NULL,
    line_no INT NOT NULL,
    party_type VARCHAR(20) NULL,
    party_id BIGINT NULL,
    party_name VARCHAR(255) NULL,
    amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    account_id BIGINT NOT NULL,
    payment_method_id BIGINT NULL,
    department_id BIGINT NULL,
    location_id BIGINT NULL,
    memo VARCHAR(1000) NULL,
    INDEX idx_bdl_deposit (deposit_id)
)`);
    console.log('Created table bank_deposit_lines.');
  }
  await pool.end();
}

main().catch(async (err) => { console.error('Migration failed:', err.message); await pool.end(); process.exit(1); });
