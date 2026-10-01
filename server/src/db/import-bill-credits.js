// Migrate the source's Bill Credits (BC-####) -- never imported before, because T1S required every
// credit to hang off a vendor bill (add-bill-credit-from-cheque.js lifted that on 2026-10-01).
//
// SHAPE ON THE SOURCE: get_transactions {Module_TransH:'BILLCREDIT'} with two child collections:
//   transaction_transactionledgerentries      'X' rows = the credit's LINES (account, net DR amount,
//                                             department, tax, withholding); 'GENENTRY' = its own
//                                             DR AP / CR line-account pair (T1S derives that itself).
//   transaction_transactionledgertransactions 'BC' rows = the APPLICATIONS: SysFK_TransHSL_LdgrTr is
//                                             the bill paid down (by source SysPK), Amount_LdgrTr how much.
// get_bill_credits gives each credit's "Created From" by NUMBER (sl_upk): a vendor bill (VB-) or a
// cheque (CHK-) -- many credits were made from the advance cheque that paid the supplier.
//
//   supplier     suppliers.live_pk = SysFK_Accnt_TransH (then the source's name)
//   accounts     the source chart of accounts matched to ours on code, then title
//   AP account   SysFK_AP_TransH (else 20100)
//   status       FULLY APPLIED -> fully_applied, OPEN -> open; VOID / CANCELLED are not migrated
//
// Does NOT touch vendor_bills.amount_due: the bills came over with balances already net of these
// credits (as import-credit-memos.js reasons for invoices). Applications are recorded so AP Aging
// and each bill's history can see them.
//
// READ-ONLY against the source. Skips credit numbers already in T1S, so it is safe to re-run.
//   node src/db/import-bill-credits.js --dry-run [--year=2026]
//   node src/db/import-bill-credits.js [--year=2026]
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const YEAR = (process.argv.find((a) => a.startsWith('--year=')) || '').split('=')[1] || null;
const PAGE = 200;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');
const norm = (s) => clean(s).toLowerCase();
const day = (v) => (v ? String(v).slice(0, 10) : null);
const statusOf = (s) => {
  const u = (s || '').toUpperCase();
  if (u.includes('VOID') || u.includes('CANCEL')) return null;
  return u.includes('FULLY') ? 'fully_applied' : 'open';
};

// Every page of a source list, to exhaustion (a transiently short page is not the end: two
// consecutive empty pages are -- see import-credit-memos.js).
async function allPages(t, ep, body, limit = 500) {
  const out = []; let empty = 0;
  for (let off = 0; off < 500000; off += limit) {
    let rows = [];
    try { rows = L.listRows(await L.api(t, ep, { ...body, limit, offset: off })); } catch (e) { console.warn(`  !! ${ep} @${off}: ${e.message}`); }
    if (!rows.length) { empty += 1; if (empty >= 2) break; continue; }
    empty = 0; out.push(...rows);
  }
  return out;
}

