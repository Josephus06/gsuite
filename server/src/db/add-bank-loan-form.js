// Forms > Request to Apply for a Bank Loan (asked 2026-11-10), after "Authority to Apply for Bank
// Loan (on Letterhead).docx":
//
//   Amount of Loan to be applied (in PhP) / Need by Date / Purpose / Borrower / Bank / Doc Stamp /
//   Advance Interest / Net Proceeds / Instruction for Net Proceeds / Term of Payment / JRNL Entry No. /
//   PN # / Notice to the bank via Email/Viber / Remarks -- Approved by: the General Manager.
//
// Routed like every form since 2026-10-22: the requestor picks the Noter (optional) and the Approver
// (the General Manager by default).
//
//   form_bank_loan_details  (new)  one row per form
//
// form_requests.type is a VARCHAR, so the new type needs no change there.
//
//   node src/db/add-bank-loan-form.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[t]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_bank_loan_details'");
  if (Number(t.n)) console.log('  form_bank_loan_details already there -- skipped');
  else {
    // The parent's id type decides the foreign key's, so it is read rather than assumed.
    const [[col]] = await pool.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_requests' AND COLUMN_NAME = 'id'");
    await pool.query(`CREATE TABLE form_bank_loan_details (
      form_request_id ${col.t} NOT NULL PRIMARY KEY,
      loan_amount DECIMAL(15,2) NOT NULL,
      need_by_date DATE NULL,
      purpose VARCHAR(500) NOT NULL,
      borrower VARCHAR(150) NULL,
      bank VARCHAR(150) NOT NULL,
      doc_stamp DECIMAL(15,2) NULL,
      advance_interest DECIMAL(15,2) NULL,
      net_proceeds DECIMAL(15,2) NULL,
      proceeds_instruction VARCHAR(500) NULL,
      term_of_payment VARCHAR(255) NULL,
      journal_entry_no VARCHAR(60) NULL,
      pn_no VARCHAR(60) NULL,
      bank_notice VARCHAR(255) NULL,
      remarks VARCHAR(1000) NULL,
      CONSTRAINT fk_fbld_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_bank_loan_details');
  }
  // Confirm (asked 2026-11-10): an approved loan request stays open for the details the bank sends
  // once the loan is credited (doc stamp, interest, net proceeds, PN #, journal entry...) until
  // someone confirms it; then it is final.
  for (const [c, def] of [['confirmed_at', 'DATETIME NULL'], ['confirmed_by_user_id', 'BIGINT NULL']]) {
    const [[has]] = await pool.query(
      "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_bank_loan_details' AND COLUMN_NAME = ?", [c]);
    if (Number(has.n)) console.log(`  form_bank_loan_details.${c} already there -- skipped`);
    else { await pool.query(`ALTER TABLE form_bank_loan_details ADD COLUMN ${c} ${def}`); console.log(`  added form_bank_loan_details.${c}`); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
