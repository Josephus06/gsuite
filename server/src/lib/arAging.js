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
//
// MARKED PAID, NOT EVIDENCED. 1,363 invoices (about 1.9% of the 72,314 marked paid_in_full,
// 46.4M gross) carry status = 'paid_in_full' and amount_due = 0 while nothing in this database
// records a payment or credit memo settling them. Because this report derives from documents
// rather than trusting the header -- for the good reasons above -- it counts every one of them
// as outstanding, and the invoice screen says "Paid In Full" on the same document. Two screens,
// two answers, and no way for the reader to tell which is wrong.
//
// So the report now SAYS SO rather than silently picking a side. Such an item still counts in
// the balance -- hiding 46.4M of receivable on the strength of a flag with nothing behind it is
// the one thing that would be worse -- but it is flagged, counted separately, and the customer
// row carries the total, so Accounting gets a worklist instead of a mystery.
//
// It is not one bad migration batch: the affected invoices run 108 in 2021, 134 in 2022, 588 in
// 2023, 133 in 2024, 85 in 2025 and 315 in 2026. The mirror image is 2,143 payments holding
// 10.4M of unapplied cash -- some of these invoices are settled by that money, with the link
// between them never imported.

// How much of a payment is still sitting on account as unapplied cash.
//
// Two sources, because the migration left customer payments in two different states:
//
//   with application lines -> measured from them, as this report always did. This covers the
//     reconstructed CPAY-INV-#### payments generate-invoice-payments.js created, which do
//     carry lines.
//
//   without any lines -> taken from the unapplied_amount the LIVE system itself reported at
//     import time (stored by import-customer-payments.js). The live API exposes no endpoint
//     returning WHICH invoices a payment settled -- see that importer's header -- so ~58,700
//     real PAY-#### payments arrived as headers only. Deriving their unapplied figure from
//     lines that were never imported reported every one of them as 100% unapplied cash: about
//     460M of settled receivable resurfacing as credit, which is what drove customers to large
//     negative balances (23 APPLES INC. showed -901,898.17, exactly the sum of its real
//     payments).
//
// Trusting the header here does not leave an invoice looking unpaid: the invoices those real
// payments settled are already discharged locally by the reconstructed CPAY-INV-#### payments,
// which is precisely why those were generated. It does mean this report cannot say WHICH
// invoice a real payment settled -- that needs the lines themselves, and they do not exist yet.
// An invoice whose header says it is settled. Both signals are checked rather than status
// alone: the migration set them together, and an invoice can be discharged to zero without the
// status keeping up. Either one claiming 'settled' is enough to make silence about a payment
// worth flagging.
function isMarkedPaid(inv) {
  return String(inv.status || '').toLowerCase() === 'paid_in_full'
    || Math.abs(Number(inv.amount_due || 0)) < 0.005;
}

function unappliedCash(payment, cashAppliedFromLines) {
  if (cashAppliedFromLines !== null && cashAppliedFromLines !== undefined) {
    return Number(payment.payment_amount) - Number(cashAppliedFromLines);
  }
  // A header-only payment whose live unapplied figure never came across is treated as fully
  // unapplied, the old behaviour -- better to over-report a credit than to silently drop one.
  if (payment.unapplied_amount === null || payment.unapplied_amount === undefined) {
    return Number(payment.payment_amount);
  }
  return Number(payment.unapplied_amount);
}

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

