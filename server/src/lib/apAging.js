const pool = require('../db');

// AP Aging (Accounting > Reports > AP Aging). The payables mirror of lib/arAging.js: every
// vendor's outstanding balance as of a date, split into the same five age buckets. Built the
// same way and deliberately in the same shape, so the two reports can be read side by side.
//
// What makes up a vendor's balance, all signed so positive = we owe them:
//   + each non-cancelled Vendor Bill's payable, less the bill payments and bill-credit
//     applications that had settled it by the as-of date -> its remaining, aged by DUE date
//   - each open Bill Credit's still-unused remaining (a credit the vendor owes us back), aged
//     by the credit's own date
//   - each Bill Payment's unapplied cash (we paid more than we applied), aged by its own date
//
// THE PAYABLE IS gross_amount - wtax_amount, NOT gross. Withholding tax is money withheld from
// the vendor and remitted to the BIR, so it was never owed to them; routes/vendorBills.js opens
// every bill at exactly `grossAmount - wtaxAmount` and that is the figure this report ages.
// Using gross would overstate payables by the whole withheld amount -- PHP 2.2M across the
// 19,164 bills in this database.
//
// MARKED PAID, NOT EVIDENCED -- AND WHY THIS REPORT DEFAULTS THE OPPOSITE WAY TO AR AGING.
// AR Aging counts an invoice that claims to be settled with nothing recording the settlement,
// and flags it: there, such invoices were 1.9% of the file, so including them kept the report
// honest at a cost of a footnote.
//
// On the payables side the same question has a different answer, because the data is different
// in kind: 12,221 of the 18,873 bills marked paid -- 65% of them, PHP 149.4M -- carry no bill
// payment at all, because the bill payment migration is unfinished (868 of the payments landed
// with their applications, the rest as headers or not at all). Deriving those into the balance
// would report about PHP 162M outstanding where the business is carrying PHP 13M, and a
// payables report that is twelve times the real number is not one anyone can use.
//
// So they are EXCLUDED by default and counted in the open, never silently dropped: the response
// always carries `unevidenced` (count and amount), the page states it above the numbers, and
// `includeUnevidenced` puts them back in for anyone who wants the derived-from-documents view
// the AR report gives. The default is a judgement about which number is less wrong, not a claim
// that those bills are settled.
const UNEVIDENCED_DEFAULT = false;

// A bill whose header says it is settled. 'paid' is what the migration wrote; 'paid_in_full' is
// what routes/billPayments.js writes when a payment closes one. Either, or a zero amount due, is
// enough to make silence about a payment worth flagging.
function isMarkedPaid(bill) {
  const status = String(bill.status || '').toLowerCase();
  return status === 'paid' || status === 'paid_in_full'
    || Math.abs(Number(bill.amount_due || 0)) < 0.005;
}

