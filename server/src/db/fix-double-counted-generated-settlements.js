// Imported invoices whose generated settlement (CPAY-INV-####, db/generate-invoice-payments.js) counts
// money twice (found 2026-10-19 on INV-79225 / CPAY-1255 and INV-83007 / CPAY-1264).
//
// The generator wrote a CPAY-INV "settlement" for each imported invoice the source showed as paid.
// For some, the same amount ALSO came over as a real credit memo or payment -- so T1S counts it twice
// and reads the invoice (partly) paid while the source's own balance at the cut-over says otherwise.
// AR Aging, which works from that cut-over balance (opening_ar_items), shows the right amount open;
// the invoice's own balance in T1S is too low, so a payment cannot be applied to what is really owed.
//
// For every invoice still open in the latest snapshot that carries a CPAY-INV settlement:
//   aging open = snapshot balance - real payments and credit memos dated after the snapshot
//   T1S due    = gross - every payment and credit memo applied (lib/invoiceDue.js)
// Where aging open is MORE than T1S due, the CPAY-INV settlement is reduced by the difference (never
// below zero) -- voided outright when that takes it to zero -- and the invoice goes back to open.
// Only generated CPAY-INV records are touched; never a real payment or credit memo. None of them is
// in a deposit or was keyed by a person (checked 2026-10-19). Each change is in the audit trail.
//
//   node src/db/fix-double-counted-generated-settlements.js --dry-run [--xlsx=/tmp/file.xlsx]
//   node src/db/fix-double-counted-generated-settlements.js --by=<user id>
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { grossDueSql } = require('../lib/invoiceDue');

// An invoice's balance before it is floored at zero: gross less every payment and credit applied. An
// invoice overpaid by the double count reads 0 on grossDueSql however much the generated settlement
// is cut, so the gap is measured from this (2026-10-19: 45 were still short after the first pass).
const rawDueSql = (a) => `ROUND(${a}.gross_amount
  - COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
               WHERE cpl.sales_invoice_id = ${a}.id AND cp.status <> 'voided'), 0)
  - COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma JOIN credit_memos cmx ON cmx.id = cma.credit_memo_id
               WHERE cma.sales_invoice_id = ${a}.id AND cmx.status <> 'voided'), 0), 2)`;

const DRY = process.argv.includes('--dry-run');
const xlsxArg = process.argv.find((a) => a.startsWith('--xlsx='));
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');

async function findRows() {
  const [[{ asof }]] = await pool.query('SELECT MAX(as_of) AS asof FROM opening_ar_items');
  const asOf = day(asof);
  const [rows] = await pool.query(`
    SELECT si.id AS invoice_id, si.invoice_no, si.status AS invoice_status, si.amount_due, c.name AS customer, si.gross_amount,
           oi.balance AS snap_balance, ${grossDueSql('si')} AS t1s_due, ${rawDueSql('si')} AS raw_due,
           syn.id AS line_id, syn.applied_amount AS synthetic, cp.id AS payment_id, cp.customer_payment_no AS synthetic_no,
           cp.date_created AS synthetic_date, cp.payment_amount AS synthetic_payment,
      (SELECT COALESCE(SUM(cpl.applied_amount), 0) FROM customer_payment_lines cpl JOIN customer_payments p ON p.id = cpl.customer_payment_id
        WHERE cpl.sales_invoice_id = si.id AND p.status <> 'voided' AND p.customer_payment_no NOT LIKE 'CPAY-INV-%' AND p.date_created > ?) AS paid_after,
      (SELECT COALESCE(SUM(cma.applied_amount), 0) FROM credit_memo_applications cma JOIN credit_memos cm ON cm.id = cma.credit_memo_id
        WHERE cma.sales_invoice_id = si.id AND cm.status <> 'voided' AND cm.date_created > ?) AS credited_after
      FROM opening_ar_items oi
      JOIN sales_invoices si ON si.id = oi.sales_invoice_id
      JOIN customer_payment_lines syn ON syn.sales_invoice_id = si.id
      JOIN customer_payments cp ON cp.id = syn.customer_payment_id AND cp.customer_payment_no LIKE 'CPAY-INV-%' AND cp.status <> 'voided'
      LEFT JOIN sales_orders so ON so.id = si.sales_order_id
      LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id)
     WHERE oi.as_of = ? AND oi.balance > 0.005 AND si.status <> 'cancelled'
     ORDER BY si.id`, [asOf, asOf, asOf]);
  const fixes = [];
  for (const r of rows) {
    const agingOpen = Math.max(0, r2(Number(r.snap_balance) - Number(r.paid_after) - Number(r.credited_after)));
    if (r2(agingOpen - Number(r.t1s_due)) <= 0.005) continue;
    const gap = r2(agingOpen - Number(r.raw_due));
    const cut = r2(Math.min(gap, Number(r.synthetic)));
    fixes.push({
      ...r, agingOpen, cut, newSynthetic: r2(Number(r.synthetic) - cut),
      newDue: Math.max(0, r2(Number(r.raw_due) + cut)), fully: r2(Number(r.synthetic) - cut) <= 0.005,
      afterCutover: day(r.synthetic_date) > asOf,
    });
  }
  return { asOf, fixes };
}