// EVERY OPEN ITEM AS OF A DATE, in one place.
//
// Both reports built on this file are the same set of facts shown at two grains: AR Aging sums
// these items into buckets per customer, AR Aging Details lists them. They used to be separate
// query sets, which is a standing invitation for a detail report that does not add up to the
// summary it details -- the one thing that makes both useless. So the items are computed once
// here and each report presents them.
//
// The signed convention is the same throughout: positive = the customer owes us.
//
// The display fields (BS #, memo, PO #, location) are along for the ride. They cost nothing on
// queries that were already reading these rows, and the Details report needs them.
async function collectOpenItems(asOf, filters = {}) {
  const { nameStarts, customerId } = filters;
  const nameClause = nameStarts ? ' AND c.name LIKE ?' : '';
  const nameParam = nameStarts ? [`${nameStarts}%`] : [];
  const custClause = customerId ? ' AND c.id = ?' : '';
  const custParam = customerId ? [customerId] : [];

  const invLoc = locationClause('si', filters);
  const [invoices] = await pool.query(
    `SELECT si.id, c.id AS customer_id, c.name AS customer_name, si.date_created, si.date_due, si.gross_amount,
            si.status, si.amount_due, si.invoice_no, si.bs_si_no, si.po_no, si.memo,
            loc.location_name
     FROM sales_invoices si
     LEFT JOIN sales_orders so ON so.id = si.sales_order_id
     LEFT JOIN estimates e ON e.id = si.estimate_id
     JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id)
     LEFT JOIN locations loc ON loc.id = si.office_location_id
     WHERE si.status != 'cancelled' AND si.date_created <= ?${invLoc.sql}${nameClause}${custClause}`,
    [asOf, ...invLoc.params, ...nameParam, ...custParam]
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
    `SELECT cm.id, cm.customer_id, c.name AS customer_name, cm.date_created, cm.gross_amount,
            cm.credit_memo_no, cm.memo, loc.location_name
     FROM credit_memos cm
     JOIN customers c ON c.id = cm.customer_id
     LEFT JOIN locations loc ON loc.id = cm.office_location_id
     WHERE cm.status != 'voided' AND cm.date_created <= ?${memoLoc.sql}${nameClause}${custClause}`,
    [asOf, ...memoLoc.params, ...nameParam, ...custParam]
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
    `SELECT cp.id, cp.customer_id, c.name AS customer_name, cp.date_created, cp.payment_amount,
            cp.unapplied_amount, cp.customer_payment_no, cp.memo, cp.or_no, loc.location_name
     FROM customer_payments cp
     JOIN customers c ON c.id = cp.customer_id
     LEFT JOIN locations loc ON loc.id = cp.office_location_id
     WHERE cp.status != 'voided' AND cp.date_created <= ?${payLoc.sql}${nameClause}${custClause}`,
    [asOf, ...payLoc.params, ...nameParam, ...custParam]
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

  // One row per still-open document. `aging_date` is what the age is measured from and the
  // bucket chosen by: an invoice ages from its DUE date, a credit or an overpayment has no due
  // date and ages from its own.
  const items = [];

  for (const inv of invoices) {
    const settled = (paidByInvoice.get(inv.id) || 0) + (creditedByInvoice.get(inv.id) || 0);
    const remaining = Number(inv.gross_amount) - settled;
    if (Math.abs(remaining) < 0.005) continue;
    items.push({
      customer_id: inv.customer_id, customer_name: inv.customer_name,
      type: 'Invoice', reference: inv.invoice_no, id: inv.id,
      date: inv.date_created, due_date: inv.date_due, aging_date: inv.date_due || inv.date_created,
      original_amount: round2(inv.gross_amount), balance: round2(remaining),
      bs_no: inv.bs_si_no || null, po_no: inv.po_no || null, memo: inv.memo || null,
      location_name: inv.location_name || null,
      // The invoice header insists it is settled and nothing in the data agrees. Carried on the
      // item so the customer row can show how much of its balance rests on that disagreement.
      marked_paid_unevidenced: isMarkedPaid(inv) && settled < 0.005,
    });
  }
  for (const cm of memos) {
    const remaining = Number(cm.gross_amount) - (appliedByMemo.get(cm.id) || 0) - (drawnByMemo.get(cm.id) || 0);
    if (remaining < 0.005) continue;
    items.push({
      customer_id: cm.customer_id, customer_name: cm.customer_name,
      type: 'Credit Memo', reference: cm.credit_memo_no, id: cm.id,
      date: cm.date_created, due_date: null, aging_date: cm.date_created,
      original_amount: round2(cm.gross_amount), balance: round2(-remaining),
      bs_no: null, po_no: null, memo: cm.memo || null, location_name: cm.location_name || null,
      marked_paid_unevidenced: false,
    });
  }
  for (const cp of payments) {
    // .has(), not `|| 0` -- only payments that actually have lines appear in this map, so this
    // is what separates "applied nothing" from "its lines were never imported".
    const unapplied = unappliedCash(cp, cashAppliedByPayment.has(cp.id) ? cashAppliedByPayment.get(cp.id) : null);
    if (unapplied < 0.005) continue;
    items.push({
      customer_id: cp.customer_id, customer_name: cp.customer_name,
      type: 'Unapplied Payment', reference: cp.customer_payment_no, id: cp.id,
      date: cp.date_created, due_date: null, aging_date: cp.date_created,
      original_amount: round2(cp.payment_amount), balance: round2(-unapplied),
      // The OR number is the reference a collector actually quotes on the phone, and the memo
      // column is where the real report shows it when the payment carries no memo of its own.
      bs_no: null, po_no: null, memo: cp.memo || (cp.or_no ? `OR# ${cp.or_no}` : null),
      location_name: cp.location_name || null,
      marked_paid_unevidenced: false,
    });
  }

  return items;
}

async function buildArAging(asOf, filters = {}) {
  const items = await collectOpenItems(asOf, filters);

  // Accumulate every contribution into per-customer buckets.
  const byCustomer = new Map();
  function customerRow(id, name) {
    if (!byCustomer.has(id)) {
      byCustomer.set(id, { customer_id: id, customer_name: name, ...emptyBuckets(), unevidenced_count: 0, unevidenced_amount: 0 });
    }
    return byCustomer.get(id);
  }

  for (const item of items) {
    const row = customerRow(item.customer_id, item.customer_name);
    addToBucket(row, item.balance, item.aging_date, asOf);
    if (item.marked_paid_unevidenced) {
      row.unevidenced_count += 1;
      row.unevidenced_amount += item.balance;
    }
  }

  const rows = [...byCustomer.values()]
    .map((r) => {
      const buckets = {
        current: round2(r.current), d1_30: round2(r.d1_30), d31_60: round2(r.d31_60),
        d61_90: round2(r.d61_90), over_90: round2(r.over_90),
      };
      const total = round2(buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.over_90);
      return {
        customer_id: r.customer_id, customer_name: r.customer_name, ...buckets, total_balance: total,
        unevidenced_count: r.unevidenced_count,
        unevidenced_amount: round2(r.unevidenced_amount),
      };
    })
    // A customer with everything netted to zero isn't outstanding -- drop it, same as the
    // real report only listing customers with a balance.
    .filter((r) => Math.abs(r.total_balance) >= 0.005
      || [r.current, r.d1_30, r.d31_60, r.d61_90, r.over_90].some((v) => Math.abs(v) >= 0.005))
    .sort((a, b) => a.customer_name.localeCompare(b.customer_name));

  const totals = rows.reduce((t, r) => ({
    current: t.current + r.current, d1_30: t.d1_30 + r.d1_30, d31_60: t.d31_60 + r.d31_60,
    d61_90: t.d61_90 + r.d61_90, over_90: t.over_90 + r.over_90, total_balance: t.total_balance + r.total_balance,
    unevidenced_count: t.unevidenced_count + r.unevidenced_count,
    unevidenced_amount: t.unevidenced_amount + r.unevidenced_amount,
  }), { ...emptyBuckets(), total_balance: 0, unevidenced_count: 0, unevidenced_amount: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });

  return { as_of: asOf, rows, totals };
}

// AR Aging Details (Accounting > Reports > AR Aging Details). The same open items AR Aging
// buckets, listed instead of summed: one group per customer, one row per document, with the
// age and the open balance it contributes. Because both reports read collectOpenItems, a
// customer's rows here always add up to that customer's Total Balance on the summary -- the
// two cannot drift apart.
//
// AGE is measured from the aging date, which is the DUE date for an invoice and the document
// date for a credit memo or an unapplied payment. Not clamped at zero: an invoice not yet due
// ages negative, and "-12" says something a floor of 0 would hide.
//
// PAGED BY CUSTOMER, not by row. A page that cut a customer in half would show a group whose
// rows do not add up to its own heading, which is the one thing this report exists to avoid.
const DETAILS_DEFAULT_PAGE_SIZE = 25;
const DETAILS_MAX_PAGE_SIZE = 200;

function groupItemsByCustomer(items, asOf) {
  const byCustomer = new Map();
  for (const item of items) {
    if (!byCustomer.has(item.customer_id)) {
      byCustomer.set(item.customer_id, {
        customer_id: item.customer_id, customer_name: item.customer_name, items: [], total_balance: 0,
      });
    }
    const group = byCustomer.get(item.customer_id);
    group.items.push({
      type: item.type,
      trans_date: item.date,
      trans_no: item.reference,
      id: item.id,
      bs_no: item.bs_no,
      memo: item.memo,
      po_no: item.po_no,
      date_due: item.due_date,
      age: daysBetween(item.aging_date, asOf),
      open_balance: item.balance,
      location_name: item.location_name,
      marked_paid_unevidenced: item.marked_paid_unevidenced,
    });
    group.total_balance += item.balance;
  }

  return [...byCustomer.values()]
    .map((g) => ({
      ...g,
      total_balance: round2(g.total_balance),
      items: g.items.sort((a, b) => String(a.trans_date).localeCompare(String(b.trans_date))
        || String(a.trans_no).localeCompare(String(b.trans_no))),
    }))
    // Same rule as the summary: a customer whose items net to nothing is not outstanding. Kept
    // when the items themselves are non-zero, so a customer holding an invoice and an equal
    // credit still shows both rows rather than vanishing.
    .filter((g) => Math.abs(g.total_balance) >= 0.005 || g.items.length > 0)
    .sort((a, b) => a.customer_name.localeCompare(b.customer_name));
}

async function buildArAgingDetails(asOf, filters = {}) {
  const items = await collectOpenItems(asOf, filters);
  const groups = groupItemsByCustomer(items, asOf);

  const limit = Math.min(DETAILS_MAX_PAGE_SIZE, Math.max(1, Number(filters.limit) || DETAILS_DEFAULT_PAGE_SIZE));
  const page = Math.max(1, Number(filters.page) || 1);
  const pageGroups = groups.slice((page - 1) * limit, page * limit);

  // Totals are over the WHOLE filtered set, not the page: the items were all computed anyway,
  // and a receivable report whose total moves when you turn the page is not a total.
  const totals = {
    open_balance: round2(groups.reduce((s, g) => s + g.total_balance, 0)),
    customer_count: groups.length,
    item_count: groups.reduce((s, g) => s + g.items.length, 0),
    unevidenced_count: items.filter((i) => i.marked_paid_unevidenced).length,
    // The one place this report's customer count can differ from AR Aging's, counted so the page
    // can say why rather than leaving a silent difference for someone to find by subtraction.
    // A customer whose open documents cancel out exactly -- an invoice and a credit of the same
    // size -- has no AR Aging row, because every bucket is zero. It keeps its rows here: a
    // balance of zero reached by holding two live documents is precisely what someone chasing
    // receivables needs to see, and there were 6 such customers on production at 2026-09-22.
    zero_net_customer_count: groups.filter((g) => Math.abs(g.total_balance) < 0.005).length,
  };
  const pageTotal = round2(pageGroups.reduce((s, g) => s + g.total_balance, 0));

  return {
    as_of: asOf,
    rows: pageGroups,
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(groups.length / limit)),
    page_total: pageTotal,
    totals,
  };
}

