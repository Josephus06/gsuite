// Shared "released commission" allocation for the Commission report and Commission Payable.
//
// A Commission Voucher releases commission against one or more monthly payables (its lines carry a
// gross released amount each) and may add expense adjustments. Per the business rule:
//   - a DEDUCTION (negative expense) waterfalls from the EARLIEST month, reducing that month's net
//     released until the deduction is used up, then spilling into the next month, and so on;
//   - a REFUND (positive expense) is added to the earliest month;
//   - the NET released for a month = gross − deducted + refunded, and the voucher's total net
//     released equals its Total Payments ("the total voucher created").
// e.g. Jan 1000 / Feb 215 with a −1115 deduction => Jan 0 (deducted 1000), Feb 100 (deducted 115).
const pool = require('../db');
const round2 = (n) => Number((Number(n) || 0).toFixed(2));

// Pure allocation for a single voucher. lines: [{ month, gross, ...passthrough }].
function allocateVoucher(lines, deductTotal, refundTotal) {
  const out = [...lines].sort((a, b) => a.month - b.month).map((l) => ({ ...l, deducted: 0, refunded: 0 }));
  let remaining = round2(deductTotal);
  for (const l of out) {
    if (remaining <= 0) break;
    const ded = Math.min(remaining, round2(l.gross));
    l.deducted = round2(ded);
    remaining = round2(remaining - ded);
  }
  if (out.length && refundTotal) out[0].refunded = round2(refundTotal);
  for (const l of out) l.net = round2(Number(l.gross) - l.deducted + l.refunded);
  return out;
}

function splitExpenses(expenseRows) {
  let d = 0; let r = 0;
  for (const e of expenseRows) { const a = Number(e.amount) || 0; if (a < 0) d += -a; else r += a; }
  return { d: round2(d), r: round2(r) };
}

async function tablesExist() {
  const [t] = await pool.query("SHOW TABLES LIKE 'commission_voucher_lines'");
  return t.length > 0;
}

// Per-month net released / deducted / refunded for one employee's vouchers in a year.
async function releaseByMonthForEmployee(employeeId, year) {
  const releasedByMonth = new Array(13).fill(0);
  const deductedByMonth = new Array(13).fill(0);
  const refundedByMonth = new Array(13).fill(0);
  if (!(await tablesExist())) return { releasedByMonth, deductedByMonth, refundedByMonth };

  const [vlines] = await pool.query(
    `SELECT cv.id AS vid, MONTH(cp.period_from) AS month, cvl.released_amount AS gross
     FROM commission_voucher_lines cvl
     JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
     JOIN commission_payables cp ON cp.id = cvl.commission_payable_id
     WHERE cp.employee_id = ? AND YEAR(cp.period_from) = ? AND cv.status <> 'void'`,
    [employeeId, year]
  );
  if (!vlines.length) return { releasedByMonth, deductedByMonth, refundedByMonth };

  const byV = new Map();
  for (const l of vlines) { const g = byV.get(l.vid) || []; g.push({ month: Number(l.month), gross: Number(l.gross) }); byV.set(l.vid, g); }
  const [exps] = await pool.query('SELECT commission_voucher_id AS vid, amount FROM commission_voucher_expenses WHERE commission_voucher_id IN (?)', [[...byV.keys()]]);
  const expByV = new Map();
  for (const e of exps) { const g = expByV.get(e.vid) || []; g.push(e); expByV.set(e.vid, g); }

  for (const [vid, lines] of byV) {
    const { d, r } = splitExpenses(expByV.get(vid) || []);
    for (const a of allocateVoucher(lines, d, r)) {
      releasedByMonth[a.month] += a.net;
      deductedByMonth[a.month] += a.deducted;
      refundedByMonth[a.month] += a.refunded;
    }
  }
  return { releasedByMonth, deductedByMonth, refundedByMonth };
}

// Net released / deducted / refunded allocated to a single payable across every voucher that pays
// it (each voucher's waterfall is computed over all of that voucher's lines, then this payable's
// share extracted).
async function releaseForPayable(payableId) {
  if (!(await tablesExist())) return { released: 0, deducted: 0, refunded: 0 };
  const [vs] = await pool.query(
    `SELECT DISTINCT cvl.commission_voucher_id AS vid FROM commission_voucher_lines cvl
     JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
     WHERE cvl.commission_payable_id = ? AND cv.status <> 'void'`,
    [payableId]
  );
  let released = 0; let deducted = 0; let refunded = 0;
  for (const { vid } of vs) {
    const [lines] = await pool.query(
      `SELECT cvl.commission_payable_id AS pid, MONTH(cp.period_from) AS month, cvl.released_amount AS gross
       FROM commission_voucher_lines cvl JOIN commission_payables cp ON cp.id = cvl.commission_payable_id
       WHERE cvl.commission_voucher_id = ?`,
      [vid]
    );
    const [exps] = await pool.query('SELECT amount FROM commission_voucher_expenses WHERE commission_voucher_id = ?', [vid]);
    const { d, r } = splitExpenses(exps);
    for (const a of allocateVoucher(lines.map((l) => ({ pid: l.pid, month: Number(l.month), gross: Number(l.gross) })), d, r)) {
      if (Number(a.pid) === Number(payableId)) { released += a.net; deducted += a.deducted; refunded += a.refunded; }
    }
  }
  return { released: round2(released), deducted: round2(deducted), refunded: round2(refunded) };
}

module.exports = { allocateVoucher, releaseByMonthForEmployee, releaseForPayable };
