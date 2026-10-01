// A Bill Credit's status follows its applied amount: Fully Applied once all of it is applied,
// Open while any is left -- and Voided stays Voided.
//
// Before this, a credit raised in T1S stayed Open forever: only credits migrated from the source
// carried Fully Applied, and none of the eight places that move applied_amount (create, edit,
// Bill Payment apply / edit / void, Cheque apply / edit / void) touched the status. BC-7431 read
// Open with 0.00 unapplied.
//
// An SQL assignment, appended AFTER `applied_amount = ...` in the same UPDATE: MySQL evaluates a
// single-table UPDATE's assignments left to right, so this sees the new applied_amount.
const CREDIT_STATUS_SQL =
  "status = CASE WHEN status = 'voided' THEN status WHEN applied_amount >= total_amount - 0.005 THEN 'fully_applied' ELSE 'open' END";

// For the paths that set applied_amount some other way (create, edit): re-derive afterwards.
async function syncBillCreditStatus(conn, creditId) {
  await conn.query(`UPDATE bill_credits SET ${CREDIT_STATUS_SQL} WHERE id = ?`, [creditId]);
}

module.exports = { CREDIT_STATUS_SQL, syncBillCreditStatus };