// The whole filtered set, flat, one row per document with its customer repeated -- the shape a
// spreadsheet can sort and pivot. No page limit: this report's cost is the scan that already
// happened, so paging the export would only make someone run it five times.
async function buildArAgingDetailsCsv(asOf, filters = {}) {
  const items = await collectOpenItems(asOf, filters);
  const groups = groupItemsByCustomer(items, asOf);

  const header = ['Customer', 'Trans Date', 'Trans #', 'BS #', 'Memo', 'PO #', 'Date Due', 'Age', 'Open Balance', 'Location'];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Excel reads a leading = + - @ as a formula. Note this deliberately does NOT touch the
    // money column, which is written by `money` below and may legitimately start with a minus.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const money = (v) => Number(v).toFixed(2);
  const day = (v) => (v ? String(v).slice(0, 10) : '');

  const out = [header.join(',')];
  for (const g of groups) {
    for (const it of g.items) {
      out.push([
        cell(g.customer_name), day(it.trans_date), cell(it.trans_no), cell(it.bs_no), cell(it.memo),
        cell(it.po_no), day(it.date_due), it.age, money(it.open_balance), cell(it.location_name),
      ].join(','));
    }
    out.push([cell(`${g.customer_name} -- total`), '', '', '', '', '', '', '', money(g.total_balance), ''].join(','));
  }
  return { csv: out.join('\n'), customers: groups.length, items: items.length };
}

