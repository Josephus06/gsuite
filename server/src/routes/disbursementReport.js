const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Every disbursement that left the company in a date range -- Cheques and Bill Payments together,
// on the day the money was RELEASED rather than the day the document was raised. Those are
// different days by design: a payment is prepared, approved, and only then handed over.
//
// Its own permission page rather than borrowing Cheques' or Bill Payments'. This lists what was
// paid to whom across both, which is the treasurer's and the auditor's question; being able to
// read that is not the same right as being able to raise a payment.
const ROUTE = '/reports/disbursement';

// THE TWO SOURCES DO NOT OVERLAP. Checked before unioning them: of 868 bill payments, ZERO carry a
// check_no that matches any cheque's cheque_number, so the same disbursement cannot appear twice.
// They are separate populations -- cheques are raised directly, bill payments settle vendor bills.
//
// Voided is excluded on both sides. A voided cheque never left the building, and a report of money
// paid out that counts them overstates the period. The two tables spell it differently -- cheques
// use 'void', bill_payments use 'voided' -- which is why this is not one shared constant.
//
// Asked 2026-11-23: advance cheques marked as such (a line on 13100 Advances To Suppliers), Fund
// Transfers as a third source, an EWT column, and for each supplier payment with EWT whether its
// 2307 has been released (enrich() below).
const ADVANCE_ACCOUNT = '13100';
const SELECT_SQL = `
  SELECT 'Cheque' AS source, c.date_released, c.payee_name AS payee, c.date_created,
         c.cheque_number AS cheque_no, c.memo,
         coa.account_code, coa.account_name,
         c.total_amount AS amount, c.cheque_no AS doc_no,
         -- Who was paid, for the Supplier / Employee filter: a cheque names its payee's kind.
         CASE WHEN c.payee_type IN ('VENDOR', 'supplier') THEN 'supplier'
              WHEN c.payee_type = 'EMPLOYEE' THEN 'employee'
              WHEN c.payee_type = 'CUSTOMER' THEN 'customer' END AS payee_kind,
         c.payee_id, c.id AS doc_id, COALESCE(c.withholding_tax_amount, 0) AS ewt,
         EXISTS (SELECT 1 FROM cheque_lines cl JOIN chart_of_accounts a ON a.id = cl.account_id
                  WHERE cl.cheque_id = c.id AND a.account_code = '${ADVANCE_ACCOUNT}' AND cl.amount > 0) AS is_advance
    FROM cheques c
    LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
   WHERE c.date_released IS NOT NULL AND c.status <> 'void'
     AND c.date_released BETWEEN ? AND ?

  UNION ALL

  -- The BANK account, not the A/P account: a disbursement report is about which account the money
  -- came out of. ap_account_id is the liability being settled, which is a different question.
  -- EWT: each bill paid contributes its withholding in the share of it this payment settles (the
  -- payment is net of withholding, so applied / (gross - withholding)).
  SELECT 'Bill Payment', bp.date_released, bp.payee_name, bp.date_created,
         bp.check_no, bp.memo,
         coa2.account_code, coa2.account_name,
         bp.total_amount, bp.bill_payment_no,
         -- A bill payment always settles a supplier's bills.
         'supplier', bp.supplier_id, bp.id,
         COALESCE((SELECT SUM(LEAST(1, bpl.applied_amount / NULLIF(vb.gross_amount - vb.wtax_amount, 0)) * vb.wtax_amount)
                     FROM bill_payment_lines bpl JOIN vendor_bills vb ON vb.id = bpl.vendor_bill_id
                    WHERE bpl.bill_payment_id = bp.id AND vb.wtax_amount > 0), 0),
         0
    FROM bill_payments bp
    LEFT JOIN chart_of_accounts coa2 ON coa2.id = bp.bank_account_id
   WHERE bp.date_released IS NOT NULL AND bp.status <> 'voided'
     AND bp.date_released BETWEEN ? AND ?

  UNION ALL

  -- Fund Transfers (2026-11-23): money moved out of one company account into another, on its date
  -- (a transfer has no separate release date). Account = the account it came out of; Payee = where
  -- it went.
  SELECT 'Fund Transfer', ft.date_created, CONCAT('Transfer to ', COALESCE(CONCAT(toa.account_code, ' ', toa.account_name), '?')),
         ft.date_created, NULL, ft.memo,
         froma.account_code, froma.account_name,
         ft.amount, ft.ft_no,
         NULL, NULL, ft.id, 0, 0
    FROM fund_transfers ft
    LEFT JOIN chart_of_accounts froma ON froma.id = ft.from_account_id
    LEFT JOIN chart_of_accounts toa ON toa.id = ft.to_account_id
   WHERE ft.status <> 'void' AND ft.date_created BETWEEN ? AND ?
`;

