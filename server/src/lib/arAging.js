const pool = require('../db');

// AR Aging (Accounting > Reports > AR Aging). Every customer's outstanding receivable as
// of a date, split into age buckets. Reconstructed point-in-time -- like the four GL
// reports, it never trusts a stored running balance (sales_invoices.amount_due is a live
// figure that can't answer "what was owed last month"); it rebuilds each open item from
// documents dated on or before the as-of date.
//
// What makes up a customer's balance, all signed so positive = the customer owes us:
//   + each non-cancelled Invoice's gross, less the payments and credit-memo applications
//     that had settled it by the as-of date -> its remaining balance, aged by DUE date
//   - each open Credit Memo's still-unapplied remaining (a credit we owe back), aged by
//     the memo's own date
//   - each Customer Payment's unapplied cash (an overpayment sitting on account), aged by
//     the payment's own date
// A credit memo applied to an invoice is a wash on the total -- it lowers the invoice and
// lowers the credit we owe by the same amount -- which is exactly right.
//
// Aging basis: an invoice ages by how far past its DUE date the as-of date is; credits and
// overpayments have no due date, so they age by their document date. Current = not yet due.

function daysBetween(fromStr, toStr) {
  const a = new Date(`${String(fromStr).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(toStr).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function emptyBuckets() {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0 };
}

// Drop a signed amount into the bucket for how overdue it is as of the report date.
function addToBucket(buckets, amount, agingDate, asOf) {
  const overdue = daysBetween(agingDate, asOf);
  if (overdue <= 0) buckets.current += amount;
  else if (overdue <= 30) buckets.d1_30 += amount;
  else if (overdue <= 60) buckets.d31_60 += amount;
  else if (overdue <= 90) buckets.d61_90 += amount;
  else buckets.over_90 += amount;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Location scopes the *primary* document (invoice/memo/payment), never its settlements --
// a receivable belongs to wherever it was raised, and paying it from elsewhere doesn't
// move where it's owed. `noLocation` selects documents with no office location at all.
function locationClause(alias, { locationId, noLocation }) {
  if (noLocation) return { sql: ` AND ${alias}.office_location_id IS NULL`, params: [] };
  if (locationId) return { sql: ` AND ${alias}.office_location_id = ?`, params: [locationId] };
  return { sql: '', params: [] };
}

async function buildArAging(asOf, filters = {}) {
  const { nameStarts } = filters;
  const nameClause = nameStarts ? ' AND c.name LIKE ?' : '';
  const nameParam = nameStarts ? [`${nameStarts}%`] : [];

  const invLoc = locationClause('si', filters);
  const [invoices] = await pool.query(
    `SELECT si.id, so.customer_id, c.name AS customer_name, si.date_created, si.date_due, si.gross_amount
     FROM sales_invoices si
     JOIN sales_orders so ON so.id = si.sales_order_id
     JOIN customers c ON c.id = so.customer_id
     WHERE si.status != 'cancelled' AND si.date_created <= ?${invLoc.sql}${nameClause}`,
    [asOf, ...invLoc.params, ...nameParam]
  );

  // Settlements that had landed by the as-of date, summed per invoice. Payments and memos
  // are atomic, so their whole effect counts once the parent document's date has passed.
  const [payToInv] = await pool.query(
    `SELECT cpl.sales_invoice_id AS invoice_id, SUM(cpl.applied_amount) AS amt
     FROM customer_payment_lines cpl
     JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
     WHERE cpl.sales_invoice_id IS NOT NULL AND cp.status != 'voided' AND cp.date_created <= ?
     GROUP BY cpl.sales_invoice_id`,
    [asOf]
  );
  const [memoToInv] = await pool.query(
    `SELECT cma.sales_invoice_id AS invoice_id, SUM(cma.applied_amount) AS amt
     FROM credit_memo_applications cma
     JOIN credit_memos cm ON cm.id = cma.credit_memo_id
     WHERE cm.status != 'voided' AND cm.date_created <= ?
     GROUP BY cma.sales_invoice_id`,
    [asOf]
  );
  const paidByInvoice = new Map(payToInv.map((r) => [r.invoice_id, Number(r.amt)]));
  const creditedByInvoice = new Map(memoToInv.map((r) => [r.invoice_id, Number(r.amt)]));

  const memoLoc = locationClause('cm', filters);
  const [memos] = await pool.query(
    `SELECT cm.id, cm.customer_id, c.name AS customer_name, cm.date_created, cm.gross_amount
     FROM credit_memos cm
     JOIN customers c ON c.id = cm.customer_id
     WHERE cm.status != 'voided' AND cm.date_created <= ?${memoLoc.sql}${nameClause}`,
    [asOf, ...memoLoc.params, ...nameParam]
  );
  // A memo's remaining credit = its gross, less what it has been applied to invoices and
  // less any payment that has drawn on it.
  const [memoApplied] = await pool.query(
    `SELECT cm.id, COALESCE(SUM(cma.applied_amount), 0) AS amt
     FROM credit_memos cm
     LEFT JOIN credit_memo_applications cma ON cma.credit_memo_id = cm.id
     WHERE cm.status != 'voided' AND cm.date_created <= ?
     GROUP BY cm.id`,
    [asOf]
  );
  const [memoDrawn] = await pool.query(
    `SELECT cpl.credit_memo_id AS memo_id, SUM(cpl.applied_amount) AS amt
     FROM customer_payment_lines cpl
     JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
     WHERE cpl.credit_memo_id IS NOT NULL AND cp.status != 'voided' AND cp.date_created <= ?
     GROUP BY cpl.credit_memo_id`,
    [asOf]
  );
  const appliedByMemo = new Map(memoApplied.map((r) => [r.id, Number(r.amt)]));
  const drawnByMemo = new Map(memoDrawn.map((r) => [r.memo_id, Number(r.amt)]));

  const payLoc = locationClause('cp', filters);
  const [payments] = await pool.query(
    `SELECT cp.id, cp.customer_id, c.name AS customer_name, cp.date_created, cp.payment_amount
     FROM customer_payments cp
     JOIN customers c ON c.id = cp.customer_id
     WHERE cp.status != 'voided' AND cp.date_created <= ?${payLoc.sql}${nameClause}`,
    [asOf, ...payLoc.params, ...nameParam]
  );
  // Only cash applied to invoices consumes a payment; a line drawing a credit moves no
  // cash. What's left over is an overpayment held on account.
  const [payCashApplied] = await pool.query(
    `SELECT cpl.customer_payment_id AS payment_id, SUM(cpl.applied_amount) AS amt
     FROM customer_payment_lines cpl
     JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
     WHERE cpl.sales_invoice_id IS NOT NULL AND cp.status != 'voided' AND cp.date_created <= ?
     GROUP BY cpl.customer_payment_id`,
    [asOf]
  );
  const cashAppliedByPayment = new Map(payCashApplied.map((r) => [r.payment_id, Number(r.amt)]));

  // Accumulate every contribution into per-customer buckets.
  const byCustomer = new Map();
  function customerRow(id, name) {
    if (!byCustomer.has(id)) {
      byCustomer.set(id, { customer_id: id, customer_name: name, ...emptyBuckets() });
    }
    return byCustomer.get(id);
  }

  for (const inv of invoices) {
    const remaining = Number(inv.gross_amount)
      - (paidByInvoice.get(inv.id) || 0)
      - (creditedByInvoice.get(inv.id) || 0);
    if (Math.abs(remaining) < 0.005) continue;
    addToBucket(customerRow(inv.customer_id, inv.customer_name), remaining, inv.date_due || inv.date_created, asOf);
  }
  for (const cm of memos) {
    const remaining = Number(cm.gross_amount) - (appliedByMemo.get(cm.id) || 0) - (drawnByMemo.get(cm.id) || 0);
    if (remaining < 0.005) continue;
    addToBucket(customerRow(cm.customer_id, cm.customer_name), -remaining, cm.date_created, asOf);
  }
  for (const cp of payments) {
    const unapplied = Number(cp.payment_amount) - (cashAppliedByPayment.get(cp.id) || 0);
    if (unapplied < 0.005) continue;
    addToBucket(customerRow(cp.customer_id, cp.customer_name), -unapplied, cp.date_created, asOf);
  }

  const rows = [...byCustomer.values()]
    .map((r) => {
      const buckets = {
        current: round2(r.current), d1_30: round2(r.d1_30), d31_60: round2(r.d31_60),
        d61_90: round2(r.d61_90), over_90: round2(r.over_90),
      };
      const total = round2(buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.over_90);
      return { customer_id: r.customer_id, customer_name: r.customer_name, ...buckets, total_balance: total };
    })
    // A customer with everything netted to zero isn't outstanding -- drop it, same as the
    // real report only listing customers with a balance.
    .filter((r) => Math.abs(r.total_balance) >= 0.005
      || [r.current, r.d1_30, r.d31_60, r.d61_90, r.over_90].some((v) => Math.abs(v) >= 0.005))
    .sort((a, b) => a.customer_name.localeCompare(b.customer_name));

  const totals = rows.reduce((t, r) => ({
    current: t.current + r.current, d1_30: t.d1_30 + r.d1_30, d31_60: t.d31_60 + r.d31_60,
    d61_90: t.d61_90 + r.d61_90, over_90: t.over_90 + r.over_90, total_balance: t.total_balance + r.total_balance,
  }), { ...emptyBuckets(), total_balance: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });

  return { as_of: asOf, rows, totals };
}

// The DETAILS drill-down: the individual open items making up one customer's balance, each
// with its own remaining and bucket -- what the aging row is the sum of.
async function buildArAgingCustomerDetails(customerId, asOf) {
  const [[customer]] = await pool.query('SELECT id, name FROM customers WHERE id = ?', [customerId]);
  if (!customer) return null;

  const [invoices] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.gross_amount,
            COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                      JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                      WHERE cpl.sales_invoice_id = si.id AND cp.status != 'voided' AND cp.date_created <= ?), 0)
            + COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma
                        JOIN credit_memos cm ON cm.id = cma.credit_memo_id
                        WHERE cma.sales_invoice_id = si.id AND cm.status != 'voided' AND cm.date_created <= ?), 0) AS settled
     FROM sales_invoices si
     JOIN sales_orders so ON so.id = si.sales_order_id
     WHERE so.customer_id = ? AND si.status != 'cancelled' AND si.date_created <= ?`,
    [asOf, asOf, customerId, asOf]
  );

  const items = [];
  for (const inv of invoices) {
    const remaining = Number(inv.gross_amount) - Number(inv.settled);
    if (Math.abs(remaining) < 0.005) continue;
    const agingDate = inv.date_due || inv.date_created;
    items.push({
      type: 'Invoice', reference: inv.invoice_no, id: inv.id, date: inv.date_created,
      due_date: inv.date_due, original_amount: round2(inv.gross_amount), balance: round2(remaining),
      days_overdue: Math.max(daysBetween(agingDate, asOf), 0),
    });
  }

  const [memos] = await pool.query(
    `SELECT cm.id, cm.credit_memo_no, cm.date_created, cm.gross_amount,
            COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma WHERE cma.credit_memo_id = cm.id), 0)
            + COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                        JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                        WHERE cpl.credit_memo_id = cm.id AND cp.status != 'voided' AND cp.date_created <= ?), 0) AS used
     FROM credit_memos cm
     WHERE cm.customer_id = ? AND cm.status != 'voided' AND cm.date_created <= ?`,
    [asOf, customerId, asOf]
  );
  for (const cm of memos) {
    const remaining = Number(cm.gross_amount) - Number(cm.used);
    if (remaining < 0.005) continue;
    items.push({
      type: 'Credit Memo', reference: cm.credit_memo_no, id: cm.id, date: cm.date_created,
      due_date: null, original_amount: round2(cm.gross_amount), balance: round2(-remaining),
      days_overdue: Math.max(daysBetween(cm.date_created, asOf), 0),
    });
  }

  const [payments] = await pool.query(
    `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount,
            COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                      WHERE cpl.customer_payment_id = cp.id AND cpl.sales_invoice_id IS NOT NULL), 0) AS cash_applied
     FROM customer_payments cp
     WHERE cp.customer_id = ? AND cp.status != 'voided' AND cp.date_created <= ?`,
    [customerId, asOf]
  );
  for (const cp of payments) {
    const unapplied = Number(cp.payment_amount) - Number(cp.cash_applied);
    if (unapplied < 0.005) continue;
    items.push({
      type: 'Unapplied Payment', reference: cp.customer_payment_no, id: cp.id, date: cp.date_created,
      due_date: null, original_amount: round2(cp.payment_amount), balance: round2(-unapplied),
      days_overdue: Math.max(daysBetween(cp.date_created, asOf), 0),
    });
  }

  items.sort((a, b) => new Date(a.date) - new Date(b.date));
  const total = round2(items.reduce((s, i) => s + i.balance, 0));
  return { customer_id: customer.id, customer_name: customer.name, as_of: asOf, items, total_balance: total };
}

