// Raise the write-off Credit Memos for a named list of invoices, exactly as CM-5479 was raised.
//
// CM-5479 is the precedent and this copies it rather than inventing a shape: Angeline Betonta
// (user 21), dated 2026-10-01, A/R account 57, office location 1, one zero-rated line reading
// "WRITE OFF/BAD DEBTS", and the memo text below -- raised against the CUSTOMER (no source
// invoice) and applied to that customer's open invoices, one memo per customer however many
// invoices it covers. CM-5479 itself covered two.
//
// It goes through the application's own POST /api/credit-memos as Angeline, NOT by INSERT:
// that is what assigns the CM number, writes the audit row the System Info tab reads (so it
// says Angeline Betonta, which is the ask), checks the accounting period, and keeps the
// applications and each invoice's Amount Due in step. A direct insert would get the rows right
// and the bookkeeping wrong.
//
// SKIPPED, never guessed at: an invoice not on file, one already settled, and any amount that
// would credit more than is still open. Those are listed and left alone.
//
// DRY RUN BY DEFAULT.
//
//   node src/db/writeoff-credit-memos.js --file=invoices.txt [--apply]
//   node src/db/writeoff-credit-memos.js INV-1600,INV-1606 [--apply]
const fs = require('fs');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const listArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
const fileArg = arg('file', '');
const NUMBERS = [...new Set((fileArg ? fs.readFileSync(fileArg, 'utf8') : listArg)
  .split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

// Copied from CM-5479, field for field.
const SOURCE_CM = 'CM-5479';
const DATE_CREATED = arg('date', '2026-10-01');
const USERNAME = arg('user', 'angeline');
const API = arg('api', 'http://127.0.0.1:4000/api');

async function main() {
  if (!NUMBERS.length) throw new Error('Name the invoices: --file=<path> or a comma-separated list.');

  const [[tpl]] = await pool.query(
    'SELECT id, ar_account_id, office_location_id, memo FROM credit_memos WHERE credit_memo_no = ?', [SOURCE_CM]);
  if (!tpl) throw new Error(`${SOURCE_CM} is not on this install -- nothing to copy.`);
  const [[tplLine]] = await pool.query(
    'SELECT description, tax_code, units FROM credit_memo_lines WHERE credit_memo_id = ? ORDER BY line_no LIMIT 1', [tpl.id]);

  const [[user]] = await pool.query('SELECT id, username, display_name FROM users WHERE username = ?', [USERNAME]);
  if (!user) throw new Error(`No user "${USERNAME}".`);

  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : '   (DRY RUN -- nothing will be written)'}`);
  console.log(`Copying ${SOURCE_CM}: A/R account ${tpl.ar_account_id}, office ${tpl.office_location_id}, line "${tplLine.description}" ${tplLine.tax_code}`);
  console.log(`Memo: ${tpl.memo}`);
  console.log(`Created by: ${user.display_name} (#${user.id}), dated ${DATE_CREATED}\n`);

  const [rows] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.status, si.gross_amount, si.amount_due,
            c.id AS customer_id, c.name AS customer,
            COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                       JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                      WHERE cpl.sales_invoice_id = si.id AND cp.status <> 'voided'), 0)
          + COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma
                       JOIN credit_memos cm ON cm.id = cma.credit_memo_id
                      WHERE cma.sales_invoice_id = si.id AND cm.status <> 'voided'), 0) AS settled
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, e.customer_id, ns.customer_id, si.customer_id)
      WHERE si.invoice_no IN (?)`, [NUMBERS]);

  const byNo = new Map(rows.map((r) => [String(r.invoice_no).toUpperCase(), r]));
  const skipped = [];
  const eligible = [];
  for (const no of NUMBERS) {
    const r = byNo.get(no);
    if (!r) { skipped.push([no, 'not on this install']); continue; }
    if (r.status === 'cancelled') { skipped.push([no, 'void invoice']); continue; }
    if (!r.customer_id) { skipped.push([no, 'no customer on the invoice']); continue; }
    // The LOWER of what this install can account for and what the invoice itself says is still
    // owed. They part company on a migrated invoice the source had partly collected against with
    // no payment record here: INV-1656 reads gross 5,022.00 with amount_due 4,278.95, and offering
    // the gross made the server refuse the whole memo -- applyToInvoice will not apply more than
    // an invoice's remaining Amount Due, which is the correct rule and cost three of the first
    // nineteen memos.
    const open = Number(Math.min(
      Number(r.gross_amount) - Number(r.settled),
      Number(r.amount_due),
    ).toFixed(2));
    if (open <= 0.005) { skipped.push([no, `already settled (${r.status}, ${Number(r.settled).toFixed(2)} of ${r.gross_amount})`]); continue; }
    eligible.push({ ...r, open });
  }
  for (const [no, why] of skipped) console.log(`  SKIP ${no}: ${why}`);

  // One memo per customer, like CM-5479 -- which covered two of one customer's invoices.
  const byCustomer = new Map();
  for (const e of eligible) {
    if (!byCustomer.has(e.customer_id)) byCustomer.set(e.customer_id, { customer_id: e.customer_id, customer: e.customer, invoices: [] });
    byCustomer.get(e.customer_id).invoices.push(e);
  }
  const plan = [...byCustomer.values()].map((g) => ({
    ...g, total: Number(g.invoices.reduce((s, i) => s + i.open, 0).toFixed(2)),
  })).sort((a, b) => a.customer.localeCompare(b.customer));

  console.log(`\n${eligible.length} invoice(s) over ${plan.length} customer(s); ${skipped.length} skipped.`);
  for (const g of plan) {
    console.log(`  ${g.customer} — ${g.total.toFixed(2)}  (${g.invoices.map((i) => `${i.invoice_no} ${i.open.toFixed(2)}`).join(', ')})`);
  }
  console.log(`\nTOTAL to credit: ${plan.reduce((s, g) => s + g.total, 0).toFixed(2)}`);

  if (!APPLY) { console.log('\nDRY RUN -- re-run with --apply to raise them.'); return; }

  const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name },
    process.env.JWT_SECRET, { expiresIn: '30m' });
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let made = 0; let failed = 0;
  for (const g of plan) {
    const body = {
      customer_id: g.customer_id,
      date_created: DATE_CREATED,
      office_location_id: tpl.office_location_id,
      ar_account_id: tpl.ar_account_id,
      memo: tpl.memo,
      lines: [{
        description: tplLine.description, quantity: 1, price_per_unit: g.total,
        units: tplLine.units || null, tax_code: tplLine.tax_code,
      }],
      apply_lines: g.invoices.map((i) => ({ sales_invoice_id: i.id, applied_amount: i.open })),
    };
    const r = await fetch(`${API}/credit-memos`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const b = await r.json();
    if (r.status === 201) {
      made += 1;
      console.log(`  ${b.credit_memo_no}  ${g.customer} — ${Number(b.gross_amount).toFixed(2)} applied ${Number(b.applied_amount).toFixed(2)} (${g.invoices.map((i) => i.invoice_no).join(', ')})`);
    } else {
      failed += 1;
      console.log(`  !! ${g.customer}: HTTP ${r.status} ${b.error || JSON.stringify(b)}`);
    }
  }
  console.log(`\nRaised ${made} credit memo(s); ${failed} failed.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