const TYPES = ['Cheque', 'Advance Cheque', 'Bill Payment', 'Fund Transfer'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);
const quarterKey = (d) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

// Type, EWT for advances, and the 2307 status of each supplier payment with EWT.
//   Advance cheque EWT: none is recorded on an advance (it is paid net of the supplier's
//     withholding). Still unbilled -> the same estimate BIR 2307 to Suppliers uses (routes/birReports
//     advanceChequeDocs); billed -> the bills' withholding, in the share the cheque's applied bill
//     credits settled.
//   2307: Released when a 2307 issued for the payee (supplier_2307_issuances) covers one of the
//     payment's documents -- the cheque itself, or the bills it / its bill credits paid -- in that
//     document's quarter: issued for all the quarter's documents (doc_refs empty) or naming it.
async function enrich(rows) {
  for (const r of rows) {
    r.type = r.source === 'Cheque' && Number(r.is_advance) ? 'Advance Cheque' : r.source;
    r.ewt = r2(r.ewt);
    r.ewt_estimated = false;
    r.bir_2307 = null;
  }
  const advances = rows.filter((r) => r.type === 'Advance Cheque' && !r.ewt && r.payee_kind === 'supplier');
  const chequeIds = rows.filter((r) => r.source === 'Cheque').map((r) => Number(r.doc_id));
  const bpIds = rows.filter((r) => r.source === 'Bill Payment').map((r) => Number(r.doc_id));

  // Bills behind each payment: a bill payment's own lines; a cheque's applied bill credits.
  const billsOf = new Map(); // "Cheque-1" / "Bill Payment-2" -> [{ id, bill_no, ymd, share }]
  const push = (k, b) => { if (!billsOf.has(k)) billsOf.set(k, []); billsOf.get(k).push(b); };
  if (chequeIds.length) {
    const [rs] = await pool.query(
      `SELECT cbc.cheque_id, vb.id, vb.bill_no, DATE_FORMAT(vb.date_created, '%Y-%m-%d') AS ymd, vb.wtax_amount,
              LEAST(1, COALESCE(bca.applied_amount, cbc.applied_amount) / NULLIF(vb.gross_amount - vb.wtax_amount, 0)) AS share
         FROM cheque_bill_credits cbc
         JOIN bill_credits bc ON bc.id = cbc.bill_credit_id AND bc.status <> 'void'
         LEFT JOIN bill_credit_applications bca ON bca.bill_credit_id = bc.id
         JOIN vendor_bills vb ON vb.id = COALESCE(bca.vendor_bill_id, bc.vendor_bill_id)
        WHERE cbc.cheque_id IN (?) AND vb.status <> 'cancelled' AND vb.wtax_amount > 0`, [chequeIds]);
    for (const b of rs) push(`Cheque-${b.cheque_id}`, b);
  }
  if (bpIds.length) {
    const [rs] = await pool.query(
      `SELECT bpl.bill_payment_id, vb.id, vb.bill_no, DATE_FORMAT(vb.date_created, '%Y-%m-%d') AS ymd, vb.wtax_amount
         FROM bill_payment_lines bpl JOIN vendor_bills vb ON vb.id = bpl.vendor_bill_id
        WHERE bpl.bill_payment_id IN (?) AND vb.wtax_amount > 0`, [bpIds]);
    for (const b of rs) push(`Bill Payment-${b.bill_payment_id}`, b);
  }

  // Advance EWT: the 2307's own estimate while unbilled, else the billed share.
  if (advances.length) {
    const dates = advances.map((r) => ymd(r.date_created)).sort();
    const { withheldDocs } = require('./birReports').helpers;
    const est = new Map((await withheldDocs(dates[0], dates[dates.length - 1]))
      .filter((d) => d.doc_type === 'Advance Cheque').map((d) => [Number(d.id), d.wtax_amount]));
    for (const r of advances) {
      if (est.has(Number(r.doc_id))) { r.ewt = r2(est.get(Number(r.doc_id))); r.ewt_estimated = true; continue; }
      const bills = billsOf.get(`Cheque-${r.doc_id}`) || [];
      r.ewt = r2(bills.reduce((s, b) => s + Number(b.wtax_amount) * Number(b.share || 0), 0));
    }
  }

  // 2307 status.
  const withEwt = rows.filter((r) => r.ewt > 0 && r.payee_kind === 'supplier' && r.payee_id);
  if (!withEwt.length) return rows;
  const [issued] = await pool.query(
    `SELECT payee_key, quarter, doc_refs, issued_at FROM supplier_2307_issuances
      WHERE payee_key IN (?) ORDER BY issued_at`, [[...new Set(withEwt.map((r) => `s${r.payee_id}`))]]);
  const covers = (key, quarter, docNo) => issued.find((i) => i.payee_key === key && i.quarter === quarter
    && (!i.doc_refs || String(i.doc_refs).split(/\s*,\s*/).includes(docNo)));
  for (const r of withEwt) {
    const key = `s${r.payee_id}`;
    const docs = (billsOf.get(`${r.source}-${r.doc_id}`) || []).map((b) => ({ no: b.bill_no, q: quarterKey(b.ymd) }));
    if (r.source === 'Cheque') docs.unshift({ no: r.doc_no, q: quarterKey(ymd(r.date_created)) });
    const hit = docs.map((d) => covers(key, d.q, d.no)).find(Boolean);
    r.bir_2307 = hit ? { released: true, issued_at: hit.issued_at } : { released: false };
  }
  return rows;
}

