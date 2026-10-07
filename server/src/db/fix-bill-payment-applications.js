// Gives the imported Bill Payments (BPAY-####) the vendor-bill applications they carry at the source.
//
// WHY: import-bill-payments.js linked each payment to ONE bill -- the sl_pk on the source's payment
// list -- and put the payment's whole amount on it. A payment that settles several bills came over
// short: BPAY-13569 (22,966.20) applies to VB-23391, VB-23388, VB-23387 and VB-23386 at the source,
// and in T1S showed only VB-23391, carrying all 22,966.20 against a 4,757.14 bill (2026-10-07).
// The detail is on the source's payment: get_transactions with the
// transaction_transactionledgertransactions include, one row per application (ModuleTab 'A').
//
// What it touches, and what it never does:
//   - replaces the bill_payment_lines of an IMPORTED payment (created_by_user_id IS NULL) whose lines
//     differ from the source's applications. A payment made in T1S is never touched.
//   - all-or-nothing per payment: if any bill it settles is not in T1S, the payment is skipped and
//     named rather than rebuilt short. Applications to anything but a vendor bill are counted, not
//     written.
//   - payment headers (total, status), vendor bills (amount_due, status) and the GL are NOT changed:
//     the bills' balances came from the source already, and a payment's GL is worked off its header.
//
// Run on the DROPLET only (replication carries it to the office). Writes a rollback file.
//   node src/db/fix-bill-payment-applications.js                    # preview, every payment
//   node src/db/fix-bill-payment-applications.js --no=BPAY-13569    # preview one
//   node src/db/fix-bill-payment-applications.js --apply
//   node src/db/fix-bill-payment-applications.js --rollback=<file>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const argVal = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const ONE = argVal('no');
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const rows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));

async function pullSource() {
  const token = await L.login();
  const where = { Module_TransH: 'BILLPAYMENT', ...(ONE ? { UserPK_TransH: ONE } : {}) };
  const out = [];
  for (let off = 0; ; off += 200) {
    const page = rows(await L.api(token, 'get_transactions', {
      where, order: [['ID_TransH', 'DESC']], limit: 200, offset: off,
      include: [['transaction_transactionledgertransactions', 'transactionledgertransaction_transactionsl']],
    }));
    for (const r of page) {
      out.push({
        no: r.UserPK_TransH,
        apps: (r.transaction_transactionledgertransactions || [])
          .filter((l) => String(l.ModuleTab_LdgrTr) === 'A' && !Number(l.IsVoided_LdgrTr))
          .map((l) => ({
            amount: r2(l.Amount_LdgrTr),
            module: l.transactionledgertransaction_transactionsl?.Module_TransH,
            doc: l.transactionledgertransaction_transactionsl?.UserPK_TransH,
          })),
      });
    }
    if (page.length < 200) break;
    if (off % 2000 === 0 && off) console.log(`  source offset ${off}: ${out.length} payments`);
  }
  return out;
}

