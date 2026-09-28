// Load the source system's 2025-12-31 closing position into T1S as its opening balances.
// Tables: src/db/create-opening-balances.js. Reports read them through lib/openingBalances.js.
//
// Input is a snapshot directory of the source's own reports, pulled read-only on 2026-09-26/28:
//   tb.json   generate_trial_balance ['2025-12-31']: account tree, amounts on the leaves, and a
//             final {debit, credit} element with the report's own totals
//   ap.json   generate_ap_aging_details as of 2025-12-31 (parties with a balance)
//   ar.json   generate_ar_aging_details as of 2025-12-31 (parties with a balance)
//
// What it writes, replacing any earlier load for the same as-of date:
//   opening_gl_balances  balance-sheet accounts as they stood, with every income and expense
//                        account closed into Retained Earnings (29000) -- 2026 starts a new year.
//                        The source's own TB does not balance (2025-12-31: Dr 620,827,369.94 vs
//                        Cr 620,125,681.79); that difference goes to account 1 "Opening Balance"
//                        and is printed, never spread into another account. It waits for the
//                        accountant.
//   opening_ar_items / opening_ap_items   every open document, matched to the T1S invoice / bill
//                        with the same number where one exists, so 2026 settlements apply to it.
//
// ALWAYS run --dry-run first and read the tie-outs.
//   node src/db/load-opening-balances.js --dir=<snapshot dir> --dry-run
//   node src/db/load-opening-balances.js --dir=<snapshot dir>
const fs = require('fs');
const path = require('path');
const pool = require('../db');

// --as-of picks the snapshot date (default 2025-12-31, the books opening). --items-only loads just the
// AR/AP open items -- how the cut-over snapshot (2026-09-30) goes in without touching the GL opening,
// which stays at 2025-12-31.
const AS_OF = (process.argv.find((a) => a.startsWith('--as-of=')) || '').split('=')[1] || '2025-12-31';
const ITEMS_ONLY = process.argv.includes('--items-only');
const RETAINED_EARNINGS = '29000';
const OPENING_DIFFERENCE = '1';
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const DIR = arg('dir');
const DRY = process.argv.includes('--dry-run');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const peso = (n) => r2(n).toLocaleString('en-US', { minimumFractionDigits: 2 });