function range(query) {
  const today = new Date().toISOString().slice(0, 10);
  const from = String(query.from || '').slice(0, 10) || today;
  const to = String(query.to || '').slice(0, 10) || today;
  // Swapped dates would silently return nothing; answering the range they meant is kinder than
  // an empty report that looks like "nothing was paid".
  return from <= to ? { from, to } : { from: to, to: from };
}

// Supplier / Employee filter (asked 2026-10-02): payee_type narrows to one kind, payee_id to one
// supplier or employee within it. 115 employee cheques carry only a typed payee name and no
// employee id, so they show under Employee but never under one chosen employee.
const PAYEE_KINDS = ['supplier', 'employee', 'customer'];
function payeeFilter(query) {
  const kind = PAYEE_KINDS.includes(String(query.payee_type)) ? String(query.payee_type) : null;
  const id = kind && Number(query.payee_id) > 0 ? Number(query.payee_id) : null;
  return { kind, id };
}

async function fetchRows({ from, to }, { kind, id } = {}, type = '') {
  const where = [];
  const params = [from, to, from, to, from, to];
  if (kind) { where.push('d.payee_kind = ?'); params.push(kind); }
  if (id) { where.push('d.payee_id = ?'); params.push(id); }
  const [rows] = await pool.query(
    `SELECT * FROM (${SELECT_SQL}) d ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.date_released, d.payee, d.cheque_no`,
    params,
  );
  const out = await enrich(rows);
  return TYPES.includes(type) ? out.filter((r) => r.type === type) : out;
}

// How much of the picture is missing. A bill payment or cheque with no Date Released has not been
// released as far as this system knows, so it is correctly absent -- but someone reconciling a month
// needs to be told that rather than left to assume the report is complete. (Not every cheque carries
// one: 321 did not on 2026-11-23, 174 of them advances.)
async function pendingCount() {
  const [[r]] = await pool.query(
    "SELECT COUNT(*) AS n FROM bill_payments WHERE date_released IS NULL AND status <> 'voided'",
  );
  return Number(r.n) || 0;
}
async function pendingChequeCount() {
  const [[r]] = await pool.query("SELECT COUNT(*) AS n FROM cheques WHERE date_released IS NULL AND status <> 'void'");
  return Number(r.n) || 0;
}