async function rollbackRun(file) {
  const rb = JSON.parse(fs.readFileSync(file, 'utf8'));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (rb.inserted_line_ids.length) await conn.query('DELETE FROM bill_payment_lines WHERE id IN (?)', [rb.inserted_line_ids]);
    for (const row of rb.deleted_lines) await conn.query('INSERT INTO bill_payment_lines SET ?', [row]);
    await conn.commit();
    console.log(`Rolled back: ${rb.inserted_line_ids.length} lines removed, ${rb.deleted_lines.length} restored.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  if (argVal('rollback')) { await rollbackRun(argVal('rollback')); await pool.end(); return; }

  const source = (await pullSource()).filter((p) => p.apps.length);
  console.log(`source payments with applications: ${source.length}`);

  const [pays] = await pool.query(
    `SELECT id, bill_payment_no, total_amount, created_by_user_id FROM bill_payments
      WHERE bill_payment_no IN (?)`, [source.map((p) => p.no).concat('')]);
  const payByNo = new Map(pays.map((p) => [p.bill_payment_no, p]));
  const [lines] = pays.length
    ? await pool.query(
      `SELECT l.*, vb.bill_no FROM bill_payment_lines l LEFT JOIN vendor_bills vb ON vb.id = l.vendor_bill_id
        WHERE l.bill_payment_id IN (?)`, [pays.map((p) => p.id)])
    : [[]];
  const linesBy = new Map();
  for (const l of lines) { if (!linesBy.has(l.bill_payment_id)) linesBy.set(l.bill_payment_id, []); linesBy.get(l.bill_payment_id).push(l); }
  const billNos = [...new Set(source.flatMap((p) => p.apps.filter((a) => a.module === 'VENDORBILL').map((a) => a.doc)))];
  const [bills] = billNos.length ? await pool.query('SELECT id, bill_no FROM vendor_bills WHERE bill_no IN (?)', [billNos]) : [[]];
  const billByNo = new Map(bills.map((b) => [b.bill_no, b.id]));

  const fix = []; const notHere = []; const madeHere = []; const missingBill = []; let otherApps = 0; let same = 0;
  for (const p of source) {
    const t = payByNo.get(p.no);
    if (!t) { notHere.push(p.no); continue; }
    if (t.created_by_user_id) { madeHere.push(p.no); continue; }
    // A bill-credit line is not something the source applications describe; leave such a payment be.
    if ((linesBy.get(t.id) || []).some((l) => l.bill_credit_id)) { madeHere.push(p.no); continue; }
    const vbApps = p.apps.filter((a) => a.module === 'VENDORBILL');
    otherApps += p.apps.length - vbApps.length;
    const missing = vbApps.filter((a) => !billByNo.has(a.doc));
    if (missing.length) { missingBill.push(`${p.no}: ${missing.map((a) => a.doc).join(', ')} not in T1S`); continue; }
    // Same bills and amounts already? Compared as sorted "bill:amount" lists.
    const key = (arr) => arr.map((x) => `${x.bill}:${r2(x.amount).toFixed(2)}`).sort().join('|');
    // One line per bill: applications to the same bill are added together, and a 0.00 one is dropped
    // (BPAY-12919 lists VB-23112 at 0.00 and again at 510.00).
    const perBill = new Map();
    for (const a of vbApps) perBill.set(a.doc, r2((perBill.get(a.doc) || 0) + a.amount));
    const want = [...perBill].filter(([, amt]) => amt > 0).map(([bill, amount]) => ({ bill, amount }));
    const have = (linesBy.get(t.id) || []).map((l) => ({ bill: l.bill_no || `credit:${l.bill_credit_id}`, amount: l.applied_amount }));
    if (key(want) === key(have)) { same += 1; continue; }
    fix.push({ pay: t, want, have });
  }

  for (const f of fix.slice(0, ONE ? 1 : 60)) {
    console.log(`  ${f.pay.bill_payment_no}: ${f.have.map((h) => `${h.bill} ${r2(h.amount).toFixed(2)}`).join(', ') || '(no lines)'}`
      + `  ->  ${f.want.map((w) => `${w.bill} ${w.amount.toFixed(2)}`).join(', ')}`);
  }
  if (fix.length > 60 && !ONE) console.log(`  ... and ${fix.length - 60} more`);
  console.log(`\nto rebuild: ${fix.length} | already matching: ${same} | made in T1S (left alone): ${madeHere.length} | not in T1S: ${notHere.length} | non-bill applications skipped: ${otherApps}`);
  if (missingBill.length) { console.log(`skipped, a bill they settle is not in T1S: ${missingBill.length}`); missingBill.slice(0, 20).forEach((m) => console.log(`  ${m}`)); }

  if (APPLY && fix.length) {
    const rb = { at: new Date().toISOString(), inserted_line_ids: [], deleted_lines: [] };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const f of fix) {
        const [old] = await conn.query('SELECT * FROM bill_payment_lines WHERE bill_payment_id = ?', [f.pay.id]);
        rb.deleted_lines.push(...old);
        await conn.query('DELETE FROM bill_payment_lines WHERE bill_payment_id = ?', [f.pay.id]);
        for (const w of f.want) {
          const [r] = await conn.query('INSERT INTO bill_payment_lines (bill_payment_id, vendor_bill_id, applied_amount) VALUES (?,?,?)',
            [f.pay.id, billByNo.get(w.bill), w.amount]);
          rb.inserted_line_ids.push(r.insertId);
        }
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    const file = path.join(__dirname, `../../rollback/bill-payment-applications-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rb));
    console.log(`Rebuilt ${fix.length} payment(s). Rollback file: ${file}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
