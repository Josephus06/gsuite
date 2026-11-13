// Checks every Vendor Bill marked paid with no payment behind it in T1S against the SOURCE system
// (asked 2026-11-13: "if there is no real payment don't mark it as paid -- check the source, verify
// it, so we can extract an accurate balance").
//
// A bill is "marked paid, no payment" on the same rule AP Aging uses (lib/apAging.js): status paid /
// paid_in_full or a zero Amount Due, a payable left, and no bill payment line and no bill credit
// application settling it. Each one is looked up in the source and put in one of these groups:
//
//   open_in_source         the source says OPEN -- it was never paid. --apply sets it Open, with the
//                          source's Amount Due. This is the only change the script makes.
//   payment_not_migrated   the source says PAID IN FULL and has the bill payment(s) (BPAY) for it,
//                          which T1S does not have -- the payment was never migrated. Left paid;
//                          the BPAY numbers are listed so they can be imported
//                          (import-bill-payment-by-number.js).
//   payment_not_linked     PAID IN FULL; the BPAY is in T1S but has no line to this bill. Left paid,
//                          listed.
//   paid_no_bpay           PAID IN FULL with no bill payment in the source either -- settled there by
//                          a credit, an advance or a cheque. Left paid, listed.
//   void_in_source         the source has it void / cancelled. Listed, not changed.
//   not_in_source          not in the source at all (raised in T1S). Listed, not changed.
//
// The source is read in two bulk scans (its vendor bill list and its bill payment list), not one
// request per bill. A CSV of every bill and its group is written to --csv=<path> (default
// /tmp/marked-paid-bills.csv).
//
//   node src/db/verify-marked-paid-bills.js                 dry run: report + CSV, nothing written
//   node src/db/verify-marked-paid-bills.js --apply         also set the open_in_source bills Open
//   node src/db/verify-marked-paid-bills.js --from=2026-01-01   only bills dated from then
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const arg = (name, def) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const FROM = arg('from', null);
const CSV = arg('csv', '/tmp/marked-paid-bills.csv');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const day = (v) => (v ? String(v).slice(0, 10) : '');
const up = (v) => String(v || '').trim().toUpperCase();
const listRows = (j) => (Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isVoid = (s) => /VOID|CANCEL/.test(up(s));

async function api(token, ep, payload, ms = 90000) {
  for (let a = 0; a < 4; a += 1) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms + a * 20000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      clearTimeout(t);
      return await r.json();
    } catch (e) {
      clearTimeout(t);
      if (a === 3) throw new Error(`${ep}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
      await sleep(1500 * (a + 1));
    }
  }
  return null;
}

// Every row of a paged source list.
async function scan(token, ep, payload, label) {
  const out = [];
  for (let offset = 0; offset < 200000; offset += 200) {
    const list = listRows(await api(token, ep, { ...payload, searchKey: '', limit: 200, offset }));
    if (!list.length) break;
    out.push(...list);
    if (offset % 4000 === 0) process.stdout.write(`  ${label}: ${out.length}\r`);
    if (list.length < 200) break;
  }
  console.log(`  ${label}: ${out.length} read from the source`);
  return out;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'APPLYING: open_in_source bills will be set Open.\n' : 'DRY RUN -- nothing will be written (add --apply).\n');

  const [bills] = await pool.query(
    `SELECT vb.id, vb.bill_no, DATE_FORMAT(vb.date_created, '%Y-%m-%d') AS date_created, vb.status, vb.amount_due,
            ROUND(vb.gross_amount - COALESCE(vb.wtax_amount, 0), 2) AS payable, s.name AS supplier, po.po_no
       FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
      WHERE vb.cancelled_at IS NULL AND vb.status <> 'cancelled'
        AND (vb.status IN ('paid', 'paid_in_full') OR ABS(COALESCE(vb.amount_due, 0)) < 0.005)
        AND ABS(vb.gross_amount - COALESCE(vb.wtax_amount, 0)) >= 0.005
        ${FROM ? 'AND vb.date_created >= ?' : ''}
        AND NOT EXISTS (SELECT 1 FROM bill_payment_lines bpl JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
                         WHERE bpl.vendor_bill_id = vb.id AND bp.status <> 'voided' AND bp.voided_at IS NULL AND bpl.applied_amount > 0)
        AND NOT EXISTS (SELECT 1 FROM bill_credit_applications bca JOIN bill_credits bc ON bc.id = bca.bill_credit_id
                         WHERE bca.vendor_bill_id = vb.id AND bc.status <> 'voided' AND bc.voided_at IS NULL AND bca.applied_amount > 0)
      ORDER BY vb.date_created, vb.id`, FROM ? [FROM] : []);
  console.log(`${bills.length} bill(s) marked paid with no payment in T1S, payable ${r2(bills.reduce((s, b) => s + num(b.payable), 0)).toLocaleString()}\n`);
  if (!bills.length) return;

  const token = (await api(null, 'login', { username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }))?.data?.token;
  if (!token) throw new Error('Could not log in to the source system (LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD).');

  const srcBills = await scan(token, 'get_transactions', { where: { Module_TransH: 'VENDORBILL' } }, 'source vendor bills');
  const srcBillByNo = new Map(srcBills.map((b) => [up(b.UserPK_TransH), b]));
  const srcPays = await scan(token, 'get_bill_payments', {}, 'source bill payments');
  const srcPaysByBill = new Map();
  for (const p of srcPays) {
    if (!p.sl_pk || isVoid(p.Status_TransH)) continue;
    const k = up(p.sl_pk);
    if (!srcPaysByBill.has(k)) srcPaysByBill.set(k, []);
    srcPaysByBill.get(k).push(p);
  }
  const [localPays] = await pool.query('SELECT bill_payment_no FROM bill_payments');
  const haveBpay = new Set(localPays.map((p) => up(p.bill_payment_no)));

  const groups = {};
  const out = [];
  for (const b of bills) {
    const src = srcBillByNo.get(up(b.bill_no));
    const pays = srcPaysByBill.get(up(b.bill_no)) || [];
    let group;
    if (!src) group = 'not_in_source';
    else if (isVoid(src.Status_TransH)) group = 'void_in_source';
    else if (up(src.Status_TransH) === 'OPEN' || num(src.AmountDue_TransH) >= 0.005) group = 'open_in_source';
    else if (!pays.length) group = 'paid_no_bpay';
    else if (pays.some((p) => !haveBpay.has(up(p.user_pk)))) group = 'payment_not_migrated';
    else group = 'payment_not_linked';
    (groups[group] = groups[group] || []).push(b);
    out.push({
      ...b, group, source_status: src ? src.Status_TransH : '', source_amount_due: src ? r2(src.AmountDue_TransH) : '',
      source_bpay: pays.map((p) => p.user_pk).join(' '),
      missing_bpay: pays.filter((p) => !haveBpay.has(up(p.user_pk))).map((p) => p.user_pk).join(' '),
    });
  }

  console.log('\nBy group (count / payable):');
  for (const [g, list] of Object.entries(groups)) {
    console.log(`  ${g.padEnd(22)} ${String(list.length).padStart(6)}  ${r2(list.reduce((s, b) => s + num(b.payable), 0)).toLocaleString()}`);
  }

  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = ['group', 'bill_no', 'date_created', 'supplier', 'po_no', 'payable', 'status', 'amount_due', 'source_status', 'source_amount_due', 'source_bpay', 'missing_bpay'];
  fs.writeFileSync(CSV, [cols.join(','), ...out.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
  console.log(`\nEvery bill and its group: ${CSV}`);

  const reopen = out.filter((r) => r.group === 'open_in_source');
  if (!reopen.length) { console.log('\nNo bill is open in the source -- nothing to change.'); return; }
  console.log(`\n${reopen.length} bill(s) the source shows OPEN${APPLY ? ' -- setting them Open:' : ' (would be set Open):'}`);
  for (const r of reopen.slice(0, 40)) console.log(`  ${r.bill_no}  ${r.date_created}  ${r.supplier}  payable ${r.payable}  source due ${r.source_amount_due}`);
  if (reopen.length > 40) console.log(`  ... and ${reopen.length - 40} more (see the CSV)`);
  if (!APPLY) return;
  let changed = 0;
  for (const r of reopen) {
    const [u] = await pool.query(
      "UPDATE vendor_bills SET status = 'open', amount_due = ? WHERE id = ? AND status IN ('paid', 'paid_in_full', 'open')",
      [r.source_amount_due === '' ? r.payable : r.source_amount_due, r.id]);
    if (u.affectedRows) {
      changed += 1;
      await pool.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('VendorBill', ?, 'Updated', 'status', ?, ?, NULL)`,
        [r.id, `${r.status} (no payment in T1S)`, `open -- the source shows it OPEN, amount due ${r.source_amount_due}`]).catch(() => {});
    }
  }
  console.log(`\nSet ${changed} bill(s) Open.`);
}

main().then(() => pool.end()).catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