// Typeahead for the Details report's Customer filter. Capped, and limited to customers that
// have AR history at all -- /customers returns all 21,562 rows and a receivables filter has no
// use for a customer who has never been billed.
async function searchArCustomers(term) {
  const q = `%${String(term || '').trim()}%`;
  const [rows] = await pool.query(
    `SELECT c.id, c.name
       FROM customers c
      WHERE c.name LIKE ?
        AND (EXISTS (SELECT 1 FROM sales_orders so JOIN sales_invoices si ON si.sales_order_id = so.id
                      WHERE so.customer_id = c.id)
          OR EXISTS (SELECT 1 FROM customer_payments cp WHERE cp.customer_id = c.id)
          OR EXISTS (SELECT 1 FROM credit_memos cm WHERE cm.customer_id = c.id))
      ORDER BY c.name
      LIMIT 25`,
    [q],
  );
  return rows;
}

// The DETAILS drill-down: the individual open items making up one customer's balance, each
// with its own remaining and bucket -- what the aging row is the sum of.
async function buildArAgingCustomerDetails(customerId, asOf) {
  const [[customer]] = await pool.query('SELECT id, name FROM customers WHERE id = ?', [customerId]);
  if (!customer) return null;

  const [invoices] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.gross_amount,
            si.status, si.amount_due,
            COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                      JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                      WHERE cpl.sales_invoice_id = si.id AND cp.status != 'voided' AND cp.date_created <= ?), 0)
            + COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma
                        JOIN credit_memos cm ON cm.id = cma.credit_memo_id
                        WHERE cma.sales_invoice_id = si.id AND cm.status != 'voided' AND cm.date_created <= ?), 0) AS settled
     FROM sales_invoices si
     LEFT JOIN sales_orders so ON so.id = si.sales_order_id
     LEFT JOIN estimates e ON e.id = si.estimate_id
     WHERE COALESCE(so.customer_id, e.customer_id) = ? AND si.status != 'cancelled' AND si.date_created <= ?`,
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
      // Why this line and the invoice screen disagree, said on the line itself.
      marked_paid_unevidenced: isMarkedPaid(inv) && Number(inv.settled) < 0.005,
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
    `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount, cp.unapplied_amount,
            COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                      WHERE cpl.customer_payment_id = cp.id AND cpl.sales_invoice_id IS NOT NULL), 0) AS cash_applied,
            (SELECT COUNT(*) FROM customer_payment_lines cpl WHERE cpl.customer_payment_id = cp.id) AS line_count
     FROM customer_payments cp
     WHERE cp.customer_id = ? AND cp.status != 'voided' AND cp.date_created <= ?`,
    [customerId, asOf]
  );
  for (const cp of payments) {
    // The COUNT is what the SUM cannot tell us: it returns 0 both for a payment that applied
    // nothing and for one whose lines were never imported, and those need opposite treatment.
    const unapplied = unappliedCash(cp, Number(cp.line_count) > 0 ? cp.cash_applied : null);
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
     FROM sales_invoices si
     LEFT JOIN sales_orders so ON so.id = si.sales_order_id
     LEFT JOIN estimates e ON e.id = si.estimate_id
     WHERE COALESCE(so.customer_id, e.customer_id) = ? AND si.status != 'cancelled' AND si.date_created <= ?`,
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

module.exports = {
  buildArAging, buildArAgingCustomerDetails, buildArAgingCustomerLedger,
  buildArAgingDetails, buildArAgingDetailsCsv, searchArCustomers,
};
