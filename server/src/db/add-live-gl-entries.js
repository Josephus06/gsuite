// Creates `live_gl_entries`, which holds live's own posted GL lines for documents whose GL this
// app cannot correctly re-derive.
//
// WHY. The trial balance was out by 241,548,772.56 and the balance sheet inherited exactly that.
// 212,383,275.57 of it is vendor bills: computeVendorBillGl posts the Accounts Payable credit
// unconditionally but the debit leg only when the bill header names an account, and 19,162 of
// 19,164 bills name none. They name none because live does not keep the expense account on the
// header -- SysFK_COA_TransH is Accounts Payable on every bill -- it keeps it on the GL line.
//
// And there is no single account to move to the header even if we wanted to: 31 of 40 sampled
// bills debit MORE than one account (Inventory Received Not Billed, Direct Labor, Raw Materials,
// Transportation Expenses, ...). Live's rule for choosing them is not visible through the API,
// and the bill lines carry no account column of their own. Re-deriving it would mean inventing
// an allocation and calling it accounting.
//
// So the entries are imported instead, the same way every other migrated figure got here. The
// table is deliberately generic -- source_type is not restricted to vendor bills -- because
// cheques (-1,714,869.70 over 95 documents), credit memos (+100,456.99 over 146) and journals
// (-21,618.41 over 6) are the same class of problem and can reuse it.
//
// Idempotent -- safe to re-run:
//   node src/db/add-live-gl-entries.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_gl_entries (
      id             BIGINT NOT NULL AUTO_INCREMENT,
      live_pk        VARCHAR(64)  NOT NULL,
      live_trans_pk  VARCHAR(64)  NOT NULL,
      source_type    VARCHAR(40)  NOT NULL,
      source_no      VARCHAR(64)  NULL,
      source_id      BIGINT       NULL,
      entry_module   VARCHAR(40)  NULL,
      account_id     BIGINT       NULL,
      account_code   VARCHAR(40)  NULL,
      account_name   VARCHAR(255) NULL,
      debit          DECIMAL(18,4) NOT NULL DEFAULT 0,
      credit         DECIMAL(18,4) NOT NULL DEFAULT 0,
      entry_date     DATE         NULL,
      location_id    BIGINT       NULL,
      department_id  BIGINT       NULL,
      memo           VARCHAR(500) NULL,
      created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_live_pk (live_pk),
      KEY idx_source (source_type, source_id),
      KEY idx_trans (live_trans_pk),
      KEY idx_date (entry_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log('live_gl_entries ready.');

  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM live_gl_entries');
  console.log(`  holds ${n.n} row(s).`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
