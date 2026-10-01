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



// A cheque paid to a vendor in advance becomes a Bill Credit (bill_credits.cheque_id), and that
// credit is what gets applied to the vendor's bills. Once its credits have applied the whole
// cheque, the cheque is FULLY APPLIED -- the source's own status for exactly this; Open again if
// an application is reversed. Void stays Void. Only cheques a credit was made from are touched,
// so a migrated Fully Applied cheque with no T1S credit keeps its status.
async function syncChequeForCredit(conn, creditId) {
  await conn.query(
    `UPDATE cheques c
        JOIN (SELECT bc.cheque_id, SUM(CASE WHEN bc.status = 'voided' THEN 0 ELSE bc.applied_amount END) AS applied
                FROM bill_credits bc
               WHERE bc.cheque_id = (SELECT cheque_id FROM bill_credits WHERE id = ?)
               GROUP BY bc.cheque_id) t ON t.cheque_id = c.id
        SET c.status = IF(t.applied >= c.total_amount - 0.005 AND c.total_amount > 0, 'fully_applied', 'open')
      WHERE c.status <> 'void'`,
    [creditId]
  );
}
module.exports = { CREDIT_STATUS_SQL, syncBillCreditStatus, syncChequeForCredit };
