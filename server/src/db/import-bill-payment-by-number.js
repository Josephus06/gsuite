// Imports named bill payments from the live system, with the vendor bill each one pays when this
// build does not have that bill yet (asked 2026-11-06: BPAY-13781, check no. 6000421064, was never
// migrated -- its bill VB-24477 was missing, so import-bill-payments.js skipped it, and
// import-vendor-bills.js could not fetch the bill because it walks POs by their live_pk and
// PO-20086 here carries none).
//
// The bill is anchored by PO NUMBER instead: live bill -> live PO -> local purchase_orders.po_no.
// Its lines go to the PO's lines by live_line_pk, else by item description, else the PO's only
// line. Nothing is guessed beyond that -- a bill whose PO or lines cannot be placed is reported
// and nothing is written for that payment.
//
// The payment takes its bank from live's list row (Title_COA, by account NAME, as
// import-bill-payments.js does), and carries the check no., check date and date released.
//
// These rows are written straight to the tables: no period-lock check. GL here is derived from
// the documents, so a bill dated in a closed month changes that month's figures.
//
//   node src/db/import-bill-payment-by-number.js BPAY-13781            dry run (default)
//   node src/db/import-bill-payment-by-number.js BPAY-13781 --apply    write
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const NUMBERS = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((s) => s.trim().toUpperCase());

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const day = (v) => (v ? String(v).slice(0, 10) : null);
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const listRows = (j) => (Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []));

