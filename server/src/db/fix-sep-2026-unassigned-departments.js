// September 2026 postings the source saved with no department, so the department reports showed
// them as Unassigned (2026-10-24). Departments as the user confirmed:
//
//   VB-24623  30506 Freight In         3,571.43  -> Production-SIGNAGE  (freight on brass sheets)
//   CHK-9205  30619 Interest Expense   1,197.81  -> Accounting          (China Bank vehicle loans,
//   CHK-9284  30619 Interest Expense   3,611.50  -> Accounting           as the rest of September's
//   CHK-9241  30619 Interest Expense   1,445.97  -> Accounting           interest is)
//
// Two places: the documents' own lines in T1S, and the source's September department figures
// (source_dept_account_actuals) that the reports split the source month by -- the "No Department"
// amount moves to the department. Account totals do not change. No journal is posted.
//
// NOTE: re-loading September with db/load-source-dept-actuals.js brings the source's "No Department"
// back unless the departments are also set on these documents in the source.
//
//   node src/db/fix-sep-2026-unassigned-departments.js           # dry run
//   node src/db/fix-sep-2026-unassigned-departments.js --apply
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const FIXES = [
  { kind: 'bill', no: 'VB-24623', account: '30506', amount: 3571.43, dept: 'Production-SIGNAGE' },
  { kind: 'cheque', no: 'CHK-9205', account: '30619', amount: 1197.81, dept: 'Accounting' },
  { kind: 'cheque', no: 'CHK-9284', account: '30619', amount: 3611.5, dept: 'Accounting' },
  { kind: 'cheque', no: 'CHK-9241', account: '30619', amount: 1445.97, dept: 'Accounting' },
];
const r2 = (n) => Number(Number(n).toFixed(2));

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN'}`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const deptId = {};
    for (const name of new Set(FIXES.map((f) => f.dept))) {
      const [[d]] = await conn.query('SELECT id FROM departments WHERE name = ?', [name]);
      if (!d) throw new Error(`No T1S department named ${name}`);
      deptId[name] = d.id;
    }

    // 1. The documents' lines.
    for (const f of FIXES) {
      const [r] = f.kind === 'bill'
        ? await conn.query(
          `UPDATE vendor_bill_lines l JOIN vendor_bills vb ON vb.id = l.vendor_bill_id
              SET l.department_id = ? WHERE vb.bill_no = ? AND l.department_id IS NULL AND ABS(l.net_of_tax - ?) < 0.01`,
          [deptId[f.dept], f.no, f.amount])
        : await conn.query(
          `UPDATE cheque_lines l JOIN cheques c ON c.id = l.cheque_id JOIN chart_of_accounts a ON a.id = l.account_id
              SET l.department_id = ? WHERE c.cheque_no = ? AND a.account_code = ? AND l.department_id IS NULL AND ABS(l.amount - ?) < 0.01`,
          [deptId[f.dept], f.no, f.account, f.amount]);
      console.log(`  ${f.no} ${f.account} ${f.amount} -> ${f.dept}: ${r.affectedRows} line(s)`);
    }

    // 2. The source's September figures: "No Department" -> the department, per account.
    const byAcct = new Map();
    for (const f of FIXES) {
      const k = `${f.account}|${f.dept}`;
      byAcct.set(k, r2((byAcct.get(k) || 0) + f.amount));
    }
    for (const [k, amt] of byAcct) {
      const [account, dept] = k.split('|');
      const [[none]] = await conn.query(
        "SELECT id, section, amount FROM source_dept_account_actuals WHERE year = 2026 AND month = 9 AND account_code = ? AND source_department = 'No Department'", [account]);
      if (!none || Math.abs(Number(none.amount) - amt) > 0.01) {
        console.log(`  ${account}: No Department is ${none ? none.amount : 'missing'}, expected ${amt} -- left alone`);
        continue;
      }
      const [[have]] = await conn.query(
        'SELECT id, amount FROM source_dept_account_actuals WHERE year = 2026 AND month = 9 AND account_code = ? AND source_department = ?', [account, dept]);
      if (have) await conn.query('UPDATE source_dept_account_actuals SET amount = ? WHERE id = ?', [r2(Number(have.amount) + amt), have.id]);
      else {
        await conn.query(
          'INSERT INTO source_dept_account_actuals (year, month, source_department, section, account_code, amount) VALUES (2026, 9, ?, ?, ?, ?)',
          [dept, none.section, account, amt]);
      }
      await conn.query('DELETE FROM source_dept_account_actuals WHERE id = ?', [none.id]);
      console.log(`  ${account}: No Department ${amt} -> ${dept} (${have ? `${have.amount} -> ${r2(Number(have.amount) + amt)}` : 'new row'})`);
    }

    if (APPLY) { await conn.commit(); console.log('  applied'); } else { await conn.rollback(); console.log('  rolled back (dry run)'); }
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
