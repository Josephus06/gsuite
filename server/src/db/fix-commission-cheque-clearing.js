// One cheque paying several Commission Vouchers posted the payment twice (found 2026-10-26, CHK-16564):
// each voucher DR 24200 Commission Payable / CR the bank, and the cheque DR 24200 / CR the same bank
// for their total. The vouchers must stay (they release the commission payables and feed the
// Commission report) and so must the cheque (the one instrument the bank paid). So they meet in a
// clearing account:
//
//   vouchers  DR 24200 Commission Payable / CR 11199 Commission Clearing
//   cheque    DR 11199 Commission Clearing / CR the bank
//
// 11199 nets to zero; Commission Payable is debited and the bank credited once. This creates 11199
// (under 11000, not a bank) if it is missing, points the vouchers that carry the cheque's number as
// their Ref # at it, and points the cheque's Commission Payable line(s) at it. Refused unless the
// vouchers add up to the cheque's Commission Payable lines exactly. Audit-logged on every document.
//
//   node src/db/fix-commission-cheque-clearing.js --cheque=CHK-16564                 preview
//   node src/db/fix-commission-cheque-clearing.js --cheque=CHK-16564 --apply --by=1
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const BY = Number((process.argv.find((a) => a.startsWith('--by=')) || '').slice(5)) || null;
const CHEQUE = (process.argv.find((a) => a.startsWith('--cheque=')) || '').slice(9);
const CLEARING = { code: '11199', name: 'Commission Clearing' };
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

async function audit(conn, type, id, field, oldValue, newValue) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES (?, ?, 'Updated', ?, ?, ?, ?)`, [type, id, field, oldValue, newValue, BY]);
}

(async () => {
  if (!CHEQUE) throw new Error('--cheque=<CHK-#> is required');
  if (APPLY && !BY) throw new Error('--by=<user id> is required with --apply');
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply --by=<user id> to write)'}\n`);
  const conn = await pool.getConnection();
  try {
    const [[payAcct]] = await conn.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '24200'");
    const [[chk]] = await conn.query(
      `SELECT c.id, c.cheque_no, c.cheque_number, c.status, c.total_amount, c.account_id, a.account_code AS bank_code
         FROM cheques c LEFT JOIN chart_of_accounts a ON a.id = c.account_id WHERE c.cheque_no = ?`, [CHEQUE]);
    if (!chk) throw new Error(`${CHEQUE} not found`);
    if (chk.status === 'void') throw new Error(`${CHEQUE} is void`);
    if (!chk.cheque_number) throw new Error(`${CHEQUE} has no cheque number to match the vouchers by`);
    const [chkLines] = await conn.query('SELECT id, amount FROM cheque_lines WHERE cheque_id = ? AND account_id = ?', [chk.id, payAcct.id]);
    const chkPayable = r2(chkLines.reduce((s, l) => s + Number(l.amount), 0));
    const [vouchers] = await conn.query(
      `SELECT cv.id, cv.voucher_no, cv.total_payments, cv.cash_bank_account_id, CONCAT(e.first_name, ' ', e.last_name) AS employee
         FROM commission_vouchers cv LEFT JOIN employees e ON e.id = cv.employee_id
        WHERE cv.status <> 'void' AND cv.reference_no = ? AND cv.cash_bank_account_id = ? ORDER BY cv.id`,
      [chk.cheque_number, chk.account_id]);
    const vTotal = r2(vouchers.reduce((s, v) => s + Number(v.total_payments), 0));
    console.log(`${chk.cheque_no} (cheque # ${chk.cheque_number}) bank ${chk.bank_code}: Commission Payable lines ${chkPayable.toFixed(2)}`);
    for (const v of vouchers) console.log(`  ${v.voucher_no}  ${v.employee}  ${Number(v.total_payments).toFixed(2)}`);
    console.log(`  ${vouchers.length} voucher(s) crediting ${chk.bank_code} with this cheque #: ${vTotal.toFixed(2)}`);
    if (!chkLines.length) throw new Error(`${CHEQUE} has no Commission Payable (24200) line -- nothing doubled`);
    if (!vouchers.length) throw new Error('No voucher carries this cheque number on the cheque\'s bank -- nothing doubled');
    if (Math.abs(vTotal - chkPayable) > 0.005) throw new Error(`The vouchers (${vTotal.toFixed(2)}) do not add up to the cheque's Commission Payable lines (${chkPayable.toFixed(2)}) -- left as they are`);

    if (APPLY) await conn.beginTransaction();
    let [[clearing]] = await conn.query('SELECT id, account_code FROM chart_of_accounts WHERE account_code = ?', [CLEARING.code]);
    if (!clearing) {
      console.log(`\n+ account ${CLEARING.code} ${CLEARING.name} (under 11000 Cash in Bank, not a bank)`);
      if (APPLY) {
        const [[parent]] = await conn.query("SELECT id, coa_type_id FROM chart_of_accounts WHERE account_code = '11000'");
        const [r] = await conn.query(
          `INSERT INTO chart_of_accounts (account_code, account_name, account_type, parent_account_id, is_active, coa_type_id, description, detail_type, is_summary)
           VALUES (?, ?, 'Asset', ?, 1, ?, ?, 'Other Current Asset', 0)`,
          [CLEARING.code, CLEARING.name, parent?.id || null, parent?.coa_type_id || null,
            'Commission paid by one cheque: the vouchers credit it, the cheque debits it. Nets to zero.']);
        clearing = { id: r.insertId, account_code: CLEARING.code };
      }
    } else console.log(`\n= account ${CLEARING.code} already there`);

    console.log(`~ ${vouchers.length} voucher(s): Cash/Bank Account ${chk.bank_code} -> ${CLEARING.code}`);
    console.log(`~ ${chk.cheque_no}: ${chkLines.length} line(s) 24200 -> ${CLEARING.code}`);
    if (APPLY) {
      for (const v of vouchers) {
        await conn.query('UPDATE commission_vouchers SET cash_bank_account_id = ? WHERE id = ?', [clearing.id, v.id]);
        await audit(conn, 'CommissionVoucher', v.id, 'cash_bank_account_id', chk.bank_code, `${CLEARING.code} ${CLEARING.name} (paid by ${chk.cheque_no})`);
      }
      for (const l of chkLines) {
        await conn.query('UPDATE cheque_lines SET account_id = ? WHERE id = ?', [clearing.id, l.id]);
        await audit(conn, 'Cheque', chk.id, 'line account', '24200 Commission Payable', `${CLEARING.code} ${CLEARING.name} (settles ${vouchers.length} commission vouchers)`);
      }
      await conn.commit();
      console.log('\nApplied.');
    }
  } catch (e) {
    if (APPLY) await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
