// Three fields the Credit Memo module needs before live's data can be represented faithfully.
//
// credit_memos.source_account_id
//   The account a credit memo DEBITS. computeCreditMemoGl assumed 30100 (Sales), which is
//   right for a sales return but wrong for the rest: CM-5290 debits 14200 Creditable
//   Withholding Tax, because the customer withheld tax rather than returned goods. Live
//   carries the real account on the GENENTRY row, so it is captured at import instead of
//   guessed from rules.
//
// credit_memos.sales_rep_id
//   Live shows a Sales Rep on the header (Name_Empl). There was nowhere to put it.
//
// credit_memo_applications.original_amount_due
//   Live's Apply tab shows Original Amount Due alongside Applied Amount -- what the invoice
//   still owed at the moment the credit was applied (AmountDue_LdgrTr). Without it the tab
//   cannot show how an invoice went to zero.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-credit-memo-import-fields.js
const pool = require('../db');
require('dotenv').config();

async function hasColumn(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

async function addColumn(table, column, ddl) {
  if (await hasColumn(table, column)) {
    console.log(`  ${table}.${column} already exists -- skipped.`);
    return;
  }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`  ${table}.${column} added.`);
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await addColumn('credit_memos', 'source_account_id', 'source_account_id BIGINT NULL AFTER ar_account_id');
  await addColumn('credit_memos', 'sales_rep_id', 'sales_rep_id BIGINT NULL AFTER customer_id');
  await addColumn('credit_memo_applications', 'original_amount_due', 'original_amount_due DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER applied_amount');

  // sales_invoice_id was NOT NULL, which only holds for memos raised FROM an invoice inside
  // this app. Live's credit memos apply to several invoices at once (CM-5290 covers three, so
  // no single one is "the" invoice) and 189 of 5,301 apply to none at all. The Apply tab and
  // credit_memo_applications carry the real relationship; this column is a convenience link,
  // so it has to be optional or those memos cannot be stored at all.
  // Aliased lowercase deliberately: information_schema returns IS_NULLABLE in caps, so
  // reading col.is_nullable is always undefined and the guard silently skips the ALTER
  // while reporting the column already nullable.
  const [[col]] = await pool.query(
    `SELECT is_nullable AS nullable FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'credit_memos' AND column_name = 'sales_invoice_id'`
  );
  if (col && col.nullable === 'NO') {
    await pool.query('ALTER TABLE credit_memos MODIFY sales_invoice_id BIGINT NULL');
    console.log('  credit_memos.sales_invoice_id relaxed to NULL.');
  } else {
    console.log('  credit_memos.sales_invoice_id already nullable -- skipped.');
  }

  // An application whose invoice we do not hold still happened. CM-5290 applies to three
  // invoices and we hold two; dropping the third made the Apply tab disagree with live AND
  // left GL Impact unbalanced (DR 17,720.96 vs CR 4,507.89). Keep the row, remember the
  // invoice number live gave it, and leave sales_invoice_id null so nothing pretends to link.
  await addColumn('credit_memo_applications', 'invoice_no', 'invoice_no VARCHAR(40) NULL AFTER sales_invoice_id');
  const [[appCol]] = await pool.query(
    `SELECT is_nullable AS nullable FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'credit_memo_applications' AND column_name = 'sales_invoice_id'`
  );
  if (appCol && appCol.nullable === 'NO') {
    await pool.query('ALTER TABLE credit_memo_applications MODIFY sales_invoice_id BIGINT NULL');
    console.log('  credit_memo_applications.sales_invoice_id relaxed to NULL.');
  } else {
    console.log('  credit_memo_applications.sales_invoice_id already nullable -- skipped.');
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
