const pool = require('../db');

// Every movement that should have hit a bank account, from the documents that caused it.
//
// NOT FROM THE GENERAL LEDGER, and that is measured rather than assumed: of 15,612 cheques only
// 710 carry a journal entry, and bank deposits and bill payments carry none at all. The GL would
// give an almost empty book side to weigh a full bank statement against.
//
// Three sources, unioned the way lib/stockLedger.js unions its six:
//
//   cheque        money out   cheques.account_id          on date_released
//   bill_payment  money out   bill_payments.bank_account_id on date_released
//   deposit       money in    bank_deposits.account_id    on date_created
//
// SIGN CONVENTION: positive is money INTO the account, negative is money OUT. The bank statement
// is normalised the same way at import, so the two sides can be compared without either having to
// remember which way round the other counts.
//
// VOIDED DOCUMENTS ARE EXCLUDED. A voided cheque never reached the bank, so it has nothing to
// reconcile against and would sit outstanding for ever.
//
// date_released, not date_created, for both money-out sources: a cheque written in March and
// handed over in May hits the bank in May, and reconciling it against March would leave two
// statements each looking wrong.

// The date each source is considered to have hit the bank, per source.
const SOURCE_SQL = {
  cheque: `
    SELECT 'cheque' AS source_kind, c.id AS source_id, c.cheque_no AS doc_no,
           c.cheque_number AS reference, c.date_released AS txn_date,
           c.payee_name AS party, c.memo,
           -c.total_amount AS amount
      FROM cheques c
     WHERE c.account_id = ? AND c.status <> 'void' AND c.date_released IS NOT NULL`,
  bill_payment: `
    SELECT 'bill_payment' AS source_kind, b.id AS source_id, b.bill_payment_no AS doc_no,
           COALESCE(NULLIF(b.check_no, ''), b.reference_no) AS reference, b.date_released AS txn_date,
           b.payee_name AS party, b.memo,
           -b.total_amount AS amount
      FROM bill_payments b
     WHERE b.bank_account_id = ? AND b.status <> 'void' AND b.date_released IS NOT NULL`,
  deposit: `
    SELECT 'deposit' AS source_kind, d.id AS source_id, d.bd_no AS doc_no,
           NULL AS reference, d.date_created AS txn_date,
           NULL AS party, d.memo,
           d.total_amount AS amount
      FROM bank_deposits d
     WHERE d.account_id = ? AND d.status <> 'void'`,
};

// Movements on one account up to and including `asOf`, excluding anything already cleared on ANY
// reconciliation -- that is what "outstanding" means, and the unique key on
// bank_reconciliation_matches is what makes the exclusion trustworthy.
//
// `includeReconciliationId` lets the screen you are working on see its OWN matches, which are
// otherwise excluded by the same rule: while reviewing, a matched item must stay visible.
async function outstandingMovements(accountId, { asOf, includeReconciliationId = null, q = pool } = {}) {
  const parts = [];
  const params = [];
  for (const sql of Object.values(SOURCE_SQL)) {
    parts.push(sql);
    params.push(accountId);
  }

  // Dates are compared as dates. A cheque released ON the statement date belongs to that
  // statement, so the bound is inclusive.
  const dateClause = asOf ? 'AND m.txn_date <= ?' : '';
  const dateParams = asOf ? [asOf] : [];

  const claimed = includeReconciliationId
    ? `AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches x
                        WHERE x.source_kind = m.source_kind AND x.source_id = m.source_id
                          AND x.reconciliation_id <> ?)`
    : `AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches x
                        WHERE x.source_kind = m.source_kind AND x.source_id = m.source_id)`;
  const claimedParams = includeReconciliationId ? [includeReconciliationId] : [];

  const [rows] = await q.query(
    `SELECT m.* FROM (${parts.join(' UNION ALL ')}) m
      WHERE 1 = 1 ${dateClause} ${claimed}
      ORDER BY m.txn_date, m.source_kind, m.source_id`,
    [...params, ...dateParams, ...claimedParams],
  );
  return rows;
}

// One movement by its (kind, id) -- used when confirming a manual match, so the amount stored on
// the match is read from the document rather than taken from the browser.
async function movement(accountId, sourceKind, sourceId, q = pool) {
  const sql = SOURCE_SQL[sourceKind];
  if (!sql) return null;
  const [rows] = await q.query(
    `SELECT m.* FROM (${sql}) m WHERE m.source_id = ?`, [accountId, sourceId]);
  return rows[0] || null;
}

// The book's own balance for an account as at a date: every movement, cleared or not.
//
// This is the figure the finished reconciliation reports as "balance per book", and it is
// deliberately NOT the sum of what was ticked -- the whole point of the exercise is to show that
// the two agree once outstanding items are allowed for.
async function bookBalance(accountId, asOf, q = pool) {
  const parts = Object.values(SOURCE_SQL);
  const params = parts.map(() => accountId);
  const [[row]] = await q.query(
    `SELECT COALESCE(SUM(m.amount), 0) AS balance FROM (${parts.join(' UNION ALL ')}) m
      WHERE m.txn_date <= ?`,
    [...params, asOf],
  );
  return Number(row.balance || 0);
}

module.exports = { SOURCE_SQL, outstandingMovements, movement, bookBalance };