function daysBetween(fromStr, toStr) {
  const a = new Date(`${String(fromStr).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(toStr).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function emptyBuckets() {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0 };
}

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

// Location scopes the primary document, never its settlements -- a payable belongs to wherever
// it was raised, and paying it from elsewhere does not move where it is owed. Same rule, same
// words, as the AR side.
function locationClause(alias, { locationId, noLocation }) {
  if (noLocation) return { sql: ` AND ${alias}.office_location_id IS NULL`, params: [] };
  if (locationId) return { sql: ` AND ${alias}.office_location_id = ?`, params: [locationId] };
  return { sql: '', params: [] };
}

// Every open payables item as of a date. One function feeding both the buckets and the
// drill-down, for the same reason the AR side has one: a detail that does not add up to its
// summary is worse than no detail.
async function collectOpenApItems(asOf, filters = {}) {
  const { nameStarts, supplierId } = filters;
  const includeUnevidenced = filters.includeUnevidenced === undefined
    ? UNEVIDENCED_DEFAULT : !!filters.includeUnevidenced;
  const nameClause = nameStarts ? ' AND s.name LIKE ?' : '';
  const nameParam = nameStarts ? [`${nameStarts}%`] : [];
  const supClause = supplierId ? ' AND s.id = ?' : '';
  const supParam = supplierId ? [supplierId] : [];

  // A bill reaches its vendor through its purchase order; vendor_bills carries no supplier of
  // its own. Every bill in this database has one (checked: zero orphans), but the join stays
  // inner deliberately -- a bill with no vendor has no line to appear on in a vendor report.
  const billLoc = locationClause('vb', filters);
  const [bills] = await pool.query(
    `SELECT vb.id, s.id AS supplier_id, s.name AS supplier_name, vb.bill_no, vb.date_created, vb.date_due,
            vb.gross_amount, vb.wtax_amount, vb.amount_due, vb.status, vb.reference_no, vb.memo,
            po.po_no, loc.location_name
       FROM vendor_bills vb
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
      WHERE vb.cancelled_at IS NULL AND vb.status <> 'cancelled' AND vb.date_created <= ?
            ${billLoc.sql}${nameClause}${supClause}`,
    [asOf, ...billLoc.params, ...nameParam, ...supParam],
  );

  // Settlements that had landed by the as-of date, summed per bill.
  const [payToBill] = await pool.query(
    `SELECT bpl.vendor_bill_id AS bill_id, SUM(bpl.applied_amount) AS amt
       FROM bill_payment_lines bpl
       JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
      WHERE bpl.vendor_bill_id IS NOT NULL AND bp.status <> 'voided' AND bp.voided_at IS NULL
        AND bp.date_created <= ?
      GROUP BY bpl.vendor_bill_id`,
    [asOf],
  );
  const [creditToBill] = await pool.query(
    `SELECT bca.vendor_bill_id AS bill_id, SUM(bca.applied_amount) AS amt
       FROM bill_credit_applications bca
       JOIN bill_credits bc ON bc.id = bca.bill_credit_id
      WHERE bc.status <> 'voided' AND bc.voided_at IS NULL AND bc.date_created <= ?
      GROUP BY bca.vendor_bill_id`,
    [asOf],
  );
  const paidByBill = new Map(payToBill.map((r) => [r.bill_id, Number(r.amt)]));
  const creditedByBill = new Map(creditToBill.map((r) => [r.bill_id, Number(r.amt)]));

  const creditLoc = locationClause('bc', filters);
  const [credits] = await pool.query(
    `SELECT bc.id, s.id AS supplier_id, s.name AS supplier_name, bc.bill_credit_no, bc.date_created,
            bc.total_amount, bc.memo, loc.location_name
       FROM bill_credits bc
       JOIN vendor_bills vb ON vb.id = bc.vendor_bill_id
       JOIN purchase_orders po ON po.id = vb.purchase_order_id
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN locations loc ON loc.id = bc.office_location_id
      WHERE bc.status <> 'voided' AND bc.voided_at IS NULL AND bc.date_created <= ?
            ${creditLoc.sql}${nameClause}${supClause}`,
    [asOf, ...creditLoc.params, ...nameParam, ...supParam],
  );
  // A credit's remaining = its total, less what it has been applied to bills and less any bill
  // payment that has drawn on it (the Debits tab of the payment modal).
  const [creditApplied] = await pool.query(
    `SELECT bc.id, COALESCE(SUM(bca.applied_amount), 0) AS amt
       FROM bill_credits bc
       LEFT JOIN bill_credit_applications bca ON bca.bill_credit_id = bc.id
      WHERE bc.status <> 'voided' AND bc.date_created <= ?
      GROUP BY bc.id`,
    [asOf],
  );
  const [creditDrawn] = await pool.query(
    `SELECT bpl.bill_credit_id AS credit_id, SUM(bpl.applied_amount) AS amt
       FROM bill_payment_lines bpl
       JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
      WHERE bpl.bill_credit_id IS NOT NULL AND bp.status <> 'voided' AND bp.date_created <= ?
      GROUP BY bpl.bill_credit_id`,
    [asOf],
  );
  const appliedByCredit = new Map(creditApplied.map((r) => [r.id, Number(r.amt)]));
  const drawnByCredit = new Map(creditDrawn.map((r) => [r.credit_id, Number(r.amt)]));

  const payLoc = locationClause('bp', filters);
  const [payments] = await pool.query(
    `SELECT bp.id, s.id AS supplier_id, s.name AS supplier_name, bp.bill_payment_no, bp.date_created,
            bp.total_amount, bp.memo, bp.reference_no, bp.check_no, loc.location_name
       FROM bill_payments bp
       JOIN suppliers s ON s.id = bp.supplier_id
       LEFT JOIN locations loc ON loc.id = bp.office_location_id
      WHERE bp.status <> 'voided' AND bp.voided_at IS NULL AND bp.date_created <= ?
            ${payLoc.sql}${nameClause}${supClause}`,
    [asOf, ...payLoc.params, ...nameParam, ...supParam],
  );
  // Only cash applied to BILLS consumes a payment; a line drawing a bill credit moves no cash.
  const [payApplied] = await pool.query(
    `SELECT bpl.bill_payment_id AS payment_id, SUM(bpl.applied_amount) AS amt
       FROM bill_payment_lines bpl
       JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
      WHERE bpl.vendor_bill_id IS NOT NULL AND bp.status <> 'voided' AND bp.date_created <= ?
      GROUP BY bpl.bill_payment_id`,
    [asOf],
  );
  const appliedByPayment = new Map(payApplied.map((r) => [r.payment_id, Number(r.amt)]));

  // Which payments have ANY line, which the SUM above cannot tell us: it is absent both for a
  // payment that applied nothing and for one whose lines were never imported, and those need
  // opposite treatment. The AR side draws the same distinction for the same reason.
  const [payLineCounts] = await pool.query(
    `SELECT bill_payment_id AS payment_id, COUNT(*) AS n FROM bill_payment_lines GROUP BY bill_payment_id`,
  );
  const hasLines = new Set(payLineCounts.map((r) => r.payment_id));

  const items = [];
  const unevidenced = { count: 0, amount: 0 };
  const unlinkedPayments = { count: 0, amount: 0 };
  const headerDisagreement = { count: 0, amount: 0 };

  for (const bill of bills) {
    // What was ever owed to the vendor on this bill: gross less the tax withheld from them.
    const payable = Number(bill.gross_amount) - Number(bill.wtax_amount || 0);
    const settled = (paidByBill.get(bill.id) || 0) + (creditedByBill.get(bill.id) || 0);
    const remaining = payable - settled;
    if (Math.abs(remaining) < 0.005) continue;

    const claimsPaid = isMarkedPaid(bill) && settled < 0.005;
    if (claimsPaid) {
      unevidenced.count += 1;
      unevidenced.amount += remaining;
      if (!includeUnevidenced) continue;
    }

    // A THIRD FACE OF THE SAME UNFINISHED MIGRATION, and the one that does not announce itself.
    // 1,231 of the 1,460 bills carrying a balance on production are still 'open' but hold a
    // header Amount Due LOWER than their own documents support -- PHP 4.0M in total. Something
    // drew those headers down without leaving a payment behind, so the migration's own partial
    // settlements are invisible to a report built from documents.
    //
    // Not excluded: unlike a bill claiming to be fully paid, there is no clean line here between
    // "already settled" and "still owed", and dropping the difference would mean silently
    // trusting a header this report exists not to trust. Counted and reported instead, so the
    // reader knows how much of the total rests on that disagreement.
    const headerDue = Number(bill.amount_due || 0);
    if (Math.abs(remaining - headerDue) >= 0.005) {
      headerDisagreement.count += 1;
      headerDisagreement.amount += remaining - headerDue;
    }

    items.push({
      supplier_id: bill.supplier_id, supplier_name: bill.supplier_name,
      type: 'Vendor Bill', reference: bill.bill_no, id: bill.id,
      date: bill.date_created, due_date: bill.date_due, aging_date: bill.date_due || bill.date_created,
      original_amount: round2(payable), balance: round2(remaining),
      po_no: bill.po_no || null, ref_no: bill.reference_no || null, memo: bill.memo || null,
      location_name: bill.location_name || null,
      marked_paid_unevidenced: claimsPaid,
    });
  }

  for (const bc of credits) {
    const remaining = Number(bc.total_amount) - (appliedByCredit.get(bc.id) || 0) - (drawnByCredit.get(bc.id) || 0);
    if (remaining < 0.005) continue;
    items.push({
      supplier_id: bc.supplier_id, supplier_name: bc.supplier_name,
      type: 'Bill Credit', reference: bc.bill_credit_no, id: bc.id,
      date: bc.date_created, due_date: null, aging_date: bc.date_created,
      original_amount: round2(bc.total_amount), balance: round2(-remaining),
      po_no: null, ref_no: null, memo: bc.memo || null, location_name: bc.location_name || null,
      marked_paid_unevidenced: false,
    });
  }

  for (const bp of payments) {
    // A PAYMENT WITH NO LINES AT ALL HAS LOST ITS LINKS, IT IS NOT MONEY SITTING UNAPPLIED.
    // 3,564 of the 10,655 live bill payments on production -- PHP 69.6M -- arrived as headers
    // with no applications, the same unfinished migration that leaves 65% of bills claiming to
    // be paid with nothing recording it. Reading them as unapplied cash put PHP 66M of negative
    // balance into this report and turned the company's payables into MINUS 52.6M.
    //
    // They are excluded on the same terms as those bills, and counted in the open the same way:
    // both halves of one missing link, so the report cannot net a phantom credit against a
    // phantom debt and call the result a balance. Every payment that DOES carry lines is fully
    // applied by them (PHP 64,051,202.16 against PHP 64,051,202.16), so genuine unapplied cash
    // in this database is currently zero -- this is not hiding a real overpayment.
    if (!hasLines.has(bp.id)) {
      unlinkedPayments.count += 1;
      unlinkedPayments.amount += Number(bp.total_amount);
      if (!includeUnevidenced) continue;
    }
    const unapplied = Number(bp.total_amount) - (appliedByPayment.get(bp.id) || 0);
    if (unapplied < 0.005) continue;
    items.push({
      supplier_id: bp.supplier_id, supplier_name: bp.supplier_name,
      type: 'Unapplied Payment', reference: bp.bill_payment_no, id: bp.id,
      date: bp.date_created, due_date: null, aging_date: bp.date_created,
      original_amount: round2(bp.total_amount), balance: round2(-unapplied),
      po_no: null, ref_no: bp.reference_no || bp.check_no || null, memo: bp.memo || null,
      location_name: bp.location_name || null,
      marked_paid_unevidenced: false,
    });
  }

  return {
    items,
    unevidenced: { count: unevidenced.count, amount: round2(unevidenced.amount), included: includeUnevidenced },
    unlinked_payments: { count: unlinkedPayments.count, amount: round2(unlinkedPayments.amount), included: includeUnevidenced },
    header_disagreement: { count: headerDisagreement.count, amount: round2(headerDisagreement.amount) },
  };
}

async function buildApAging(asOf, filters = {}) {
  const {
    items, unevidenced, unlinked_payments: unlinkedPayments, header_disagreement: headerDisagreement,
  } = await collectOpenApItems(asOf, filters);

  const bySupplier = new Map();
  function supplierRow(id, name) {
    if (!bySupplier.has(id)) {
      bySupplier.set(id, { supplier_id: id, supplier_name: name, ...emptyBuckets(), unevidenced_count: 0, unevidenced_amount: 0 });
    }
    return bySupplier.get(id);
  }

  for (const item of items) {
    const row = supplierRow(item.supplier_id, item.supplier_name);
    addToBucket(row, item.balance, item.aging_date, asOf);
    if (item.marked_paid_unevidenced) {
      row.unevidenced_count += 1;
      row.unevidenced_amount += item.balance;
    }
  }

  const rows = [...bySupplier.values()]
    .map((r) => {
      const buckets = {
        current: round2(r.current), d1_30: round2(r.d1_30), d31_60: round2(r.d31_60),
        d61_90: round2(r.d61_90), over_90: round2(r.over_90),
      };
      const total = round2(buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.over_90);
      return {
        supplier_id: r.supplier_id, supplier_name: r.supplier_name, ...buckets, total_balance: total,
        unevidenced_count: r.unevidenced_count, unevidenced_amount: round2(r.unevidenced_amount),
      };
    })
    .filter((r) => Math.abs(r.total_balance) >= 0.005
      || [r.current, r.d1_30, r.d31_60, r.d61_90, r.over_90].some((v) => Math.abs(v) >= 0.005))
    .sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));

  const totals = rows.reduce((t, r) => ({
    current: t.current + r.current, d1_30: t.d1_30 + r.d1_30, d31_60: t.d31_60 + r.d31_60,
    d61_90: t.d61_90 + r.d61_90, over_90: t.over_90 + r.over_90, total_balance: t.total_balance + r.total_balance,
    unevidenced_count: t.unevidenced_count + r.unevidenced_count,
    unevidenced_amount: t.unevidenced_amount + r.unevidenced_amount,
  }), { ...emptyBuckets(), total_balance: 0, unevidenced_count: 0, unevidenced_amount: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });

  // Reported whether or not they are in the numbers, so the page can say what is being left out
  // as readily as what is being counted.
  return {
    as_of: asOf, rows, totals,
    excluded_unevidenced: unevidenced,
    excluded_unlinked_payments: unlinkedPayments,
    header_disagreement: headerDisagreement,
  };
}

// The DETAILS drill-down: the individual open items behind one vendor's balance. Same open-item
// function as the summary, so it cannot disagree with the row it was opened from.
async function buildApAgingSupplierDetails(supplierId, asOf, filters = {}) {
  const [[supplier]] = await pool.query('SELECT id, name FROM suppliers WHERE id = ?', [supplierId]);
  if (!supplier) return null;

  const { items } = await collectOpenApItems(asOf, { ...filters, supplierId });
  const sorted = items
    .map((i) => ({
      type: i.type, reference: i.reference, id: i.id, date: i.date, due_date: i.due_date,
      original_amount: i.original_amount, balance: i.balance,
      days_overdue: Math.max(daysBetween(i.aging_date, asOf), 0),
      po_no: i.po_no, ref_no: i.ref_no, memo: i.memo, location_name: i.location_name,
      marked_paid_unevidenced: i.marked_paid_unevidenced,
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.reference).localeCompare(String(b.reference)));

  return {
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    as_of: asOf,
    items: sorted,
    total_balance: round2(sorted.reduce((s, i) => s + i.balance, 0)),
  };
}

module.exports = { buildApAging, buildApAgingSupplierDetails, collectOpenApItems };