function readJson(name) {
  const f = path.join(DIR, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

// --- general ledger ---------------------------------------------------------------------------
function glFromTrialBalance(tb, coaByCode) {
  const leaves = [];
  const walk = (n, group) => {
    const kids = n.coaparent_chartofaccounts || [];
    if (!kids.length) { leaves.push({ code: String(n.UserPK_COA).trim(), title: n.Title_COA, amount: Number(n.amount || 0), group }); return; }
    kids.forEach((k) => walk(k, group));
  };
  let reportTotals = null;
  for (const g of tb) {
    if (!g.type) { reportTotals = g; continue; }
    for (const a of g.accounts || []) for (const x of a.account_ledgers || []) walk(x, g);
  }
  const balances = new Map(); // code -> debit-positive balance
  let closedToRe = 0;
  const missing = [];
  for (const l of leaves) {
    if (Math.abs(l.amount) < 0.005) continue;
    const debitSigned = l.group.normal === 'DEBIT' ? l.amount : -l.amount;
    if (l.group.type === 'INCOME' || l.group.type === 'EXPENSE') { closedToRe += debitSigned; continue; }
    if (!coaByCode.has(l.code)) { missing.push(l); continue; }
    balances.set(l.code, (balances.get(l.code) || 0) + debitSigned);
  }
  balances.set(RETAINED_EARNINGS, (balances.get(RETAINED_EARNINGS) || 0) + closedToRe);
  const total = [...balances.values()].reduce((s, v) => s + v, 0);
  const difference = r2(-total);
  if (Math.abs(difference) >= 0.005) balances.set(OPENING_DIFFERENCE, (balances.get(OPENING_DIFFERENCE) || 0) + difference);
  return { balances, closedToRe, difference, reportTotals, missing, leaves };
}

// --- AR / AP ------------------------------------------------------------------------------------
const AR_TYPES = { INVC: 'Invoice', CREDITMEMO: 'Credit Memo', CUSTPAYMENT: 'Unapplied Payment', JOURNAL: 'Journal', DELIVERYTICKET: 'Delivery Ticket', CUSTREFUND: 'Customer Refund' };
const AP_TYPES = { VENDORBILL: 'Bill', BILLCREDIT: 'Bill Credit', JOURNAL: 'Journal', BILLPAYMENT: 'Unapplied Payment' };

// The source's aging DETAIL lines carry every balance as a positive number; only the party's
// total_balance nets them (checked on the 2025-12-31 AP: ALPHA SYSTEMS' bills 266,212.35 less bill
// credit BC-4418 49,106.05 = its total 217,106.30). So the sign comes from the document type, and a
// journal from which side of the control account it hit. `increases` is the side that adds to
// what is owed: CR for AP, DR for AR.
function signed(d, increases) {
  const m = d.Module_TransH;
  const bal = Math.abs(Number(d.balance) || 0);
  if (m === 'JOURNAL') {
    const dr = Number(d.DRAmount_LdgrEntries) || 0;
    const cr = Number(d.CRAmount_LdgrEntries) || 0;
    return (increases === 'CR' ? cr >= dr : dr >= cr) ? bal : -bal;
  }
  const reduces = ['BILLCREDIT', 'BILLPAYMENT', 'CREDITMEMO', 'CUSTPAYMENT'];
  return reduces.includes(m) ? -bal : bal;
}

function items(snapshot, typeMap, increases, mismatches) {
  const out = [];
  for (const party of snapshot.rows) {
    let partySum = 0;
    for (const d of party.details || []) {
      const balance = r2(signed(d, increases));
      partySum += balance;
      if (Math.abs(balance) < 0.005) continue;
      out.push({
        partyPk: party.SysPK_Cust || party.SysPK_Accnt || null,
        partyName: String(party.Name_Cust || party.Name_Accnt || '').trim(),
        docType: typeMap[d.Module_TransH] || d.Module_TransH || 'Other',
        docNo: String(d.UserPK_TransH || '').trim(),
        docPk: d.SysPK_TransH || null,
        docDate: d.DateCreated_TransH ? String(d.DateCreated_TransH).slice(0, 10) : null,
        dueDate: d.DateDue_TransH ? String(d.DateDue_TransH).slice(0, 10) : null,
        original: r2(d.AmountDueFixed_TransH || 0),
        balance,
      });
    }
    // Every party's lines must add up to the source's own total for that party.
    if (Math.abs(r2(partySum) - r2(party.total_balance)) >= 0.02) {
      mismatches.push(`${party.Name_Cust || party.Name_Accnt}: lines ${peso(partySum)} vs source total ${peso(party.total_balance)}`);
    }
  }
  // A document can appear on several lines for the same party (a journal with two lines on one
  // supplier); fold those into one item so the per-party document key stays unique.
  const merged = new Map();
  for (const i of out) {
    const k = `${i.partyPk}|${i.docType}|${i.docNo}`;
    const had = merged.get(k);
    if (had) { had.balance = r2(had.balance + i.balance); had.original = r2(had.original + i.original); } else merged.set(k, { ...i });
  }
  return [...merged.values()].filter((i) => Math.abs(i.balance) >= 0.005);
}

async function main() {
  if (!DIR) throw new Error('--dir=<snapshot directory> is required');
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? '   (DRY RUN -- nothing written)' : ''}\nSnapshot: ${DIR}\n`);

  const [coa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const coaByCode = new Map(coa.map((c) => [String(c.account_code).trim(), c]));
  for (const code of [RETAINED_EARNINGS, OPENING_DIFFERENCE]) if (!coaByCode.has(code)) throw new Error(`Account ${code} is missing from chart_of_accounts`);

  // ---- GL
  const tb = ITEMS_ONLY ? null : readJson('tb.json');
  if (!ITEMS_ONLY && !tb) throw new Error('tb.json is missing from the snapshot');
  const gl = tb ? glFromTrialBalance(tb, coaByCode) : { balances: new Map(), missing: [], difference: 0, closedToRe: 0, reportTotals: null };
  if (tb) {
  console.log('GENERAL LEDGER');
  console.log(`  source report totals   Dr ${peso(gl.reportTotals?.debit)}  Cr ${peso(gl.reportTotals?.credit)}`);
  console.log(`  2025 income - expense closed into Retained Earnings: ${peso(-gl.closedToRe)} (credit)`);
  console.log(`  accounts loaded: ${gl.balances.size}   missing from T1S chart: ${gl.missing.length}`);
  gl.missing.forEach((m) => console.log(`    MISSING ${m.code} ${m.title} ${peso(m.amount)}`));
  console.log(`  OPENING BALANCE DIFFERENCE (source TB out of balance) -> account ${OPENING_DIFFERENCE}: ${peso(gl.difference)}`);
  if (gl.missing.length) throw new Error('Some source accounts are not in the T1S chart of accounts; add them before loading.');
  } else console.log(`GENERAL LEDGER  -- skipped (--items-only); the GL opening stays as loaded`);

  const glCode = (predicate) => [...gl.balances].filter(([code]) => predicate(coaByCode.get(code))).reduce((s, [, v]) => s + v, 0);

  // ---- AP
  const apSnap = readJson('ap.json');
  let apItems = [];
  if (apSnap) {
    const apMismatch = [];
    apItems = items(apSnap, AP_TYPES, 'CR', apMismatch);
    const [sup] = await pool.query('SELECT id, live_pk FROM suppliers WHERE live_pk IS NOT NULL');
    const supByPk = new Map(sup.map((s) => [s.live_pk, s.id]));
    const [bills] = await pool.query('SELECT id, bill_no FROM vendor_bills WHERE bill_no IN (?)', [apItems.map((i) => i.docNo).concat('')]);
    const billByNo = new Map(bills.map((b) => [b.bill_no, b.id]));
    for (const i of apItems) { i.partyId = supByPk.get(i.partyPk) || null; i.linkId = i.docType === 'Bill' ? (billByNo.get(i.docNo) || null) : null; }
    const apGl = -glCode((c) => /payable/i.test(c.account_name) && /trade|account/i.test(c.account_name));
    console.log('\nACCOUNTS PAYABLE');
    console.log(`  open items ${apItems.length}   total ${peso(apItems.reduce((s, i) => s + i.balance, 0))}   (source aging total ${peso(apSnap.sum)})`);
    console.log(`  GL accounts payable (trade) balance: ${peso(apGl)}`);
    console.log(`  suppliers unmatched: ${apItems.filter((i) => !i.partyId).length}   bills with no T1S bill: ${apItems.filter((i) => i.docType === 'Bill' && !i.linkId).length}`);
    const byType = {}; apItems.forEach((i) => { byType[i.docType] = (byType[i.docType] || 0) + i.balance; });
    console.log(`  by type: ${Object.entries(byType).map(([k, v]) => `${k} ${peso(v)}`).join(' | ')}`);
    console.log(`  suppliers whose lines do not add up to the source total: ${apMismatch.length}`);
    apMismatch.slice(0, 10).forEach((m) => console.log(`    ${m}`));
  }

  // ---- AR
  const arSnap = readJson('ar.json');
  let arItems = [];
  if (arSnap) {
    const arMismatch = [];
    arItems = items(arSnap, AR_TYPES, 'DR', arMismatch);
    const [cust] = await pool.query('SELECT id, name FROM customers');
    const custByName = new Map();
    for (const c of cust) { const k = String(c.name || '').trim().toUpperCase(); if (!custByName.has(k)) custByName.set(k, c.id); }
    const [invs] = await pool.query('SELECT id, invoice_no FROM sales_invoices WHERE invoice_no IN (?)', [arItems.map((i) => i.docNo).concat('')]);
    const invByNo = new Map(invs.map((v) => [v.invoice_no, v.id]));
    for (const i of arItems) { i.partyId = custByName.get(i.partyName.toUpperCase()) || null; i.linkId = i.docType === 'Invoice' ? (invByNo.get(i.docNo) || null) : null; }
    const arGl = glCode((c) => /receivable/i.test(c.account_name) && /trade|account/i.test(c.account_name));
    console.log('\nACCOUNTS RECEIVABLE');
    console.log(`  open items ${arItems.length}   total ${peso(arItems.reduce((s, i) => s + i.balance, 0))}   (source aging total ${peso(arSnap.sum)})`);
    console.log(`  GL accounts receivable (trade) balance: ${peso(arGl)}`);
    console.log(`  customers unmatched: ${arItems.filter((i) => !i.partyId).length}   invoices with no T1S invoice: ${arItems.filter((i) => i.docType === 'Invoice' && !i.linkId).length}`);
    const byType = {}; arItems.forEach((i) => { byType[i.docType] = (byType[i.docType] || 0) + i.balance; });
    console.log(`  by type: ${Object.entries(byType).map(([k, v]) => `${k} ${peso(v)}`).join(' | ')}`);
    console.log(`  customers whose lines do not add up to the source total: ${arMismatch.length}`);
    arMismatch.slice(0, 10).forEach((m) => console.log(`    ${m}`));
  } else {
    console.log('\nACCOUNTS RECEIVABLE  -- ar.json not in the snapshot yet, skipped');
  }

  if (DRY) { console.log('\nDry run: nothing written.'); await pool.end(); return; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (!ITEMS_ONLY) {
    await conn.query('DELETE FROM opening_gl_balances WHERE as_of = ?', [AS_OF]);
    const glRows = [...gl.balances].filter(([, v]) => Math.abs(v) >= 0.005).map(([code, v]) => {
      const a = coaByCode.get(code);
      const note = code === OPENING_DIFFERENCE ? 'Source trial balance out of balance at 2025-12-31 -- for the accountant'
        : code === RETAINED_EARNINGS ? `Includes 2025 net income ${peso(-gl.closedToRe)} closed from income/expense` : null;
      return [AS_OF, a.id, code, v > 0 ? r2(v) : 0, v < 0 ? r2(-v) : 0, note];
    });
    await conn.query('INSERT INTO opening_gl_balances (as_of, account_id, account_code, debit, credit, note) VALUES ?', [glRows]);
    }
    if (apSnap) {
      await conn.query('DELETE FROM opening_ap_items WHERE as_of = ?', [AS_OF]);
      for (let k = 0; k < apItems.length; k += 500) {
        await conn.query(
          `INSERT INTO opening_ap_items (as_of, supplier_id, source_supplier_pk, supplier_name, doc_type, doc_no, source_doc_pk, doc_date, due_date, original_amount, balance, vendor_bill_id) VALUES ?`,
          [apItems.slice(k, k + 500).map((i) => [AS_OF, i.partyId, i.partyPk, i.partyName, i.docType, i.docNo, i.docPk, i.docDate, i.dueDate, i.original, i.balance, i.linkId])],
        );
      }
    }
    if (arSnap) {
      await conn.query('DELETE FROM opening_ar_items WHERE as_of = ?', [AS_OF]);
      for (let k = 0; k < arItems.length; k += 500) {
        await conn.query(
          `INSERT INTO opening_ar_items (as_of, customer_id, source_customer_pk, customer_name, doc_type, doc_no, source_doc_pk, doc_date, due_date, original_amount, balance, sales_invoice_id) VALUES ?`,
          [arItems.slice(k, k + 500).map((i) => [AS_OF, i.partyId, i.partyPk, i.partyName, i.docType, i.docNo, i.docPk, i.docDate, i.dueDate, i.original, i.balance, i.linkId])],
        );
      }
    }
    await conn.commit();
    console.log(`\nLoaded: ${ITEMS_ONLY ? 0 : gl.balances.size} GL balances, ${apItems.length} AP items, ${arItems.length} AR items as of ${AS_OF}.`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err.message || err);
  await pool.end();
  process.exit(1);
});