async function main() {
  console.log(`${DRY_RUN ? 'DRY RUN -- ' : ''}Bill Credits${YEAR ? ` dated ${YEAR}` : ''}. Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const t = await L.login();

  // Source accounts / departments -> ours.
  const liveCoa = await allPages(t, 'get_chart_of_accounts', {});
  const [localCoa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const coaByCode = new Map(localCoa.map((a) => [norm(a.account_code), a.id]));
  const coaByName = new Map(localCoa.map((a) => [norm(a.account_name), a.id]));
  const acctByLive = new Map(liveCoa.map((a) => [a.SysPK_COA, coaByCode.get(norm(a.UserPK_COA)) || coaByName.get(norm(a.Title_COA)) || null]));
  const liveDepts = L.listRows(await L.api(t, 'get_departments', {}));
  const [localDepts] = await pool.query('SELECT id, name FROM departments');
  const deptKey = (s) => norm(s).replace(/[^a-z0-9]/g, '');
  const deptByName = new Map(localDepts.map((d) => [deptKey(d.name), d.id]));
  const deptByLive = new Map(liveDepts.map((d) => [d.SysPK_Dept, deptByName.get(deptKey(d.Name_Dept || d.Title_Dept || d.name)) || null]));
  const [taxes] = await pool.query('SELECT id, rate FROM taxes');
  const taxByRate = new Map(taxes.map((x) => [Number(x.rate), x.id]));
  const [[ap20100]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const [sups] = await pool.query('SELECT id, name, live_pk FROM suppliers');
  const supByLive = new Map(sups.filter((s) => s.live_pk).map((s) => [s.live_pk, s.id]));
  const supByName = new Map(sups.map((s) => [norm(s.name), s.id]));
  const [vbs] = await pool.query('SELECT id, bill_no FROM vendor_bills');
  const vbByNo = new Map(vbs.map((v) => [v.bill_no, v.id]));
  const [chqs] = await pool.query("SELECT id, cheque_no, payee_type, payee_id FROM cheques");
  const chqByNo = new Map(chqs.map((c) => [c.cheque_no, c.id]));
  const chequeVendor = new Map(chqs.filter((c) => ['VENDOR', 'supplier'].includes(c.payee_type) && c.payee_id).map((c) => [c.id, c.payee_id]));
  const [bv] = await pool.query(`SELECT vb.id, COALESCE(po.supplier_id, vb.supplier_id) AS supplier_id
                                   FROM vendor_bills vb LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id`);
  const billVendor = new Map(bv.filter((b) => b.supplier_id).map((b) => [b.id, b.supplier_id]));
  const [users] = await pool.query('SELECT id, display_name FROM users');
  const userByName = new Map(users.filter((u) => u.display_name).map((u) => [norm(u.display_name), u.id]));
  const [have] = await pool.query('SELECT bill_credit_no FROM bill_credits');
  const haveNo = new Set(have.map((r) => r.bill_credit_no));
  console.log(`accounts ${[...acctByLive.values()].filter(Boolean).length}/${liveCoa.length} | departments ${[...deptByLive.values()].filter(Boolean).length}/${liveDepts.length} | suppliers ${supByLive.size} | bills ${vbByNo.size} | cheques ${chqByNo.size} | credits already here ${haveNo.size}`);

  // "Created From" by number, and the vendor's name, from the Saved Bill Credits list.
  const listByNo = new Map((await allPages(t, 'get_bill_credits', { searchKey: '' })).map((r) => [r.bc_upk, r]));
  // The source's vendor bills, SysPK -> number, to resolve what each application paid down.
  const vbPkToNo = new Map((await allPages(t, 'get_transactions', { where: { Module_TransH: 'VENDORBILL' } })).map((r) => [r.SysPK_TransH, r.UserPK_TransH]));
  console.log(`source: ${listByNo.size} listed credits, ${vbPkToNo.size} vendor bills mapped\n`);
  if (vbPkToNo.size < 1000) throw new Error(`Only ${vbPkToNo.size} source vendor bills mapped -- too few to link applications. Refusing.`);

  const out = {
    seen: 0, imported: 0, exists: 0, outOfYear: 0, void: 0, empty: 0, lines: 0,
    fromBill: 0, fromCheque: 0, fromNeither: 0, apps: 0, appsLinked: 0, appsUnresolved: 0, appsAmountUnresolved: 0,
    noSupplier: [], badAccount: [], failed: [], collisions: [],
  };
  const credits = await allPages(t, 'get_transactions', {
    where: { Module_TransH: 'BILLCREDIT' },
    include: ['transaction_transactionledgerentries', 'transaction_transactionledgertransactions'],
  }, PAGE);
  console.log(`source BILLCREDIT rows: ${credits.length}`);

  for (const h of credits) {
    out.seen += 1;
    const no = h.UserPK_TransH;
    if (YEAR && String(h.DateCreated_TransH || '').slice(0, 4) !== YEAR) { out.outOfYear += 1; continue; }
    const status = statusOf(h.Status_TransH);
    if (!status) { out.void += 1; continue; }
    if (haveNo.has(no)) { out.exists += 1; if (no === 'BC-1') out.collisions.push(no); continue; }

    const meta = listByNo.get(no) || {};
    // The vendor: the credit's own account, else its name on the list, else whoever the cheque or
    // bill it was created from was for (40 source credits carry no account of their own).
    const fromNo0 = meta.sl_upk || null;
    const entryVendor = (h.transaction_transactionledgerentries || []).map((e) => supByLive.get(e.SysFK_Accnt_LdgrEntries)).find(Boolean);
    const appVendor = (h.transaction_transactionledgertransactions || [])
      .map((a) => billVendor.get(vbByNo.get(vbPkToNo.get(a.SysFK_TransHSL_LdgrTr)))).find(Boolean);
    const supplierId = supByLive.get(h.SysFK_Accnt_TransH) || supByName.get(norm(meta.Name_Accnt))
      || (fromNo0 && chqByNo.get(fromNo0) && chequeVendor.get(chqByNo.get(fromNo0)))
      || (fromNo0 && vbByNo.get(fromNo0) && billVendor.get(vbByNo.get(fromNo0)))
      || entryVendor || appVendor || null;
    // 40 source credits are empty shells: PHP 0, no vendor, no source document, no applications.
    if (!supplierId && !round2(h.TotalAmount_TransH)) { out.empty += 1; continue; }
    if (!supplierId) {
      out.noSupplier.push(`${no} ${day(h.DateCreated_TransH)} ${h.Status_TransH} ${round2(h.TotalAmount_TransH)} (from ${fromNo0 || '?'}, ${(h.transaction_transactionledgertransactions || []).length} apps)`);
      continue;
    }

    const entries = h.transaction_transactionledgerentries || [];
    const lines = entries.filter((e) => e.Module_LdgrEntries === 'X').map((e) => {
      const amount = round2(num(e.DRAmount_LdgrEntries) || num(e.CRAmount_LdgrEntries));
      const tax = round2(e.TaxAmount_LdgrEntries);
      const gross = round2(num(e.GrossAmount_LdgrEntries) || amount + tax);
      const wtax = round2(e.WTAXAmount_LdgrEntries);
      return {
        account_id: acctByLive.get(e.SysFK_COA_LdgrEntries) || null, live_coa: e.SysFK_COA_LdgrEntries,
        department_id: deptByLive.get(e.SysFK_Dept_LdgrEntries) || null, amount,
        tax_code_id: tax ? (taxByRate.get(num(e.TaxRate_LdgrEntries)) || null) : null, tax_amount: tax, gross_amount: gross,
        is_withhold: e.IsWithhold_LdgrEntries ? 1 : 0, wtax_amount: wtax, amount_due: round2(num(e.AmountDue_LdgrEntries) || gross - wtax),
      };
    }).filter((l) => l.amount);
    if (lines.some((l) => !l.account_id)) { out.badAccount.push(`${no} (${lines.filter((l) => !l.account_id).map((l) => l.live_coa).join(',')})`); continue; }

    const fromNo = meta.sl_upk || null;
    const vendorBillId = fromNo && vbByNo.get(fromNo) ? vbByNo.get(fromNo) : null;
    const chequeId = !vendorBillId && fromNo && chqByNo.get(fromNo) ? chqByNo.get(fromNo) : null;
    if (vendorBillId) out.fromBill += 1; else if (chequeId) out.fromCheque += 1; else out.fromNeither += 1;

    const apps = (h.transaction_transactionledgertransactions || []).filter((a) => a.Module_LdgrTr === 'BC' && num(a.Amount_LdgrTr));
    const resolvedApps = [];
    for (const a of apps) {
      out.apps += 1;
      const billId = vbByNo.get(vbPkToNo.get(a.SysFK_TransHSL_LdgrTr));
      if (billId) { out.appsLinked += 1; resolvedApps.push({ vendor_bill_id: billId, applied_amount: round2(a.Amount_LdgrTr) }); }
      else { out.appsUnresolved += 1; out.appsAmountUnresolved += num(a.Amount_LdgrTr); }
    }

    const total = round2(h.TotalAmount_TransH);
    const applied = Math.min(total, round2(h.AppliedPayments_TransH));
    if (DRY_RUN) { out.imported += 1; out.lines += lines.length; continue; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO bill_credits (bill_credit_no, vendor_bill_id, supplier_id, cheque_id, date_created, office_location_id, ap_account_id,
           memo, wtax_amount, subtotal, tax_amount, total_amount, applied_amount, status, created_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [no, vendorBillId, supplierId, chequeId, day(h.DateCreated_TransH), locByName.get(norm(h.LocationName_TransH)) || null,
          acctByLive.get(h.SysFK_AP_TransH) || ap20100?.id || null, clean(h.Memo_TransH).slice(0, 500) || null,
          round2(h.WTAXAmount_TransH), round2(num(h.SubTotalVatEx_TransH) || num(h.SubTotal_TransH)), round2(h.TaxAmount_TransH),
          total, applied, status, userByName.get(norm(h.PreparedBy_TransH)) || null]);
      for (const l of lines) {
        await conn.query(
          `INSERT INTO bill_credit_lines (bill_credit_id, account_id, department_id, amount, tax_code_id, tax_amount, gross_amount, is_withhold, wtax_amount, amount_due)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [r.insertId, l.account_id, l.department_id, l.amount, l.tax_code_id, l.tax_amount, l.gross_amount, l.is_withhold, l.wtax_amount, l.amount_due]);
      }
      for (const a of resolvedApps) {
        await conn.query('INSERT INTO bill_credit_applications (bill_credit_id, vendor_bill_id, applied_amount) VALUES (?,?,?)', [r.insertId, a.vendor_bill_id, a.applied_amount]);
      }
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, new_value, set_by_user_id)
         VALUES ('BillCredit', ?, 'Created', 'bill_credit_no', ?, NULL)`, [r.insertId, `${no} (migrated from the source)`]);
      await conn.commit();
      out.imported += 1; out.lines += lines.length; haveNo.add(no);
    } catch (e) {
      await conn.rollback();
      out.failed.push(`${no}: ${e.message}`);
    } finally { conn.release(); }
    if (out.imported % 500 === 0) console.log(`  ...${out.imported} imported`);
  }

  out.appsAmountUnresolved = round2(out.appsAmountUnresolved);
  const show = (k) => `${out[k].length}${out[k].length ? `  e.g. ${out[k].slice(0, 5).join('; ')}` : ''}`;
  console.log(`\n${DRY_RUN ? 'WOULD IMPORT' : 'IMPORTED'} ${out.imported} credit(s), ${out.lines} line(s). seen ${out.seen}, already here ${out.exists}, other years ${out.outOfYear}, void ${out.void}, empty PHP 0 shells ${out.empty}`);
  console.log(`created from: bill ${out.fromBill}, cheque ${out.fromCheque}, neither found in T1S ${out.fromNeither}`);
  console.log(`applications: ${out.apps}, linked ${out.appsLinked}, bill not in T1S ${out.appsUnresolved} (PHP ${out.appsAmountUnresolved})`);
  console.log(`no supplier: ${show('noSupplier')}`);
  console.log(`unmapped account: ${show('badAccount')}`);
  console.log(`failed: ${show('failed')}`);
  if (out.collisions.length) console.log(`number already used by a T1S credit: ${out.collisions.join(', ')} (left alone)`);
  await pool.end();
}
main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
