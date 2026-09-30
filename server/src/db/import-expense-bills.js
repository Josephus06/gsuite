// Import the source's standalone (no-PO) vendor bills as T1S standalone expense bills.
//
// A source bill with no PO link (SysFK_TransHSL_TransH empty) is an expense bill: its lines are the
// ledger entries of Module 'X' -- account, net (DRAmount), particulars, department, tax code/amount,
// gross, withholding flag/amount, amount due. Header money and status are the source's own figures.
//   supplier   suppliers.live_pk = SysFK_Accnt_TransH
//   accounts   the source chart of accounts, matched to ours on code then title (as
//              import-vendor-bill-gl.js does)
//   AP account the header credit: Accounts Payable - Trade (20100)
// A bill whose supplier or any line account cannot be resolved is reported and left alone.
//
// READ-ONLY against the source. Skips bill numbers already in T1S, so it is safe to re-run.
//   node src/db/import-expense-bills.js --file=numbers.txt --dry-run
//   node src/db/import-expense-bills.js VB-24532,VB-24533
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
// Rebuild only the LINES of bills already imported (header, status and payments untouched) -- for a
// bill whose lines came in short.
const RELINES = process.argv.includes('--relines');
const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1];
const listArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
const NUMBERS = [...new Set((fileArg ? fs.readFileSync(fileArg, 'utf8') : listArg).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
const CONCURRENCY = 4;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');
const norm = (s) => clean(s).toLowerCase();
const day = (v) => (v ? String(v).slice(0, 10) : null);
function billStatus(s) {
  const u = (s || '').toUpperCase();
  if (u.includes('VOID') || u.includes('CANCEL')) return 'cancelled';
  if (u.includes('PAID')) return 'paid';
  return 'open';
}

async function main() {
  if (!NUMBERS.length) { console.error('Give bill numbers: VB-1,VB-2 or --file=path'); process.exit(2); }
  console.log(`${DRY_RUN ? 'DRY RUN -- ' : ''}${NUMBERS.length} bill number(s). Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const t = await L.login();

  // Source accounts -> ours, and source departments -> ours (by name).
  const liveCoa = [];
  for (let off = 0; ; off += 500) {
    const b = L.listRows(await L.api(t, 'get_chart_of_accounts', { limit: 500, offset: off }));
    liveCoa.push(...b);
    if (b.length < 500) break;
  }
  const [localCoa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const coaByCode = new Map(localCoa.map((a) => [norm(a.account_code), a.id]));
  const coaByName = new Map(localCoa.map((a) => [norm(a.account_name), a.id]));
  const acctByLive = new Map(liveCoa.map((a) => [a.SysPK_COA, coaByCode.get(norm(a.UserPK_COA)) || coaByName.get(norm(a.Title_COA)) || null]));
  const liveDepts = L.listRows(await L.api(t, 'get_departments', {}));
  const [localDepts] = await pool.query('SELECT id, name FROM departments');
  const deptKey = (s) => norm(s).replace(/[^a-z0-9]/g, '');
  const deptByName = new Map(localDepts.map((d) => [deptKey(d.name), d.id]));
  const deptByLive = new Map(liveDepts.map((d) => [d.SysPK_Dept, deptByName.get(deptKey(d.Name_Dept || d.Title_Dept || d.name)) || null]));
  const [taxes] = await pool.query('SELECT id, code, rate FROM taxes');
  const taxByRate = new Map(taxes.map((x) => [Number(x.rate), x.id]));
  const [wtaxes] = await pool.query('SELECT id, code, rate, name FROM withholding_taxes');
  const [[ap]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE 'Head Office%' LIMIT 1");
  console.log(`accounts resolved ${[...acctByLive.values()].filter(Boolean).length}/${liveCoa.length} | departments ${[...deptByLive.values()].filter(Boolean).length}/${liveDepts.length}\n`);

  const out = { imported: 0, exists: 0, notFound: 0, hasPo: 0, void: 0, skipped: [], failed: [] };
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= NUMBERS.length) return;
      const billNo = NUMBERS[i];
      try {
        const [[dup]] = await pool.query('SELECT id FROM vendor_bills WHERE bill_no = ? AND purchase_order_id IS NULL', [billNo]);
        if (dup && !RELINES) { out.exists += 1; continue; }
        if (!dup && RELINES) { out.skipped.push(`${billNo}: not in T1S (nothing to re-line)`); continue; }
        const h = L.listRows(await L.api(t, 'get_transactions', { where: { UserPK_TransH: billNo, Module_TransH: 'VENDORBILL' }, limit: 1 }))[0];
        if (!h) { out.notFound += 1; continue; }
        if (h.SysFK_TransHSL_TransH) { out.hasPo += 1; continue; } // a PO bill: import-vendor-bills.js's job
        if (L.isVoidOrCancelled(h.Status_TransH)) { out.void += 1; continue; }
        const [[sup]] = await pool.query('SELECT id FROM suppliers WHERE live_pk = ? LIMIT 1', [h.SysFK_Accnt_TransH]);
        if (!sup) { out.skipped.push(`${billNo}: supplier not in T1S`); continue; }
        // Paged: a bill can carry more than one page of ledger entries (VB-24357 has over 100), and a
        // single call silently returned the first 100 -- 37 of its expense lines.
        const entries = [];
        for (let off = 0; ; off += 100) {
          const pg = L.listRows(await L.api(t, 'get_transaction_ledger_entries', { where: { SysFK_TransH_LdgrEntries: h.SysPK_TransH }, limit: 100, offset: off }));
          entries.push(...pg);
          if (pg.length < 100) break;
        }
        const lines = entries.filter((e) => e.Module_LdgrEntries === 'X');
        if (!lines.length) { out.skipped.push(`${billNo}: no expense lines in the source`); continue; }
        const unresolved = lines.filter((e) => !acctByLive.get(e.SysFK_COA_LdgrEntries));
        if (unresolved.length) { out.skipped.push(`${billNo}: ${unresolved.length} line account(s) not in T1S`); continue; }
        const rate = num(h.WTAXPercent_TransH);
        const wt = num(h.WTAXAmount_TransH)
          ? (wtaxes.find((w) => clean(w.code) === clean(h.WTAXCode_TransH) && Number(w.rate) === rate) || wtaxes.find((w) => clean(w.code) === clean(h.WTAXCode_TransH)))
          : null;
        if (DRY_RUN) { out.imported += 1; continue; }

        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          let r;
          if (RELINES) {
            await conn.query('DELETE FROM vendor_bill_lines WHERE vendor_bill_id = ?', [dup.id]);
            r = { insertId: dup.id };
          } else [r] = await conn.query(
            `INSERT INTO vendor_bills
               (bill_no, purchase_order_id, supplier_id, date_created, date_due, term, reference_no, account_id, office_location_id,
                memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_id, wtax_description,
                wtax_amount, amount_due, status)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [billNo, sup.id, day(h.DateCreated_TransH), day(h.DateDue_TransH), clean(h.Term_TransH) || null,
              clean(h.ReferrenceNO_TransH).slice(0, 191) || null, ap ? ap.id : null, headOffice ? headOffice.id : null,
              clean(h.Memo_TransH).slice(0, 500) || null, num(h.SubTotal_TransH), num(h.DiscountAmount_TransH),
              num(h.SubTotalVatEx_TransH) || num(h.SubTotal_TransH), num(h.TaxAmount_TransH), num(h.TotalAmount_TransH),
              wt ? wt.id : null, clean(h.WTAXDescription_TransH).slice(0, 255) || (wt ? wt.name : null),
              num(h.WTAXAmount_TransH), num(h.AmountDue_TransH), billStatus(h.Status_TransH)]);
          for (const e of lines) {
            const net = num(e.DRAmount_LdgrEntries) || num(e.CRAmount_LdgrEntries);
            await conn.query(
              `INSERT INTO vendor_bill_lines
                 (vendor_bill_id, purchase_order_line_id, item_id, account_id, description, department_id, qty, rate, unit_price,
                  disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
               VALUES (?, NULL, NULL, ?, ?, ?, 1, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
              [r.insertId, acctByLive.get(e.SysFK_COA_LdgrEntries), clean(e.Particulars_LdgrEntries).slice(0, 500) || null,
                deptByLive.get(e.SysFK_Dept_LdgrEntries) || null, net, net, net,
                num(e.TaxAmount_LdgrEntries) ? (taxByRate.get(num(e.TaxRate_LdgrEntries)) || null) : null,
                num(e.TaxAmount_LdgrEntries), num(e.GrossAmount_LdgrEntries) || net + num(e.TaxAmount_LdgrEntries),
                e.IsWithhold_LdgrEntries ? 1 : 0, num(e.WTAXAmount_LdgrEntries),
                num(e.AmountDue_LdgrEntries) || (num(e.GrossAmount_LdgrEntries) - num(e.WTAXAmount_LdgrEntries))]);
          }
          await conn.commit();
          out.imported += 1;
        } catch (e) { await conn.rollback(); out.failed.push(`${billNo}: ${e.message}`); }
        finally { conn.release(); }
      } catch (e) { out.failed.push(`${billNo}: ${e.message}`); }
      if ((out.imported + out.skipped.length) % 100 === 0 && out.imported) console.log(`  ...${out.imported} imported`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`${DRY_RUN ? 'WOULD IMPORT' : 'Imported'} ${out.imported} | already in T1S ${out.exists} | not in source ${out.notFound} | PO bills skipped ${out.hasPo} | void ${out.void}`);
  if (out.skipped.length) console.log(`\nLeft alone (${out.skipped.length}):\n  ` + out.skipped.slice(0, 40).join('\n  '));
  if (out.failed.length) console.log(`\nFailed (${out.failed.length}):\n  ` + out.failed.slice(0, 40).join('\n  '));
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