// The LEDGER drill-down: every AR document for the customer in date order, with a running
// balance of what they owe. Invoices raise the balance; payments (cash) and credit memos
// lower it. This is the transaction history behind the number, not a point-in-time recut,
// so it lists everything up to the as-of date.
async function buildArAgingCustomerLedger(customerId, asOf) {
  const [[customer]] = await pool.query('SELECT id, name FROM customers WHERE id = ?', [customerId]);
  if (!customer) return null;

  const entries = [];

  const [invoices] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount
     FROM sales_invoices si JOIN sales_orders so ON so.id = si.sales_order_id
     WHERE so.customer_id = ? AND si.status != 'cancelled' AND si.date_created <= ?`,
    [customerId, asOf]
  );
  for (const si of invoices) {
    entries.push({ date: si.date_created, type: 'Invoice', reference: si.invoice_no, id: si.id, amount: round2(si.gross_amount) });
  }

  const [memos] = await pool.query(
    `SELECT id, credit_memo_no, date_created, gross_amount FROM credit_memos
     WHERE customer_id = ? AND status != 'voided' AND date_created <= ?`,
    [customerId, asOf]
  );
  for (const cm of memos) {
    entries.push({ date: cm.date_created, type: 'Credit Memo', reference: cm.credit_memo_no, id: cm.id, amount: round2(-cm.gross_amount) });
  }

  const [payments] = await pool.query(
    `SELECT id, customer_payment_no, date_created, payment_amount FROM customer_payments
     WHERE customer_id = ? AND status != 'voided' AND date_created <= ?`,
    [customerId, asOf]
  );
  for (const cp of payments) {
    entries.push({ date: cp.date_created, type: 'Payment', reference: cp.customer_payment_no, id: cp.id, amount: round2(-cp.payment_amount) });
  }

  entries.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.reference).localeCompare(String(b.reference)));
  let running = 0;
  const ledger = entries.map((e) => {
    running = round2(running + e.amount);
    return { ...e, balance: running };
  });

  return { customer_id: customer.id, customer_name: customer.name, as_of: asOf, ledger, total_balance: running };
}

module.exports = { buildArAging, buildArAgingCustomerDetails, buildArAgingCustomerLedger };