// The Payee picker: only suppliers / employees who have actually been paid by cheque or bill
// payment, so the list is short and nothing in it returns an empty report. Under the report's own
// permission -- a treasurer reading this need not hold the Suppliers or Employees master lists.
router.get('/payees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const kind = String(req.query.type);
    let rows;
    if (kind === 'supplier') {
      [rows] = await pool.query(
        `SELECT s.id, s.name FROM suppliers s
          WHERE s.id IN (SELECT payee_id FROM cheques WHERE payee_type IN ('VENDOR', 'supplier') AND payee_id IS NOT NULL)
             OR s.id IN (SELECT supplier_id FROM bill_payments WHERE supplier_id IS NOT NULL)
          ORDER BY s.name`);
    } else if (kind === 'employee') {
      [rows] = await pool.query(
        `SELECT e.id, TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS name FROM employees e
          WHERE e.id IN (SELECT payee_id FROM cheques WHERE payee_type = 'EMPLOYEE' AND payee_id IS NOT NULL)
          ORDER BY e.first_name, e.last_name`);
    } else {
      return res.status(400).json({ error: 'type must be supplier or employee' });
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const rows = await fetchRows({ from, to }, payeeFilter(req.query), String(req.query.type || ''));
    res.json({
      from,
      to,
      rows,
      total_amount: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      total_ewt: r2(rows.reduce((s, r) => s + Number(r.ewt || 0), 0)),
      bill_payments_without_release_date: await pendingCount(),
      cheques_without_release_date: await pendingChequeCount(),
    });
  } catch (err) {
    next(err);
  }
});

// Dates are written as plain YYYY-MM-DD TEXT rather than Excel dates, the same choice
// lib/artistIncentiveWorkbook.js documents: an Excel date is a timezone-less serial filled from a
// JS Date, and every conversion in that chain is a chance to land on the previous day. The report
// only ever shows the day, and YYYY-MM-DD sorts correctly as text.
const day = (v) => (v ? String(v).slice(0, 10) : '');

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const rows = await fetchRows({ from, to }, payeeFilter(req.query), String(req.query.type || ''));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Disbursement');

    // The six columns asked for, in that order. Source and Amount follow them rather than
    // replacing any: a reader needs to know whether a line was a cheque or a bill payment, and a
    // disbursement report nobody can total is half a report.
    ws.columns = [
      { header: 'Date released', key: 'date_released', width: 14 },
      { header: 'Payee', key: 'payee', width: 38 },
      { header: 'Date Created', key: 'date_created', width: 14 },
      { header: 'Cheque No.', key: 'cheque_no', width: 16 },
      { header: 'Account', key: 'account', width: 34 },
      { header: 'Memo', key: 'memo', width: 60 },
      { header: 'Type', key: 'type', width: 16 },
      { header: 'Document No.', key: 'doc_no', width: 16 },
      { header: 'Amount', key: 'amount', width: 15 },
      { header: 'EWT', key: 'ewt', width: 13 },
      { header: '2307', key: 'bir_2307', width: 24 },
    ];
    ws.getRow(1).font = { bold: true };

    rows.forEach((r) => {
      ws.addRow({
        date_released: day(r.date_released),
        payee: r.payee || '',
        date_created: day(r.date_created),
        cheque_no: r.cheque_no || '',
        account: r.account_code ? `${r.account_code} — ${r.account_name}` : (r.account_name || ''),
        memo: r.memo || '',
        type: r.type,
        doc_no: r.doc_no || '',
        // A number with a display format, never a preformatted string: the first thing anyone
        // does to a disbursement sheet is total the column.
        amount: Number(r.amount || 0),
        ewt: Number(r.ewt || 0),
        bir_2307: !r.bir_2307 ? '' : r.bir_2307.released
          ? `Released ${day(r.bir_2307.issued_at instanceof Date ? r.bir_2307.issued_at.toISOString() : r.bir_2307.issued_at)}`
          : 'Not yet released',
      });
    });
    ws.getColumn('amount').numFmt = '#,##0.00';
    ws.getColumn('ewt').numFmt = '#,##0.00';
    ws.autoFilter = { from: 'A1', to: `K${rows.length + 1}` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="disbursement-${from}-to-${to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
