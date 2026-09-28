// T1S's books start from the source system's closing position (src/db/create-opening-balances.js,
// loaded by src/db/load-opening-balances.js). This is the one place reports ask about it.
//
// booksStart() -> null when no opening is loaded (every report then behaves exactly as before),
// otherwise { asOf: '2025-12-31', start: '2026-01-01' }. Read per call rather than cached: a load
// or reload has to take effect on the next report without a restart, and it is one tiny query.
const pool = require('../db');

async function booksStart() {
  try {
    const [[r]] = await pool.query("SELECT DATE_FORMAT(MAX(as_of), '%Y-%m-%d') AS as_of FROM opening_gl_balances");
    if (!r || !r.as_of) return null;
    const d = new Date(`${r.as_of}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return { asOf: r.as_of, start: d.toISOString().slice(0, 10) };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return null; // deployed ahead of its schema script
    throw e;
  }
}

// The opening balance of every account as GL lines dated the as-of day, shaped like the rows
// lib/glImpact.js getPostedGlLines returns.
async function openingGlLines(asOf) {
  const [rows] = await pool.query(
    `SELECT ob.account_code, coa.account_name, ob.debit, ob.credit, ob.note
       FROM opening_gl_balances ob JOIN chart_of_accounts coa ON coa.id = ob.account_id
      WHERE ob.as_of = ?`, [asOf],
  );
  return rows.map((r) => ({
    account_code: r.account_code,
    account_name: r.account_name,
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
    entry_date: asOf,
    source_type: 'opening_balance',
    source_no: `OPENING-${asOf}`,
    source_id: null,
    memo: r.note || 'Opening balance carried from the source system',
    location_id: null,
    department_id: null,
  }));
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// The customer (AR) or supplier (AP) documents that were open at the books start, each reduced by
// whatever T1S has settled against it SINCE then -- a 2026 payment or credit memo applied to the
// invoice / bill it links to. An opening item with no T1S document to link to (a journal, a bill
// that was never migrated) keeps its opening balance until it is dealt with.
//
// Returned in the same shape lib/arAging.js / lib/apAging.js build their open items, so the
// agings just append them after dropping their own pre-start documents.
const SIDES = {
  ar: {
    table: 'opening_ar_items', party: 'customer_id', partyTable: 'customers', link: 'sales_invoice_id', linkType: 'Invoice',
    settled: `SELECT x.id, SUM(x.amt) AS amt FROM (
                SELECT cpl.sales_invoice_id AS id, cpl.applied_amount AS amt
                  FROM customer_payment_lines cpl JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                 WHERE cpl.sales_invoice_id IN (?) AND cp.status != 'voided' AND cp.date_created >= ? AND cp.date_created <= ?
                UNION ALL
                SELECT cma.sales_invoice_id, cma.applied_amount
                  FROM credit_memo_applications cma JOIN credit_memos cm ON cm.id = cma.credit_memo_id
                 WHERE cma.sales_invoice_id IN (?) AND cm.status != 'voided' AND cm.date_created >= ? AND cm.date_created <= ?
              ) x GROUP BY x.id`,
  },
  ap: {
    table: 'opening_ap_items', party: 'supplier_id', partyTable: 'suppliers', link: 'vendor_bill_id', linkType: 'Bill',
    settled: `SELECT x.id, SUM(x.amt) AS amt FROM (
                SELECT bpl.vendor_bill_id AS id, bpl.applied_amount AS amt
                  FROM bill_payment_lines bpl JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
                 WHERE bpl.vendor_bill_id IN (?) AND bp.status != 'voided' AND bp.date_created >= ? AND bp.date_created <= ?
                UNION ALL
                SELECT bca.vendor_bill_id, bca.applied_amount
                  FROM bill_credit_applications bca JOIN bill_credits bc ON bc.id = bca.bill_credit_id
                 WHERE bca.vendor_bill_id IN (?) AND bc.status != 'voided' AND bc.date_created >= ? AND bc.date_created <= ?
              ) x GROUP BY x.id`,
  },
};

// Which snapshot of open items a given aging date starts from: the latest one ON OR BEFORE it.
// Two are loaded for the cut-over -- the source's aging at 2025-12-31 (the books opening) and at
// 2026-09-30 (the day before staff moved to T1S). Bill payments migrated from the source mostly do
// not say which bills they paid, so a 2025-12-31 bill can never be settled by 2026 source data; the
// 2026-09-30 snapshot is the source's own answer to "what is still open", and from then on every
// payment is entered in T1S against the document it pays. Returns null when there is no snapshot
// at or before the date (history is then read exactly as before).
async function agingAnchor(side, asOf) {
  const table = SIDES[side].table;
  try {
    const [[r]] = await pool.query(`SELECT DATE_FORMAT(MAX(as_of), '%Y-%m-%d') AS as_of FROM ${table} WHERE as_of <= ?`, [String(asOf).slice(0, 10)]);
    if (!r || !r.as_of) return null;
    const d = new Date(`${r.as_of}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return { asOf: r.as_of, start: d.toISOString().slice(0, 10) };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

async function openingItems(side, asOf, books, { partyId, nameStarts, locationId } = {}) {
  const s = SIDES[side];
  // Opening items carry no office location; a report narrowed to one location has none of them.
  if (locationId) return [];
  const where = ['o.as_of = ?'];
  const params = [books.asOf];
  if (partyId) { where.push(`o.${s.party} = ?`); params.push(partyId); }
  if (nameStarts) { where.push('COALESCE(p.name, o.' + (side === 'ar' ? 'customer_name' : 'supplier_name') + ') LIKE ?'); params.push(`${nameStarts}%`); }
  const nameCol = side === 'ar' ? 'customer_name' : 'supplier_name';
  const [rows] = await pool.query(
    `SELECT o.*, COALESCE(p.name, o.${nameCol}) AS party_name
       FROM ${s.table} o LEFT JOIN ${s.partyTable} p ON p.id = o.${s.party}
      WHERE ${where.join(' AND ')}`, params,
  );
  const linked = rows.map((r) => r[s.link]).filter(Boolean);
  const settledBy = new Map();
  if (linked.length) {
    try {
      const [st] = await pool.query(s.settled, [linked, books.start, asOf, linked, books.start, asOf]);
      for (const r of st) settledBy.set(r.id, Number(r.amt) || 0);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e; // e.g. an install without bill credit applications
    }
  }
  const out = [];
  for (const r of rows) {
    const balance = round2(Number(r.balance) - (r[s.link] ? (settledBy.get(r[s.link]) || 0) : 0));
    if (Math.abs(balance) < 0.005) continue;
    out.push({
      party_id: r[s.party], party_name: r.party_name,
      type: r.doc_type, reference: r.doc_no, id: r[s.link] || null,
      date: r.doc_date ? String(r.doc_date).slice(0, 10) : books.asOf,
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
      original_amount: round2(r.original_amount), balance,
      opening: true,
    });
  }
  return out;
}

module.exports = { booksStart, openingGlLines, openingItems, agingAnchor };
