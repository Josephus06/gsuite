// Migrate Credit Memos (CM-####) and link each to the invoice(s) it was applied against.
//
// SHAPE ON LIVE: get_transactions {Module_TransH:'CREDITMEMO'}, with both child collections
// on the paged query (~30 requests for 5,301 memos rather than one per document):
//
//   transaction_transactionledgertransactions  -> the APPLICATIONS. Module_LdgrTr='CM',
//       SysFK_TransHSL_LdgrTr = the invoice's live SysPK, Amount_LdgrTr = amount applied,
//       AmountDue_LdgrTr = what that invoice was owed. This is the link.
//   transaction_transactionledgerentries       -> a GENENTRY DR/CR pair only.
//
// NO LINE ITEMS. Unlike cheques, not one credit memo carries 'X' entries -- these are
// amount-only documents raised against an invoice, so credit_memo_lines stays empty by
// nature rather than by omission.
//
// THE LINK: applications reference an invoice by live SysPK, which means nothing locally.
// get_invoices maps SysPK -> invoice number (INV-#####), and that number matches local
// sales_invoices.invoice_no. Building that map once costs ~150 paged requests; resolving
// each application individually would cost ~6,000.
//
// Deliberately does NOT touch sales_invoices.amount_due. The app reduces it when a credit
// memo is raised, but these invoices were imported from live with their balances already
// net of these very credits -- re-applying would double-count.
//
// RESUMABLE + IDEMPOTENT: memos already present locally (by credit_memo_no) are skipped.
//
//   node src/db/import-credit-memos.js --dry-run
//   node src/db/import-credit-memos.js
const pool = require('../db');
const { upperCustomerName } = require('../lib/customerName');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 200;
const INV_PAGE = 500;

const day = (v) => (v || '').toString().slice(0, 10);
const dOrNull = (v) => { const s = day(v); return s && s >= '1990-01-01' ? s : null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}

