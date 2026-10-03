// One-off: gives the REAL 2026 customer payments (PAY-####) the invoice applications they carry
// at the source, and retires the synthetic CPAY-INV-#### payments those applications replace.
//
// WHY: import-customer-payments.js brought the PAY-#### headers over without lines, because the
// source's get_customer_payments list carries no payment->invoice detail. The detail does exist:
// the source's own payment screen reads it through get_transactions with the
// transaction_transactionledgertransactions include -- one row per application (ModuleTab 'A'),
// pointing at the invoice it settled. Probed 2026-10-01: 7,058 live 2026 payments, 9,689
// applications, and on every payment but one they sum to its AppliedPayments exactly.
//
// Meanwhile generate-invoice-payments.js had reconstructed one CPAY-INV-<invoice_no> payment per
// paid invoice so invoices showed as settled. With the real lines in, those book the same cash a
// second time, so each one is removed once its invoice is settled by a real PAY line instead.
//
// What it touches, and what it never does:
//   - inserts customer_payment_lines (sales_invoice_id) under PAY-#### payments that have NO
//     lines yet. A payment that already has lines is reported, never rewritten -- since go-live
//     (2026-10-01) staff may have applied one in the app, and their work wins.
//   - all-or-nothing per payment: if any invoice it settled is not in T1S, the payment is
//     skipped and named, rather than imported short.
//   - applications to a CUSTREFUND (8 at the source) are not lines in T1S -- refunds draw on a
//     payment through customer_refund_lines -- so they are left out and counted.
//   - payment headers (amounts, status) and invoices (amount_due, status) are NOT changed: they
//     already match the source (compare at go-live: 0 mismatches), and the lines only explain them.
//   - deletes a CPAY-INV-#### only when: its invoice now has real PAY lines covering at least
//     the CPAY's amount, all its own lines
//     are on that one invoice, it was created before go-live, it is not in a deposit, and no
//     refund draws on it. When the real lines cover only part (an invoice partly paid by an
//     earlier, still unlinked payment), the CPAY is TRIMMED to the uncovered remainder instead,
//     so that earlier cash keeps its evidence without the invoice being settled twice.
//     In-app payments (CPAY-<id>, no INV) are never candidates.
//
// AR Aging is unaffected for any as-of date on or after the books start (2026-10-01): it is
// anchored on the source's open items at 2026-09-30 and drops pre-start payments.
//
// Production: run on the DROPLET only (master-master replication carries it to the office box).
// Writes a rollback file (inserted line ids + full copies of every deleted payment and line).
//
//   node src/db/import-customer-payment-applications.js --dry-run
//   node src/db/import-customer-payment-applications.js
//   node src/db/import-customer-payment-applications.js --from-file=cp-apps-2026.json --dry-run
//   node src/db/import-customer-payment-applications.js --rollback=rollback/cp-applications-rollback-<stamp>.json
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const pool = require('../db');
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const argVal = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const FROM_FILE = argVal('from-file');
const YEAR = argVal('year') || '2026';
const GO_LIVE = '2026-10-01';
const key = (s) => String(s || '').trim().toUpperCase();
const cents = (v) => Math.round(Number(v || 0) * 100);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// Every source payment dated in YEAR with its applications, newest ID first. Stops after three
// consecutive pages without a YEAR payment -- back-dated entries make the ID order only roughly
// date-ordered, so one stale page is not the end.
async function pullSource() {
  const token = await L.login();
  const out = [];
  let dry = 0;
  for (let off = 0; dry < 3; off += 200) {
    const res = await L.api(token, 'get_transactions', {
      where: { Module_TransH: 'CUSTPAYMENT' }, order: [['ID_TransH', 'DESC']], limit: 200, offset: off,
      include: [['transaction_transactionledgertransactions', 'transactionledgertransaction_transactionsl']],
    });
    const rows = Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []);
    if (!rows.length) break;
    const keep = rows.filter((r) => String(r.DateCreated_TransH).slice(0, 4) === YEAR);
    // Pages of NEWER payments (2026 when running 2025) are paged through, not counted as dry --
    // only pages wholly older than YEAR mean the year is behind us.
    const allOlder = rows.every((r) => String(r.DateCreated_TransH).slice(0, 4) < YEAR);
    dry = keep.length ? 0 : (allOlder ? dry + 1 : 0);
    for (const r of keep) {
      out.push({
        no: r.UserPK_TransH, date: String(r.DateCreated_TransH).slice(0, 10), status: r.Status_TransH, applied: r.AppliedPayments_TransH,
        apps: (r.transaction_transactionledgertransactions || []).map((l) => ({
          tab: l.ModuleTab_LdgrTr, amount: l.Amount_LdgrTr, voided: l.IsVoided_LdgrTr,
          module: l.transactionledgertransaction_transactionsl?.Module_TransH, doc: l.transactionledgertransaction_transactionsl?.UserPK_TransH,
        })),
      });
    }
    if (off % 2000 === 0) console.log(`  source offset ${off}: ${out.length} ${YEAR} payments so far`);
  }
  return out;
}

