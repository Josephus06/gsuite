// Import named source invoices that T1S is missing, each attached to whatever the source raised it
// from:
//   a Sales Order      -> sales_invoices.sales_order_id (the order must already be in T1S)
//   an NSSO            -> sales_invoices.nsso_id        (the NSSO must already be in T1S)
//   nothing at all     -> a standalone invoice: sales_invoices.customer_id + item lines (monthly
//                         rent -- INV-83455 "RENT FOR SEPTEMBER 2026", item RENTAL)
// An invoice whose parent is not in T1S is reported and left alone, never forced in.
//
// READ-ONLY against the source. Skips any number already in T1S, so it is safe to re-run.
// Header money and status are the source's own figures, as import-sales.js writes them.
//
//   node src/db/import-invoices-by-number.js INV-83455,INV-82450 --dry-run
//   node src/db/import-invoices-by-number.js --file=numbers.txt
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1];
const listArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
const NUMBERS = [...new Set((fileArg ? fs.readFileSync(fileArg, 'utf8') : listArg).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');
const trunc = (s, n) => { const c = clean(s); return c ? c.slice(0, n) : null; };
const day = (v) => (v ? String(v).slice(0, 10) : null);
// Same derivations as import-sales.js: SubTotal is pre-discount, SubTotalVatEx the net, and the
// withholding rate is derived from the two amounts (the source's percent fields don't hold it).
const invoiceMoney = (h) => {
  const net = num(h.SubTotalVatEx_TransH);
  const ewt = num(h.WTAXAmount_TransH);
  return {
    subtotal: h.SubTotal_TransH != null && h.SubTotal_TransH !== '' ? num(h.SubTotal_TransH) : net,
    discount: num(h.DiscountAmount_TransH), ewt,
    ewtPct: net > 0 ? Math.round((ewt / net) * 1000000) / 10000 : 0,
  };
};
const lineNet = (il) => num(il.Total_LdgrInvty != null && il.Total_LdgrInvty !== '' ? il.Total_LdgrInvty : il.SubTotalAmountOut_LdgrInvty);
const lineDiscPrice = (il) => Math.round((num(il.Price_LdgrInvty) - num(il.DiscountRate_LdgrInvty)) * 1e6) / 1e6;
const invoiceType = (h) => (String(h?.Type_TransH || '').toLowerCase() === 'dr' ? 'DR' : 'SI');
function invoiceStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  if (s.includes('PAID')) return 'paid_in_full';
  return 'saved';
}

async function main() {
  if (!NUMBERS.length) { console.error('Give invoice numbers: INV-1,INV-2 or --file=path'); process.exit(2); }
  console.log(`${DRY_RUN ? 'DRY RUN -- ' : ''}${NUMBERS.length} invoice number(s). Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const t = await L.login();
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE 'Head Office%' LIMIT 1");
  const out = { imported: 0, exists: 0, notFound: 0, void: 0, noParent: [], failed: [], by: {} };
  const count = (k) => { out.by[k] = (out.by[k] || 0) + 1; };

  for (const invNo of NUMBERS) {
    try {
      const [[dup]] = await pool.query('SELECT id FROM sales_invoices WHERE invoice_no = ?', [invNo]);
      if (dup) { out.exists += 1; continue; }
      const head = L.listRows(await L.api(t, 'get_transactions', { where: { UserPK_TransH: invNo, Module_TransH: 'INVC' }, limit: 1 }))[0];
      if (!head) { out.notFound += 1; console.log(`  ${invNo}: not in the source`); continue; }
      if (L.isVoidOrCancelled(head.Status_TransH)) { out.void += 1; continue; }
      const inv = await L.api(t, 'get_invoice', { pk: head.SysPK_TransH });
      const h = { ...head, ...(inv.data?.[0] || {}) };
      const lines = inv.data?.[1] || [];

      // What it was raised from.
      let parent = null;
      if (head.SysFK_TransHSO_TransH) {
        parent = L.listRows(await L.api(t, 'get_transactions', { where: { SysPK_TransH: head.SysFK_TransHSO_TransH }, limit: 1 }))[0] || null;
      }
      const link = { sales_order_id: null, nsso_id: null, customer_id: null };
      let rep = null, loc = headOffice ? headOffice.id : null, dept = null;
      if (parent && parent.Module_TransH === 'SALESORDER') {
        const [[so]] = await pool.query(
          `SELECT so.id, so.sales_rep_id, so.office_location_id,
                  (SELECT d.id FROM sales_divisions sd
                     JOIN departments d ON REPLACE(REPLACE(LOWER(d.name),' ',''),'-','') = REPLACE(REPLACE(LOWER(sd.name),' ',''),'-','')
                    WHERE sd.id = so.sales_division_id LIMIT 1) AS department_id
             FROM sales_orders so WHERE so.sales_order_no = ?`, [parent.UserPK_TransH]);
        if (!so) { out.noParent.push(`${invNo} (${parent.UserPK_TransH} not in T1S)`); continue; }
        link.sales_order_id = so.id; rep = so.sales_rep_id; loc = so.office_location_id || loc; dept = so.department_id;
        count('sales order');
      } else if (parent && parent.Module_TransH === 'NONSALESORDER') {
        const [[ns]] = await pool.query('SELECT id, sales_rep_id, office_location_id FROM non_standard_sales_orders WHERE nsso_no = ?', [parent.UserPK_TransH]);
        if (!ns) { out.noParent.push(`${invNo} (${parent.UserPK_TransH} not in T1S)`); continue; }
        link.nsso_id = ns.id; rep = ns.sales_rep_id; loc = ns.office_location_id || loc;
        count('nsso');
      } else if (parent) {
        out.noParent.push(`${invNo} (raised from ${parent.Module_TransH} ${parent.UserPK_TransH} -- not handled)`);
        continue;
      } else {
        // Standalone: the customer by name (then by code), as the other importers match them.
        const [[c]] = await pool.query(
          'SELECT id FROM customers WHERE LOWER(name) = LOWER(?) OR (customer_code IS NOT NULL AND customer_code = ?) ORDER BY LOWER(name) = LOWER(?) DESC LIMIT 1',
          [clean(h.Name_Cust), clean(h.UserPK_Cust), clean(h.Name_Cust)]);
        if (!c) { out.noParent.push(`${invNo} (customer "${clean(h.Name_Cust)}" not in T1S)`); continue; }
        link.customer_id = c.id;
        if (h.Name_Empl) {
          const [[e]] = await pool.query("SELECT id FROM employees WHERE LOWER(CONCAT(first_name,' ',last_name)) = LOWER(?) LIMIT 1", [clean(h.Name_Empl)]);
          rep = e ? e.id : null;
        }
        count('standalone');
      }
      if (DRY_RUN) { out.imported += 1; continue; }

      const m = invoiceMoney(h);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO sales_invoices (invoice_no, sales_order_id, nsso_id, customer_id, date_created, date_due, term,
             bs_si_no, po_no, memo, department_id, subtotal, net_of_tax, tax_amount, gross_amount, amount_due, status,
             sales_rep_id, office_location_id, invoice_type, discount_amount, ewt_amount, withholding_tax_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [invNo, link.sales_order_id, link.nsso_id, link.customer_id, day(h.DateCreated_TransH), day(h.DateDue_TransH), clean(h.Term_TransH) || null,
            trunc(h.ReferrenceNO_TransH, 60), trunc(h.PONo_TransH || h.invc_po, 60), trunc(h.Memo_TransH, 500), dept, m.subtotal,
            num(h.SubTotalVatEx_TransH), num(h.TaxAmount_TransH), num(h.TotalAmount_TransH), num(h.AmountDue_TransH),
            invoiceStatus(h.Status_TransH), rep, loc, invoiceType(h), m.discount, m.ewt, m.ewtPct]);
        for (const il of lines) {
          let itemId = null;
          if (link.customer_id && il.UserPK_Invty) {
            const [[it]] = await conn.query('SELECT id FROM inventories WHERE item_code = ? LIMIT 1', [clean(il.UserPK_Invty)]);
            itemId = it ? it.id : null;
          }
          await conn.query(
            `INSERT INTO sales_invoice_lines (sales_invoice_id, item_id, description, quantity, units,
               price_per_unit, subtotal, net_of_tax, tax_code, tax_amount, gross_amount,
               disc_percent, disc_amount, disc_price_per_unit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.insertId, itemId, clean(il.DisplayDescription_LdgrInvty), num(il.Qty_LdgrInvty), il.UnitOfMeasure_LdgrInvty || null,
              num(il.Price_LdgrInvty), num(il.SubTotalAmountOut_LdgrInvty), lineNet(il), il.TaxCode_LdgrInvty || null,
              num(il.TaxAmount_LdgrInvty), num(il.TotalAmountOut_LdgrInvty), num(il.DiscountPercent_LdgrInvty),
              num(il.DiscountAmount_LdgrInvty), lineDiscPrice(il)]);
        }
        await conn.commit();
        out.imported += 1;
      } catch (e) { await conn.rollback(); out.failed.push(`${invNo}: ${e.message}`); }
      finally { conn.release(); }
    } catch (e) { out.failed.push(`${invNo}: ${e.message}`); }
  }

  console.log(`${DRY_RUN ? 'WOULD IMPORT' : 'Imported'} ${out.imported} | already in T1S ${out.exists} | not in source ${out.notFound} | void ${out.void}`);
  console.log('by parent:', JSON.stringify(out.by));
  if (out.noParent.length) console.log(`\nLeft alone (${out.noParent.length}):\n  ` + out.noParent.join('\n  '));
  if (out.failed.length) console.log(`\nFailed (${out.failed.length}):\n  ` + out.failed.join('\n  '));
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
