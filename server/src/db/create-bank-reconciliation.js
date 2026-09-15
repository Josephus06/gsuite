// Bank Reconciliation.
//
// The shape of the job: import the bank's statement, let the system match each statement line to
// the document that produced it, have somebody CONFIRM those matches are right, and only then --
// when every line is accounted for and the difference is zero -- mark the period reconciled.
//
// WHY THE BOOK SIDE IS NOT THE GENERAL LEDGER. Measured before building: of 15,612 cheques only
// 710 carry a journal entry, and bank deposits and bill payments carry none at all (0 of 22,090
// and 0 of 868). Reconciling against journal_lines would put a full bank statement against an
// almost empty book. The book side is therefore built from the SOURCE DOCUMENTS, which do have
// complete bank-tagged data -- see lib/bankLedger.js, which unions the three of them the way
// lib/stockLedger.js already does for inventory.
//
// THREE TABLES:
//
//   bank_reconciliations        one statement period for one bank account
//   bank_statement_lines        the imported statement, one row per line on it
//   bank_reconciliation_matches what a statement line was matched to, and whether a person has
//                               confirmed that match
//
// THE INTEGRITY RULE THE WHOLE FEATURE RESTS ON: a book movement can be cleared ONCE. The unique
// key on (source_kind, source_id) in bank_reconciliation_matches is what enforces it -- without
// it the same cheque could be ticked off on two different statements and both would balance.
//
// A statement line is NOT always a document. Bank charges, interest credited, and debit memos
// exist only at the bank; those are marked as bank-only items with an account to post them to,
// rather than forced into a match that does not exist.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/create-bank-reconciliation.js
const pool = require('../db');

const PAGES = [
  //   can_view     see reconciliations and open one
  //   can_add      start one and import a statement
  //   can_edit     confirm and reject matches, mark bank-only items
  //   can_approve  FINISH a reconciliation, and reopen a finished one
  //   can_print    the reconciliation statement and its Excel export
  { route: '/accounting/bank-reconciliation', name: 'Bank Reconciliation' },
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

  // opening_balance is TYPED, not derived. Deriving it from everything before the statement date
  // would silently absorb any historic error into the first reconciliation and call it correct;
  // typing the figure off the statement makes the starting point something a person asserted.
  //
  // Collation pinned to match the rest of the schema -- the form_ tables were created without it
  // and could not be joined to departments until they were converted.
  await createTable('bank_reconciliations', `
    CREATE TABLE bank_reconciliations (
      id BIGINT NOT NULL AUTO_INCREMENT,
      recon_no VARCHAR(30) NOT NULL,
      account_id BIGINT NOT NULL,
      statement_date DATE NOT NULL,
      opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      statement_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      statement_file_name VARCHAR(255) NULL,
      imported_at DATETIME NULL,
      reconciled_at DATETIME NULL,
      reconciled_by_user_id BIGINT NULL,
      reopened_at DATETIME NULL,
      reopened_by_user_id BIGINT NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_recon_no (recon_no),
      KEY idx_bank_recon_account (account_id, statement_date),
      KEY idx_bank_recon_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // One row per line on the imported statement, kept verbatim.
  //
  // amount is SIGNED -- positive is money into the account, negative is money out -- because a
  // statement that gives debit and credit in separate columns and one that gives a single signed
  // column have to end up meaning the same thing before anything tries to match them.
  //
  // raw_row keeps the original line as it was read, so a mis-mapped column can be diagnosed
  // against what the bank actually sent rather than against our interpretation of it.
  await createTable('bank_statement_lines', `
    CREATE TABLE bank_statement_lines (
      id BIGINT NOT NULL AUTO_INCREMENT,
      reconciliation_id BIGINT NOT NULL,
      line_no INT NOT NULL,
      txn_date DATE NULL,
      description VARCHAR(500) NULL,
      reference VARCHAR(120) NULL,
      amount DECIMAL(15,2) NOT NULL,
      raw_row TEXT NULL,
      -- unmatched | matched (proposed, awaiting a person) | confirmed | bank_only | ignored
      status VARCHAR(20) NOT NULL DEFAULT 'unmatched',
      bank_only_account_id BIGINT NULL,
      note VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_bank_stmt_recon (reconciliation_id, status),
      CONSTRAINT fk_bank_stmt_recon FOREIGN KEY (reconciliation_id)
        REFERENCES bank_reconciliations (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // The match itself. source_kind + source_id name the book movement (a cheque, a bill payment or
  // a bank deposit); statement_line_id names the line it answers.
  //
  // UNIQUE on (source_kind, source_id): a document clears exactly once, ever, across every
  // reconciliation. This is the constraint that stops the same cheque being ticked off on two
  // statements -- both of which would otherwise balance perfectly and one of which would be wrong.
  //
  // confidence records HOW the match was arrived at, so a reviewer can see which ones the system
  // was sure about and which it guessed:
  //   exact      amount, direction and reference/cheque number all agree
  //   strong     amount and direction agree, within the date window, one candidate only
  //   weak       amount agrees but several candidates did -- a person must choose
  //   manual     a person picked it
  await createTable('bank_reconciliation_matches', `
    CREATE TABLE bank_reconciliation_matches (
      id BIGINT NOT NULL AUTO_INCREMENT,
      reconciliation_id BIGINT NOT NULL,
      statement_line_id BIGINT NULL,
      source_kind VARCHAR(20) NOT NULL,
      source_id BIGINT NOT NULL,
      amount DECIMAL(15,2) NOT NULL,
      confidence VARCHAR(12) NOT NULL DEFAULT 'manual',
      confirmed_at DATETIME NULL,
      confirmed_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_match_source (source_kind, source_id),
      KEY idx_bank_match_recon (reconciliation_id),
      KEY idx_bank_match_line (statement_line_id),
      CONSTRAINT fk_bank_match_recon FOREIGN KEY (reconciliation_id)
        REFERENCES bank_reconciliations (id) ON DELETE CASCADE,
      CONSTRAINT fk_bank_match_line FOREIGN KEY (statement_line_id)
        REFERENCES bank_statement_lines (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

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
      console.log(`Page ${pg.route}: registered as "${pg.name}" (id ${pageId}).`);
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
  console.log('System Admin granted in full.');

  const [[banks]] = await pool.query(
    "SELECT COUNT(*) AS n FROM chart_of_accounts WHERE detail_type = 'Bank' AND is_active = TRUE");
  console.log(`\n  ${banks.n} bank accounts available to reconcile.`);

  // The two date problems worth knowing about before somebody meets them mid-reconciliation.
  const [[odd]] = await pool.query(
    "SELECT COUNT(*) AS n FROM bank_deposits WHERE status <> 'void' AND date_created < '2015-01-01'");
  const [[future]] = await pool.query(
    "SELECT COUNT(*) AS n FROM cheques WHERE status <> 'void' AND date_released > CURDATE()");
  if (odd.n) console.log(`  ${odd.n} deposit(s) dated before 2015 -- bad data that lands in any all-time view.`);
  if (future.n) console.log(`  ${future.n} cheque(s) released with a FUTURE date -- permanently outstanding until that date.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