// Undo a run from its rollback file: put the retired payments and their lines back with their
// original ids, then delete the lines that run inserted.
async function rollbackRun(file) {
  const rb = JSON.parse(fs.readFileSync(file, 'utf8'));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const row of rb.deleted_payments) await conn.query('INSERT INTO customer_payments SET ?', [row]);
    for (const row of rb.deleted_lines) await conn.query('INSERT INTO customer_payment_lines SET ?', [row]);
    for (const row of rb.trimmed_payments || []) await conn.query('UPDATE customer_payments SET payment_amount = ?, applied_amount = ?, unapplied_amount = ? WHERE id = ?', [row.payment_amount, row.applied_amount, row.unapplied_amount, row.id]);
    for (const row of rb.trimmed_lines || []) await conn.query('UPDATE customer_payment_lines SET applied_amount = ? WHERE id = ?', [row.applied_amount, row.id]);
    for (let i = 0; i < rb.inserted_line_ids.length; i += 1000) {
      await conn.query('DELETE FROM customer_payment_lines WHERE id IN (?)', [rb.inserted_line_ids.slice(i, i + 1000)]);
    }
    await conn.commit();
    console.log(`Rolled back: ${rb.deleted_payments.length} payments restored, ${(rb.trimmed_payments || []).length} untrimmed, ${rb.inserted_line_ids.length} lines removed.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY_RUN ? ' -- DRY RUN, nothing written' : ''}`);
  if (argVal('rollback')) return rollbackRun(argVal('rollback'));
  const source = FROM_FILE ? JSON.parse(fs.readFileSync(FROM_FILE, 'utf8')).rows : await pullSource();
  const live = source.filter((p) => !/VOID|CANCEL/i.test(p.status));
  console.log(`Source: ${source.length} ${YEAR} payments, ${live.length} live`);

  const [pays] = await pool.query(
    `SELECT cp.id, cp.customer_payment_no, cp.applied_amount, cp.status,
            (SELECT COUNT(*) FROM customer_payment_lines l WHERE l.customer_payment_id = cp.id) AS line_count
       FROM customer_payments cp WHERE cp.customer_payment_no LIKE 'PAY-%'`
  );
  const payByNo = new Map(pays.map((p) => [key(p.customer_payment_no), p]));
  const [invs] = await pool.query('SELECT id, invoice_no FROM sales_invoices');
  const invByNo = new Map(invs.map((i) => [key(i.invoice_no), i.id]));

  const report = { payment_missing: [], invoice_missing: [], already_has_lines: [], sum_off_header: [], refund_apps: 0, no_apps: 0 };
  const plan = []; // { payment_id, no, lines: [{ sales_invoice_id, applied_amount }] }
  for (const sp of live) {
    const apps = sp.apps.filter((a) => a.tab === 'A' && !Number(a.voided));
    report.refund_apps += apps.filter((a) => a.module === 'CUSTREFUND').length;
    const invApps = apps.filter((a) => a.module === 'INVC');
    if (!invApps.length) { report.no_apps += 1; continue; }
    const t = payByNo.get(key(sp.no));
    if (!t) { report.payment_missing.push(sp.no); continue; }
    if (Number(t.line_count) > 0) { report.already_has_lines.push(sp.no); continue; }
    const missing = invApps.filter((a) => !invByNo.has(key(a.doc)));
    if (missing.length) { report.invoice_missing.push(`${sp.no} -> ${missing.map((a) => a.doc).join(', ')}`); continue; }
    // Two applications of one payment to the same invoice are summed into one line.
    const byInv = new Map();
    for (const a of invApps) { const id = invByNo.get(key(a.doc)); byInv.set(id, (byInv.get(id) || 0) + cents(a.amount)); }
    const lines = [...byInv].map(([id, c]) => ({ sales_invoice_id: id, applied_amount: c / 100 }));
    const sum = lines.reduce((s, l) => s + cents(l.applied_amount), 0);
    // Lines that do not add up to the payment's own Applied are left out, not imported: either
    // staff re-applied it in T1S after go-live (PAY-60717) or the source disagrees with itself
    // (PAY-53761, 1,800 of lines on 18,000 applied) -- named in the report for a person to settle.
    if (sum !== cents(t.applied_amount)) { report.sum_off_header.push(`${sp.no} lines ${sum / 100} vs header applied ${t.applied_amount}`); continue; }
    plan.push({ payment_id: t.id, no: sp.no, lines });
  }

  // The synthetic CPAY-INV-#### each newly settled invoice carries, if it is safe to retire.
  // A CPAY is only retired when the real lines cover at least what it recorded -- an invoice a
  // 2026 payment settles only in part (the rest paid by an earlier, still unlinked payment) keeps
  // its CPAY, or that earlier part would lose its only evidence.
  const realByInvoice = new Map();
  for (const p of plan) for (const l of p.lines) realByInvoice.set(l.sales_invoice_id, (realByInvoice.get(l.sales_invoice_id) || 0) + cents(l.applied_amount));
  const settledInvoices = new Set(realByInvoice.keys());
  const [cpays] = await pool.query(
    `SELECT cp.id, cp.customer_payment_no, cp.deposit_id, cp.created_at, SUM(l.applied_amount) AS cpay_amount, COUNT(l.id) AS line_n,
            MIN(l.sales_invoice_id) AS inv_id, COUNT(DISTINCT l.sales_invoice_id) AS inv_count,
            SUM(l.sales_invoice_id IS NULL) AS other_lines,
            (SELECT COUNT(*) FROM customer_refund_lines crl WHERE crl.customer_payment_id = cp.id) AS refunds
       FROM customer_payments cp LEFT JOIN customer_payment_lines l ON l.customer_payment_id = cp.id
      WHERE cp.customer_payment_no LIKE 'CPAY-INV-%'
      GROUP BY cp.id`
  );
  const retire = []; const trim = []; const keptCpay = { deposited: [], refunded: [], after_go_live: [], odd_lines: [] };
  for (const c of cpays) {
    if (!settledInvoices.has(c.inv_id)) continue;
    if (c.deposit_id) { keptCpay.deposited.push(c.customer_payment_no); continue; }
    if (Number(c.refunds)) { keptCpay.refunded.push(c.customer_payment_no); continue; }
    if (String(new Date(c.created_at).toISOString()).slice(0, 10) >= GO_LIVE) { keptCpay.after_go_live.push(c.customer_payment_no); continue; }
    if (Number(c.inv_count) !== 1 || Number(c.other_lines)) { keptCpay.odd_lines.push(c.customer_payment_no); continue; }
    const remainder = cents(c.cpay_amount) - realByInvoice.get(c.inv_id);
    if (remainder > 0) {
      // Keeping the whole CPAY would settle the invoice twice over for the part the real lines
      // now cover, so it is trimmed to just the remainder they do not.
      if (Number(c.line_n) !== 1) { keptCpay.odd_lines.push(c.customer_payment_no); continue; }
      trim.push({ ...c, remainder: remainder / 100 });
      continue;
    }
    retire.push(c);
  }

  const lineCount = plan.reduce((s, p) => s + p.lines.length, 0);
  console.log(`\nPlan: ${plan.length} PAY payments get ${lineCount} invoice lines (${settledInvoices.size} invoices); ${retire.length} CPAY-INV payments retired, ${trim.length} trimmed to the part real lines do not cover`);
  console.log(`  source payments with no invoice application: ${report.no_apps}; refund applications left out: ${report.refund_apps}`);
  for (const [k, v] of Object.entries(report)) if (Array.isArray(v) && v.length) console.log(`  ${k}: ${v.length}  e.g. ${v.slice(0, 5).join(' | ')}`);
  for (const [k, v] of Object.entries(keptCpay)) if (v.length) console.log(`  CPAY kept (${k}): ${v.length}  e.g. ${v.slice(0, 5).join(', ')}`);

  const outDir = path.join(__dirname, '..', '..', 'rollback');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `cp-applications-report-${stamp}.json`), JSON.stringify({ report, keptCpay, retire: retire.map((c) => c.customer_payment_no), trim: trim.map((c) => `${c.customer_payment_no} -> ${c.remainder}`) }, null, 1));
  if (DRY_RUN) { console.log('\nDry run -- nothing written.'); return; }

  // Batches of 200 payments per transaction: each batch either lands whole or not at all, and
  // the rollback file is rewritten after every commit so it always matches what is in the DB.
  const rollbackFile = path.join(outDir, `cp-applications-rollback-${stamp}.json`);
  const rollback = { inserted_line_ids: [], deleted_payments: [], deleted_lines: [], trimmed_payments: [], trimmed_lines: [] };
  const conn = await pool.getConnection();
  try {
    for (let i = 0; i < plan.length; i += 200) {
      await conn.beginTransaction();
      for (const p of plan.slice(i, i + 200)) {
        // Re-checked inside the transaction: lines added by a user since the plan was made win.
        const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM customer_payment_lines WHERE customer_payment_id = ? FOR UPDATE', [p.payment_id]);
        if (n > 0) { report.already_has_lines.push(`${p.no} (since plan)`); continue; }
        for (const l of p.lines) {
          const [r] = await conn.query('INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)', [p.payment_id, l.sales_invoice_id, l.applied_amount]);
          rollback.inserted_line_ids.push(r.insertId);
        }
      }
      await conn.commit();
      fs.writeFileSync(rollbackFile, JSON.stringify(rollback));
      console.log(`  lines: ${Math.min(i + 200, plan.length)}/${plan.length} payments`);
    }
    // Retire or trim each CPAY-INV. The decision is re-made inside the transaction from what the
    // database now holds -- the real PAY lines actually on the invoice -- not from the plan, so a
    // payment skipped above (or edited by a user meanwhile) can never leave an invoice over- or
    // under-settled.
    const candidates = [...retire, ...trim];
    let retired = 0, trimmed = 0, left = 0;
    for (let i = 0; i < candidates.length; i += 200) {
      await conn.beginTransaction();
      for (const c of candidates.slice(i, i + 200)) {
        const [[cp]] = await conn.query(
          `SELECT * FROM customer_payments WHERE id = ? AND customer_payment_no LIKE 'CPAY-INV-%' AND deposit_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM customer_refund_lines crl WHERE crl.customer_payment_id = customer_payments.id) FOR UPDATE`, [c.id]);
        const [lines] = await conn.query('SELECT * FROM customer_payment_lines WHERE customer_payment_id = ? FOR UPDATE', [c.id]);
        if (!cp || lines.length !== 1 || lines[0].sales_invoice_id !== c.inv_id) { left += 1; continue; }
        const [[{ real }]] = await conn.query(
          `SELECT COALESCE(SUM(l.applied_amount), 0) AS \`real\` FROM customer_payment_lines l
             JOIN customer_payments p ON p.id = l.customer_payment_id
            WHERE l.sales_invoice_id = ? AND p.customer_payment_no LIKE 'PAY-%' AND p.status != 'voided'`, [c.inv_id]);
        const remainder = cents(lines[0].applied_amount) - cents(real);
        if (cents(real) === 0) { left += 1; continue; }
        if (remainder <= 0) {
          await conn.query('DELETE FROM customer_payment_lines WHERE id = ?', [lines[0].id]);
          await conn.query('DELETE FROM customer_payments WHERE id = ?', [cp.id]);
          rollback.deleted_payments.push(cp); rollback.deleted_lines.push(lines[0]); retired += 1;
        } else {
          const amt = remainder / 100;
          await conn.query('UPDATE customer_payment_lines SET applied_amount = ? WHERE id = ?', [amt, lines[0].id]);
          await conn.query('UPDATE customer_payments SET payment_amount = ?, applied_amount = ?, unapplied_amount = 0 WHERE id = ?', [amt, amt, cp.id]);
          rollback.trimmed_payments.push(cp); rollback.trimmed_lines.push(lines[0]); trimmed += 1;
        }
      }
      await conn.commit();
      fs.writeFileSync(rollbackFile, JSON.stringify(rollback));
      console.log(`  CPAY-INV: ${Math.min(i + 200, candidates.length)}/${candidates.length} (retired ${retired}, trimmed ${trimmed}, left ${left})`);
    }
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  console.log(`\nDone. ${rollback.inserted_line_ids.length} lines inserted, ${rollback.deleted_payments.length} CPAY-INV retired, ${rollback.trimmed_payments.length} trimmed. Rollback: ${rollbackFile}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