async function api(token, ep, payload, attempts = 5) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000 + a * 20000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal,
      });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- fetch + report only.\n' : 'APPLYING.\n');

  const [invs] = await pool.query('SELECT id, invoice_no FROM sales_invoices');
  const invByNo = new Map(invs.map((i) => [i.invoice_no, i.id]));
  const [custs] = await pool.query('SELECT id, name FROM customers');
  const custByName = new Map(custs.map((c) => [norm(c.name), c.id]));
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const [users] = await pool.query('SELECT id, display_name FROM users');
  const userByName = new Map(users.map((u) => [norm(u.display_name), u.id]));
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE '%Head Office%' LIMIT 1");
  const [[arAcct]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '12100' LIMIT 1");
  const [coas] = await pool.query('SELECT id, account_code FROM chart_of_accounts');
  const coaByCode = new Map(coas.map((c) => [String(c.account_code), c.id]));
  const [emps] = await pool.query("SELECT id, CONCAT(first_name,' ',last_name) nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));

  const [have] = await pool.query('SELECT credit_memo_no FROM credit_memos');
  const haveNo = new Set(have.map((r) => r.credit_memo_no));
  console.log(`Local: ${invByNo.size} invoice(s) to link against. ${haveNo.size} credit memo(s) already present.`);

  const token = await login();

  // Live COA pk -> account code, to resolve the account a memo debits.
  const coaPkToCode = new Map();
  for (let off = 0; off < 20000; off += PAGE) {
    const list = listRows(await api(token, 'get_chart_of_accounts', { searchKey: '', limit: PAGE, offset: off }));
    if (!list.length) break;
    for (const c of list) if (c.SysPK_COA && c.UserPK_COA) coaPkToCode.set(c.SysPK_COA, String(c.UserPK_COA));
    if (list.length < PAGE) break;
  }
  console.log(`Loaded ${coaPkToCode.size} live COA(s).`);

  // The Saved Credit Memos list, keyed by SysPK. Name_Empl (the Sales Rep shown on live's
  // header) exists ONLY here -- the field is absent from get_transactions entirely, so a
  // first run left sales_rep_id null on all 5,300 memos.
  const listBySysPk = new Map();
  for (let off = 0; off < 40000; off += PAGE) {
    const rows = listRows(await api(token, 'get_credit_memos', { searchKey: '', limit: PAGE, offset: off }));
    if (!rows.length) break;
    for (const r of rows) listBySysPk.set(r.SysPK_TransH, r);
    if (rows.length < PAGE) break;
  }
  console.log(`Live Saved Credit Memos: ${listBySysPk.size}.`);

  // Live invoice SysPK -> invoice number, so an application can be resolved to a local invoice.
  // Paged to exhaustion, NOT stopped at the first short page. Live returns a short page
  // transiently under load: a first run ended here at 10,000 of 81,585 invoices, which
  // silently unlinked most applications and looked like missing data rather than a bug.
  // Only two consecutive empty pages end it.
  const invPkToNo = new Map();
  let emptyStreak = 0;
  for (let off = 0; off < 400000; off += INV_PAGE) {
    let rows = [];
    try { rows = listRows(await api(token, 'get_invoices', { searchKey: '', limit: INV_PAGE, offset: off })); }
    catch (e) { console.warn(`  !! invoice page at ${off} failed: ${e.message}`); }
    if (!rows.length) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;
    for (const r of rows) if (r.SysPK_TransH && r.invc_pk) invPkToNo.set(r.SysPK_TransH, r.invc_pk);
    if (invPkToNo.size % 20000 < INV_PAGE) console.log(`  ...mapped ${invPkToNo.size} live invoice(s)`);
  }
  console.log(`Mapped ${invPkToNo.size} live invoice(s).\n`);
  if (invPkToNo.size < 50000) {
    throw new Error(`Only ${invPkToNo.size} live invoice(s) mapped -- too few to link against. Refusing to import with a truncated map.`);
  }

  let seen = 0, imported = 0, skippedExisting = 0, failed = 0;
  let appCount = 0, appLinked = 0, appUnresolved = 0, noApps = 0, custUnmatched = 0, srcUnresolved = 0, custCreated = 0;

  for (let off = 0; off < 40000; off += PAGE) {
    let page;
    try {
      page = listRows(await api(token, 'get_transactions', {
        where: { Module_TransH: 'CREDITMEMO' },
        include: ['transaction_transactionledgerentries', 'transaction_transactionledgertransactions', 'transaction_customer'],
        limit: PAGE, offset: off,
      }));
    } catch (e) {
      console.warn(`  !! page at offset ${off} failed after retries: ${e.message}`);
      failed += 1; continue;
    }
    if (!page.length) break;

    for (const h of page) {
      seen += 1;
      const cmNo = h.UserPK_TransH;
      if (!cmNo) { failed += 1; continue; }
      if (haveNo.has(cmNo)) { skippedExisting += 1; continue; }

      // customer_id is NOT NULL and rightly so -- the customer IS the party being credited,
      // so a memo without one is meaningless. 71 memos name a customer we do not hold, so
      // create it, the same way import-sales.js does for orders (it reported "customers
      // created: 179"). Dropping those memos instead would lose real credits.
      const meta = listBySysPk.get(h.SysPK_TransH) || {};
      const custName = h.transaction_customer?.Name_Cust || h.Name_Cust || meta.Name_Cust;
      let customerId = custByName.get(norm(custName)) || null;
      if (!customerId && custName && !DRY_RUN) {
        const [ins] = await pool.query('INSERT INTO customers (name, is_active) VALUES (?, 1)', [upperCustomerName(String(custName).slice(0, 255))]);
        customerId = ins.insertId;
        custByName.set(norm(custName), customerId);
        custCreated += 1;
      }
      if (!customerId) custUnmatched += 1;

      // Applications -> local invoices.
      const lts = (h.transaction_transactionledgertransactions || []).filter((t) => !t.IsVoided_LdgrTr);
      const applications = [];
      for (const t of lts) {
        appCount += 1;
        const invNo = invPkToNo.get(t.SysFK_TransHSL_LdgrTr) || null;
        const localInvId = invNo ? (invByNo.get(invNo) || null) : null;
        if (localInvId) appLinked += 1; else appUnresolved += 1;
        applications.push({
          sales_invoice_id: localInvId,
          invoice_no: invNo,
          applied_amount: round2(t.Amount_LdgrTr),
          // What that invoice still owed when the credit hit it -- live's "Original Amount Due".
          original_amount_due: round2(t.AmountDue_LdgrTr),
        });
      }
      if (!applications.length) noApps += 1;

      // The account this memo DEBITS, taken from the GENENTRY debit row rather than assumed.
      // A sales return debits 30100; CM-5290 debits 14200 Creditable Withholding Tax.
      const debitEntry = (h.transaction_transactionledgerentries || [])
        .find((e) => num(e.DRAmount_LdgrEntries) > 0);
      const sourceAccountId = debitEntry
        ? (coaByCode.get(coaPkToCode.get(debitEntry.SysFK_COA_LdgrEntries)) || null)
        : null;
      if (!sourceAccountId) srcUnresolved += 1;

      // The header's own invoice link is the first application that actually resolved.
      const primaryInvoiceId = applications.find((a) => a.sales_invoice_id)?.sales_invoice_id || null;
      const gross = round2(h.TotalAmount_TransH);
      const tax = round2(h.TaxAmount_TransH);
      const net = round2(h.SubTotalVatEx_TransH) || round2(gross - tax);
      const applied = round2(applications.reduce((s, a) => s + a.applied_amount, 0));

      if (DRY_RUN) {
        if (imported < 12) {
          console.log(`  ${cmNo} | ${day(h.DateCreated_TransH)} | ${custName || '(no customer)'}${customerId ? '' : ' [UNMATCHED]'} | ${gross.toFixed(2)} | apps: ${applications.map((a) => `${a.invoice_no || '?'}(${a.applied_amount})${a.sales_invoice_id ? '' : '[not local]'}`).join(', ') || 'none'}`);
        }
        imported += 1; continue;
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO credit_memos (credit_memo_no, sales_invoice_id, customer_id, sales_rep_id, date_created,
                                     office_location_id, ar_account_id, source_account_id, memo, subtotal,
                                     discount_amount, net_of_tax, tax_amount, gross_amount, applied_amount,
                                     status, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
          [
            // Sales Rep is PreparedBy_TransH -- who raised the memo. It sits on the
            // transaction itself, so no list lookup is needed for it.
            cmNo, primaryInvoiceId, customerId, empByName.get(norm(h.PreparedBy_TransH)) || null,
            dOrNull(h.DateCreated_TransH),
            locByName.get(norm(h.LocationName_TransH)) || headOffice?.id || null,
            arAcct?.id || null, sourceAccountId, h.Memo_TransH || null,
            net, net, tax, gross, applied,
            // Live leaves Status_TransH null on every credit memo; the local vocabulary is
            // 'open' | 'voided' (see routes/creditMemos.js), so anything not voided is open.
            norm(h.Status_TransH) === 'void' || norm(h.Status_TransH) === 'cancelled' ? 'voided' : 'open',
            userByName.get(norm(h.PreparedBy_TransH)) || null,
          ]
        );
        // Every application is stored, including those against invoices this database does
        // not hold -- the credit was still applied there, and dropping it would understate
        // the memo and unbalance its GL. invoice_no keeps live's number for display.
        for (const a of applications) {
          await conn.query(
            'INSERT INTO credit_memo_applications (credit_memo_id, sales_invoice_id, invoice_no, applied_amount, original_amount_due) VALUES (?, ?, ?, ?, ?)',
            [r.insertId, a.sales_invoice_id, a.invoice_no, a.applied_amount, a.original_amount_due]
          );
        }
        await conn.commit();
        haveNo.add(cmNo);
        imported += 1;
      } catch (e) {
        await conn.rollback();
        failed += 1;
        console.warn(`  !! ${cmNo} failed: ${e.message}`);
      } finally {
        conn.release();
      }
    }

    if (seen % 1000 < PAGE) console.log(`  ...${seen} seen | ${imported} imported, ${skippedExisting} already local, ${failed} failed`);
    if (page.length < PAGE) break;
  }

  console.log(`\nDone. Imported ${imported} credit memo(s).`);
  console.log(`Seen ${seen} | already local ${skippedExisting} | failed ${failed}.`);
  console.log(`Applications: ${appCount} total -- ${appLinked} linked to a local invoice, ${appUnresolved} to an invoice not held locally.`);
  console.log(`Credit memos with no application at all: ${noApps}. Customer unmatched: ${custUnmatched}, created: ${custCreated}. Debit account unresolved: ${srcUnresolved}.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