let TOKEN;
async function api(ep, body) {
  const r = await fetch(`${SITE}/api/${ep}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}
const header = async (where) => listRows(await api('get_transactions', { where }))[0] || null;

async function main() {
  if (!NUMBERS.length) { console.log('Name the payment(s): node src/db/import-bill-payment-by-number.js BPAY-13781 [--apply]'); return; }
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'APPLYING changes.\n' : 'DRY RUN -- nothing will be written (add --apply to write).\n');

  TOKEN = (await api('login', { username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }))?.data?.token;
  if (!TOKEN) throw new Error('Could not log in to the live system.');

  const [[ap]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
  const [coa] = await pool.query('SELECT id, account_name FROM chart_of_accounts');
  const coaByName = new Map(coa.map((c) => [norm(c.account_name), c.id]));
  const [methods] = await pool.query('SELECT id, name FROM payment_methods');
  const methodByName = new Map(methods.map((m) => [norm(m.name), m.id]));
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));

  for (const no of NUMBERS) {
    console.log(`== ${no}`);
    const [[have]] = await pool.query('SELECT id FROM bill_payments WHERE bill_payment_no = ?', [no]);
    if (have) { console.log(`   already here (id ${have.id}) -- skipped.\n`); continue; }

    const bp = await header({ UserPK_TransH: no });
    if (!bp || bp.Module_TransH !== 'BILLPAYMENT') { console.log('   not a bill payment on live -- skipped.\n'); continue; }
    if (/VOID|CANCEL/i.test(bp.Status_TransH || '')) { console.log(`   ${bp.Status_TransH} on live -- skipped.\n`); continue; }
    // The list row names the bank (Title_COA) and the supplier (Name_Accnt); the header does not.
    const listed = listRows(await api('get_bill_payments', { searchKey: no, limit: 50, offset: 0 })).find((r) => r.user_pk === no) || {};

    // ---- the bill it pays
    const vbLive = bp.SysFK_TransHSL_TransH ? await header({ SysPK_TransH: bp.SysFK_TransHSL_TransH }) : null;
    let bill = null; // { id, supplier_id, isNew, plan }
    if (vbLive && vbLive.Module_TransH === 'VENDORBILL') {
      const [[local]] = await pool.query('SELECT id, supplier_id, purchase_order_id FROM vendor_bills WHERE bill_no = ?', [vbLive.UserPK_TransH]);
      if (local) {
        bill = { no: vbLive.UserPK_TransH, id: local.id, isNew: false };
        console.log(`   bill ${bill.no}: already here (id ${local.id}).`);
      } else {
        const poLive = vbLive.SysFK_TransHSL_TransH ? await header({ SysPK_TransH: vbLive.SysFK_TransHSL_TransH }) : null;
        const [[po]] = poLive ? await pool.query('SELECT id, po_no, supplier_id FROM purchase_orders WHERE po_no = ?', [poLive.UserPK_TransH]) : [[null]];
        if (!po) { console.log(`   bill ${vbLive.UserPK_TransH}: its PO ${poLive?.UserPK_TransH || '(none)'} is not here -- NOT imported.\n`); continue; }
        const [poLines] = await pool.query(
          `SELECT pol.id, pol.item_id, pol.live_line_pk, pol.purchase_description, pol.location_id, pol.department_id, pol.tax_code_id,
                  i.item_name
             FROM purchase_order_lines pol LEFT JOIN items i ON i.id = pol.item_id WHERE pol.purchase_order_id = ?`, [po.id]).catch(() =>
          pool.query('SELECT id, item_id, live_line_pk, purchase_description, location_id, department_id, tax_code_id FROM purchase_order_lines WHERE purchase_order_id = ?', [po.id]));
        const liveLines = listRows(await api('get_transaction_ledger_invtys', { where: { SysFK_TransH_LdgrInvty: vbLive.SysPK_TransH } }));
        const plan = [];
        for (const l of liveLines) {
          const desc = norm(l.DisplayDescription_LdgrInvty);
          const pl = poLines.find((p) => p.live_line_pk && (p.live_line_pk === l.SysFK_LdgrInvtyPO_LdgrInvty || p.live_line_pk === l.SysFK_LdgrInvtySL_LdgrInvty))
            || poLines.find((p) => desc && (norm(p.purchase_description) === desc || norm(p.item_name) === desc))
            || (poLines.length === 1 && liveLines.length === 1 ? poLines[0] : null);
          plan.push({ l, pl });
        }
        const unplaced = plan.filter((x) => !x.pl);
        if (unplaced.length) {
          console.log(`   bill ${vbLive.UserPK_TransH}: ${unplaced.length} line(s) match no line of ${po.po_no} (${unplaced.map((x) => x.l.DisplayDescription_LdgrInvty).join('; ')}) -- NOT imported.\n`);
          continue;
        }
        const [[wt]] = vbLive.WTAXCode_TransH
          ? await pool.query('SELECT id FROM withholding_taxes WHERE code = ? OR atc_code = ? LIMIT 1', [vbLive.WTAXCode_TransH, vbLive.WTAXCode_TransH])
          : [[null]];
        bill = { no: vbLive.UserPK_TransH, isNew: true, po, plan, wtaxId: wt ? wt.id : null, live: vbLive };
        console.log(`   bill ${bill.no}: NEW, on ${po.po_no}, dated ${day(vbLive.DateCreated_TransH)}, ${r2(vbLive.TotalAmount_TransH).toFixed(2)}`
          + ` (wtax ${r2(vbLive.WTAXAmount_TransH).toFixed(2)} ${vbLive.WTAXCode_TransH || ''}${vbLive.WTAXCode_TransH && !wt ? ' -- code not found here, left blank' : ''}), ${plan.length} line(s):`);
        for (const { l, pl } of plan) console.log(`      ${num(l.QtyIn_LdgrInvty)} x ${l.DisplayDescription_LdgrInvty} -> PO line ${pl.id}`);
      }
    } else {
      console.log('   pays no vendor bill (header only).');
    }

    // ---- the payment
    const supplierId = (bill && (bill.isNew ? bill.po.supplier_id : (await pool.query('SELECT COALESCE(vb.supplier_id, po.supplier_id) s FROM vendor_bills vb LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id WHERE vb.id = ?', [bill.id]))[0][0]?.s))
      || (listed.Name_Accnt ? (await pool.query('SELECT id FROM suppliers WHERE name = ? LIMIT 1', [listed.Name_Accnt]))[0][0]?.id : null);
    const bankId = coaByName.get(norm(listed.Title_COA));
    const methodId = methodByName.get(norm(bp.PaymentMethod_TransH));
    const officeId = locByName.get(norm(bp.LocationName_TransH)) || null;
    const missing = [!supplierId && 'supplier', !bankId && `bank account "${listed.Title_COA || '?'}"`, !methodId && `payment method "${bp.PaymentMethod_TransH}"`].filter(Boolean);
    if (missing.length) { console.log(`   cannot place the payment's ${missing.join(', ')} -- NOT imported.\n`); continue; }
    const pay = {
      no, date: day(bp.DateCreated_TransH), type: bp.Type_TransH || 'Full', supplierId, payee: trunc(bp.PayeeName_TransH || listed.Name_Accnt, 255),
      officeId, bankId, methodId, ref: trunc(bp.ReferrenceNO_TransH, 191), checkDate: day(bp.CheckDate_TransH), checkNo: trunc(bp.CheckNo_TransH, 60),
      released: day(bp.AcknowledgeDate_TransH), memo: trunc(bp.Memo_TransH, 500), total: r2(bp.TotalAmount_TransH),
    };
    console.log(`   payment: ${pay.date}, ${pay.total.toFixed(2)}, ${bp.PaymentMethod_TransH}, bank "${listed.Title_COA}", check no. ${pay.checkNo || '-'},`
      + ` check date ${pay.checkDate || '-'}, released ${pay.released || '-'}, payee ${pay.payee}`);

    if (!APPLY) { console.log('   (dry run)\n'); continue; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let billId = bill ? bill.id : null;
      if (bill && bill.isNew) {
        const v = bill.live;
        const [r] = await conn.query(
          `INSERT INTO vendor_bills (bill_no, purchase_order_id, supplier_id, date_created, date_due, term, reference_no, account_id,
             office_location_id, memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_id, wtax_description,
             wtax_amount, amount_due, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [bill.no, bill.po.id, bill.po.supplier_id, day(v.DateCreated_TransH), day(v.DateDue_TransH), trunc(v.Term_TransH, 60),
           trunc(v.ReferrenceNO_TransH, 191), ap ? ap.id : null, locByName.get(norm(v.LocationName_TransH)) || null, trunc(v.Memo_TransH, 500),
           r2(v.SubTotal_TransH), r2(v.DiscountAmount_TransH), r2(v.SubTotalVatEx_TransH || v.SubTotal_TransH), r2(v.TaxAmount_TransH),
           r2(v.TotalAmount_TransH), bill.wtaxId, trunc(v.WTAXDescription_TransH, 255), r2(v.WTAXAmount_TransH), r2(v.AmountDue_TransH),
           num(v.AmountDue_TransH) <= 0.005 ? 'paid_in_full' : 'open']);
        billId = r.insertId;
        for (const { l, pl } of bill.plan) {
          await conn.query(
            `INSERT INTO vendor_bill_lines (vendor_bill_id, purchase_order_line_id, item_id, description, location_id, department_id,
               qty, rate, unit_price, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [billId, pl.id, pl.item_id, trunc(l.DisplayDescription_LdgrInvty, 500), pl.location_id, pl.department_id,
             num(l.QtyIn_LdgrInvty) || num(l.Qty_LdgrInvty), num(l.Rate_LdgrInvty) || num(l.Cost_LdgrInvty), num(l.Rate_LdgrInvty) || num(l.Cost_LdgrInvty),
             num(l.DiscountRate_LdgrInvty), num(l.DiscountAmount_LdgrInvty), num(l.SubTotalAmountIn_LdgrInvty), pl.tax_code_id,
             num(l.TaxAmount_LdgrInvty), num(l.TotalAmountIn_LdgrInvty), l.IsWithhold_LdgrInvty ? 1 : 0, num(l.WTAXAmount_LdgrInvty),
             num(l.AmountDue_LdgrInvty)]);
        }
      }
      const [r] = await conn.query(
        `INSERT INTO bill_payments (bill_payment_no, date_created, payment_type, supplier_id, payee_name, office_location_id, ap_account_id,
           bank_account_id, payment_method_id, reference_no, check_date, check_no, date_released, memo, total_amount, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted')`,
        [pay.no, pay.date, pay.type, pay.supplierId, pay.payee, pay.officeId, ap ? ap.id : null, pay.bankId, pay.methodId, pay.ref,
         pay.checkDate, pay.checkNo, pay.released, pay.memo, pay.total]);
      if (billId) {
        await conn.query('INSERT INTO bill_payment_lines (bill_payment_id, vendor_bill_id, applied_amount) VALUES (?,?,?)', [r.insertId, billId, pay.total]);
        // An existing bill this settles: recompute what is left on it, as the app does on save.
        if (!bill.isNew) {
          await conn.query(
            `UPDATE vendor_bills vb
                SET vb.amount_due = GREATEST(0, ROUND(vb.gross_amount - vb.wtax_amount - (
                      SELECT COALESCE(SUM(bpl.applied_amount), 0) FROM bill_payment_lines bpl
                        JOIN bill_payments p ON p.id = bpl.bill_payment_id AND p.status <> 'voided'
                       WHERE bpl.vendor_bill_id = vb.id), 2)),
                    vb.status = IF(vb.gross_amount - vb.wtax_amount - (
                      SELECT COALESCE(SUM(bpl.applied_amount), 0) FROM bill_payment_lines bpl
                        JOIN bill_payments p ON p.id = bpl.bill_payment_id AND p.status <> 'voided'
                       WHERE bpl.vendor_bill_id = vb.id) <= 0.005, 'paid_in_full', vb.status)
              WHERE vb.id = ?`, [billId]);
        }
      }
      await conn.commit();
      console.log(`   imported: payment id ${r.insertId}${bill && bill.isNew ? `, bill id ${billId}` : ''}.\n`);
    } catch (e) {
      await conn.rollback();
      console.log(`   FAILED, nothing written: ${e.message}\n`);
    } finally { conn.release(); }
  }
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