async function writeXlsx(file, asOf, fixes) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Generated settlements');
  ws.columns = [
    { header: 'Invoice #', key: 'invoice_no', width: 14 }, { header: 'Customer', key: 'customer', width: 38 },
    { header: 'Gross', key: 'gross_amount', width: 13 }, { header: `Balance ${asOf} (source)`, key: 'snap_balance', width: 16 },
    { header: 'Paid / credited after', key: 'after', width: 16 }, { header: 'AR Aging open', key: 'agingOpen', width: 14 },
    { header: 'T1S due now', key: 't1s_due', width: 13 }, { header: 'Generated settlement', key: 'synthetic_no', width: 18 },
    { header: 'Its date', key: 'synthetic_date', width: 11 }, { header: 'Its amount', key: 'synthetic', width: 13 },
    { header: 'Reduce by', key: 'cut', width: 13 }, { header: 'Becomes', key: 'newSynthetic', width: 13 },
    { header: 'Action', key: 'action', width: 10 }, { header: 'T1S due after', key: 'newDue', width: 13 },
    { header: 'Dated after cut-over', key: 'afterCutover', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const f of fixes) {
    ws.addRow({
      ...f, after: r2(Number(f.paid_after) + Number(f.credited_after)), synthetic_date: day(f.synthetic_date),
      action: f.fully ? 'Void' : 'Reduce', afterCutover: f.afterCutover ? 'YES' : '',
    });
  }
  ['gross_amount', 'snap_balance', 'after', 'agingOpen', 't1s_due', 'synthetic', 'cut', 'newSynthetic', 'newDue']
    .forEach((k) => { ws.getColumn(k).numFmt = '#,##0.00'; });
  ws.autoFilter = { from: 'A1', to: `O${fixes.length + 1}` };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  await wb.xlsx.writeFile(file);
}

async function audit(conn, type, id, field, oldV, newV) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES (?, ?, 'Updated', ?, ?, ?, ?)`, [type, id, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), BY]);
}

// The invoice's stored cash balance from its true balance: amount_due + EWT = gross due (the payments
// module keeps it so), so amount_due = gross due - EWT, never below zero; open again if anything is due.
async function settleAmountDue(conn, invoiceId) {
  const [[r]] = await conn.query(`SELECT ${grossDueSql('si')} AS gdue, COALESCE(si.ewt_amount, 0) AS ewt FROM sales_invoices si WHERE si.id = ?`, [invoiceId]);
  const amountDue = Math.max(0, r2(Number(r.gdue) - Number(r.ewt)));
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, status = IF(status = 'paid_in_full' AND ? > 0.005, 'saved', status) WHERE id = ?",
    [amountDue, Number(r.gdue), invoiceId]);
  return amountDue;
}

async function apply(f) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const note = `double-counted generated settlement -- reduced by ${money(f.cut)} to match the source's balance (fix-double-counted-generated-settlements.js)`;
    if (f.fully) {
      await conn.query("UPDATE customer_payments SET status = 'voided', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [BY, f.payment_id]);
      await audit(conn, 'CustomerPayment', f.payment_id, 'status', 'not_deposited', `voided -- ${note}`);
    } else {
      await conn.query('UPDATE customer_payment_lines SET applied_amount = ? WHERE id = ?', [f.newSynthetic, f.line_id]);
      await conn.query(
        'UPDATE customer_payments SET payment_amount = payment_amount - ?, applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?',
        [f.cut, f.cut, f.payment_id]);
      await audit(conn, 'CustomerPayment', f.payment_id, 'applied_amount', f.synthetic, `${f.newSynthetic} -- ${note}`);
    }
    const newAmountDue = await settleAmountDue(conn, f.invoice_id);
    await audit(conn, 'SalesInvoice', f.invoice_id, 'amount_due', f.amount_due, `${newAmountDue} -- ${f.synthetic_no} ${note}`);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? ' -- DRY RUN' : ''}\n`);
  if (process.argv.includes('--resettle')) {
    // The first run (2026-10-19) added its cut to amount_due instead of recomputing it -- doubling it
    // where amount_due already read right (INV-79225: 13,075 -> 26,150). Recompute those.
    const [touched] = await pool.query(
      `SELECT DISTINCT a.auditable_id AS id, si.amount_due FROM audit_logs a JOIN sales_invoices si ON si.id = a.auditable_id
        WHERE a.auditable_type = 'SalesInvoice' AND a.new_value LIKE '%fix-double-counted-generated-settlements%'`);
    let changed = 0;
    for (const t of touched) {
      if (DRY) continue;
      const conn = await pool.getConnection();
      try {
        const v = await settleAmountDue(conn, t.id);
        if (Math.abs(v - Number(t.amount_due)) > 0.005) {
          changed += 1;
          await audit(conn, 'SalesInvoice', t.id, 'amount_due', t.amount_due, `${v} -- recomputed from the invoice's balance (fix-double-counted-generated-settlements.js --resettle)`);
        }
      } finally { conn.release(); }
    }
    console.log(`${DRY ? 'Would recompute' : 'Recomputed'} amount_due on ${touched.length} invoice(s); ${changed} changed.`);
    await pool.end();
    return;
  }
  const { asOf, fixes } = await findRows();
  const voids = fixes.filter((f) => f.fully).length;
  const total = fixes.reduce((s, f) => s + f.cut, 0);
  const after = fixes.filter((f) => f.afterCutover);
  console.log(`Snapshot ${asOf}: ${fixes.length} invoice(s) to correct -- ${voids} generated settlement(s) voided, ${fixes.length - voids} reduced.`);
  console.log(`Back on the invoices (owed again): ${money(total)}.`);
  console.log(`Generated settlements dated after the cut-over (these move the books): ${after.length}${after.length ? ` -- ${money(after.reduce((s, f) => s + f.cut, 0))}` : ''}.`);
  if (xlsxArg) { await writeXlsx(xlsxArg.split('=')[1], asOf, fixes); console.log(`List written to ${xlsxArg.split('=')[1]}`); }
  if (!DRY) {
    let done = 0;
    for (const f of fixes) { await apply(f); done += 1; }
    console.log(`\nCorrected ${done} invoice(s).`);
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
