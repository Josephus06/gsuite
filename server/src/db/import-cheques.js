// Migrate Saved Cheques (CHK-####) and their expense lines from live.
//
// SHAPE ON LIVE:
//   get_cheques                                   -> the Saved Cheques list. This is the only
//                                                    place the bank account's NAME (Title_COA)
//                                                    and the payee name appear together, so it
//                                                    is fetched first and keyed by SysPK.
//   get_transactions {Module_TransH:'CHEQUE'}     -> the same documents WITH their ledger
//     + include transactionledgerentries             entries, 200 at a time. The entries come
//                                                    back on the paged query, so this costs ~80
//                                                    requests rather than one per cheque.
//
// A cheque's ledger entries mix two things:
//   Module_LdgrEntries = 'X'         -> the expense lines the user typed (what we import)
//   Module_LdgrEntries = 'GENENTRY'  -> the GL double entry live posted for it (DR payee /
//                                       CR bank). Those are derived, not source data, so they
//                                       are skipped -- the local GL is posted from the lines.
//
// RESUMABLE + IDEMPOTENT: cheques already present locally (by cheque_no) are skipped, so a
// re-run only brings in what is missing.
//
//   node src/db/import-cheques.js --dry-run
//   node src/db/import-cheques.js
//   node src/db/import-cheques.js --from=2021-01-01 --to=2026-12-31
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2021-01-01');
const TO = argVal('to', '2030-12-31');
const PAGE = 200;

const day = (v) => (v || '').toString().slice(0, 10);
const dOrNull = (v) => { const s = day(v); return s && s >= '1990-01-01' ? s : null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
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

// The live server intermittently times out under load; retry rather than lose a whole page.
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

// Live statuses seen on cheques: OPEN / VOID / CANCELLED / RELEASED.
//
// The local vocabulary is 'open' | 'void' -- NOT 'voided'. routes/cheques.js tests
// `status === 'void'` to decide whether the Void button and the GL reversal apply, and the
// view header reads the same value, so anything else renders a voided cheque as OPEN and
// leaves it lookng re-voidable.
function mapStatus(s) {
  const v = norm(s);
  if (v === 'void' || v === 'cancelled' || v === 'canceled') return 'void';
  if (v === 'released') return 'released';
  return 'open';
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Window ${FROM}..${TO}`);
  console.log(DRY_RUN ? 'DRY RUN -- fetch + report only.\n' : 'APPLYING.\n');

  // ---- local lookups -------------------------------------------------------------------
  const [coas] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const coaByCode = new Map(coas.map((c) => [String(c.account_code), c.id]));
  const coaByName = new Map(coas.map((c) => [norm(c.account_name), c.id]));
  const [sups] = await pool.query('SELECT id, name FROM suppliers');
  const supByName = new Map(sups.map((s) => [norm(s.name), s.id]));
  const [emps] = await pool.query("SELECT id, CONCAT(first_name,' ',last_name) nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));
  const [custs] = await pool.query('SELECT id, name FROM customers');
  const custByName = new Map(custs.map((c) => [norm(c.name), c.id]));
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const [depts] = await pool.query('SELECT id, name FROM departments');
  const deptByName = new Map(depts.map((d) => [norm(d.name), d.id]));
  const [taxes] = await pool.query('SELECT id, code FROM taxes');
  const taxByCode = new Map(taxes.map((t) => [norm(t.code), t.id]));
  const [users] = await pool.query('SELECT id, display_name FROM users');
  const userByName = new Map(users.map((u) => [norm(u.display_name), u.id]));
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE '%Head Office%' LIMIT 1");

  const [have] = await pool.query('SELECT cheque_no FROM cheques');
  const haveNo = new Set(have.map((r) => r.cheque_no));
  console.log(`Local already holds ${haveNo.size} cheque(s).`);

  const token = await login();

  // ---- live COA pk -> account code (line accounts arrive as UUIDs) ----------------------
  const coaPkToCode = new Map();
  for (let off = 0; off < 20000; off += PAGE) {
    const list = listRows(await api(token, 'get_chart_of_accounts', { searchKey: '', limit: PAGE, offset: off }));
    if (!list.length) break;
    for (const c of list) if (c.SysPK_COA && c.UserPK_COA) coaPkToCode.set(c.SysPK_COA, String(c.UserPK_COA));
    if (list.length < PAGE) break;
  }
  console.log(`Loaded ${coaPkToCode.size} live COA(s).`);

  // ---- the Saved Cheques list: bank account name + payee, keyed by SysPK ----------------
  const listBySysPk = new Map();
  for (let off = 0; off < 60000; off += PAGE) {
    const rows = listRows(await api(token, 'get_cheques', { searchKey: '', limit: PAGE, offset: off }));
    if (!rows.length) break;
    for (const r of rows) listBySysPk.set(r.SysPK_TransH, r);
    if (rows.length < PAGE) break;
  }
  console.log(`Live Saved Cheques: ${listBySysPk.size}.\n`);

  // ---- page the documents with their ledger entries ------------------------------------
  let seen = 0, imported = 0, lineCount = 0, skippedExisting = 0, outOfWindow = 0, failed = 0;
  const unresolvedBank = new Set();

  for (let off = 0; off < 60000; off += PAGE) {
    let page;
    try {
      page = listRows(await api(token, 'get_transactions', {
        where: { Module_TransH: 'CHEQUE' },
        include: ['transaction_transactionledgerentries', 'transaction_account', 'transaction_department'],
        limit: PAGE, offset: off,
      }));
    } catch (e) {
      console.warn(`  !! page at offset ${off} failed after retries: ${e.message}`);
      failed += 1; continue;
    }
    if (!page.length) break;

    for (const h of page) {
      seen += 1;
      const chequeNo = h.UserPK_TransH;
      if (!chequeNo) { failed += 1; continue; }
      const dateCreated = dOrNull(h.DateCreated_TransH);
      if (!dateCreated || dateCreated < FROM || dateCreated > TO) { outOfWindow += 1; continue; }
      if (haveNo.has(chequeNo)) { skippedExisting += 1; continue; }

      const meta = listBySysPk.get(h.SysPK_TransH) || {};

      // Payee: live records a single name; try vendor, then employee, then customer, and keep
      // the name regardless so the document still reads correctly when nothing matches.
      const payeeName = h.PayeeName_TransH || meta.Name_Accnt || h.transaction_account?.Name_Accnt || null;
      const pn = norm(payeeName);
      let payeeType = null; let payeeId = null;
      if (supByName.has(pn)) { payeeType = 'supplier'; payeeId = supByName.get(pn); }
      else if (empByName.has(pn)) { payeeType = 'employee'; payeeId = empByName.get(pn); }
      else if (custByName.has(pn)) { payeeType = 'customer'; payeeId = custByName.get(pn); }

      // Bank account: only the list endpoint names it (Title_COA).
      let accountId = coaByName.get(norm(meta.Title_COA)) || null;
      if (!accountId && h.SysFK_COA_TransH) accountId = coaByCode.get(coaPkToCode.get(h.SysFK_COA_TransH)) || null;
      if (!accountId && meta.Title_COA) unresolvedBank.add(meta.Title_COA);

      const entries = (h.transaction_transactionledgerentries || []).filter((e) => e.Module_LdgrEntries === 'X');
      const lines = entries.map((e, i) => {
        const acct = coaByCode.get(coaPkToCode.get(e.SysFK_COA_LdgrEntries)) || null;
        const gross = num(e.GrossAmount_LdgrEntries) || num(e.DRAmount_LdgrEntries);
        const tax = num(e.TaxAmount_LdgrEntries);
        const wtax = num(e.WTAXAmount_LdgrEntries);
        return {
          line_no: i + 1,
          account_id: acct,
          department_id: deptByName.get(norm(e.DepartmentName_LdgrEntries || h.transaction_department?.Name_Dept)) || null,
          description: e.Particulars_LdgrEntries || e.Memo_LdgrEntries || null,
          amount: num(e.DRAmount_LdgrEntries) || (gross - tax),
          tax_code_id: taxByCode.get(norm(e.TaxCode_LdgrEntries)) || null,
          tax_amount: tax,
          apply_withholding_tax: e.IsWithhold_LdgrEntries ? 1 : 0,
          withholding_tax_amount: wtax,
          gross_amount: gross,
          total_amount: gross - wtax,
        };
      });

      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      const taxAmount = lines.reduce((s, l) => s + l.tax_amount, 0);
      const wtaxAmount = lines.reduce((s, l) => s + l.withholding_tax_amount, 0) || num(h.WTAXAmount_TransH);
      const grossAmount = lines.reduce((s, l) => s + l.gross_amount, 0) || num(h.TotalAmount_TransH);
      const totalAmount = num(meta.TotalAmount_TransH) || num(h.TotalAmount_TransH) || (grossAmount - wtaxAmount);

      if (DRY_RUN) {
        if (imported < 15) {
          console.log(`  ${chequeNo} | ${dateCreated} | ${payeeName || '(no payee)'} | bank=${meta.Title_COA || '?'}${accountId ? '' : ' [UNRESOLVED]'} | chk#${meta.CheckNo_TransH || ''} | ${totalAmount.toFixed(2)} | ${lines.length} line(s)`);
        }
        imported += 1; lineCount += lines.length; continue;
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO cheques (cheque_no, date_created, payee_type, payee_id, payee_name, office_location_id,
                                account_id, cheque_date, cheque_number, date_released, currency, conversion_rate, memo,
                                subtotal, discount_amount, net_of_tax, tax_amount, withholding_tax_amount,
                                gross_amount, total_amount, status, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
          [
            chequeNo, dateCreated, payeeType, payeeId, payeeName,
            locByName.get(norm(h.LocationName_TransH)) || headOffice?.id || null,
            accountId, dOrNull(meta.CheckDate_TransH || h.CheckDate_TransH), meta.CheckNo_TransH || h.CheckNo_TransH || null,
            dOrNull(h.DateDue_TransH), h.Currency_TransH || 'PHP', num(h.Conversion_TransH) || 1,
            h.Memo_TransH || meta.Memo_TransH || null,
            subtotal, subtotal, taxAmount, wtaxAmount, grossAmount, totalAmount,
            mapStatus(meta.Status_TransH || h.Status_TransH),
            userByName.get(norm(h.PreparedBy_TransH || meta.PreparedBy_TransH)) || null,
          ]
        );
        for (const l of lines) {
          await conn.query(
            `INSERT INTO cheque_lines (cheque_id, line_no, account_id, department_id, description, amount,
                                       tax_code_id, tax_amount, apply_withholding_tax, withholding_tax_amount,
                                       gross_amount, total_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.insertId, l.line_no, l.account_id, l.department_id, l.description, l.amount,
              l.tax_code_id, l.tax_amount, l.apply_withholding_tax, l.withholding_tax_amount,
              l.gross_amount, l.total_amount]
          );
        }
        await conn.commit();
        haveNo.add(chequeNo);
        imported += 1; lineCount += lines.length;
      } catch (e) {
        await conn.rollback();
        failed += 1;
        console.warn(`  !! ${chequeNo} failed: ${e.message}`);
      } finally {
        conn.release();
      }
    }

    if (seen % 1000 < PAGE) console.log(`  ...${seen} seen | ${imported} imported, ${skippedExisting} already local, ${failed} failed`);
    if (page.length < PAGE) break;
  }

  console.log(`\nDone. Imported ${imported} cheque(s) with ${lineCount} line(s).`);
  console.log(`Seen ${seen} | already local ${skippedExisting} | outside window ${outOfWindow} | failed ${failed}.`);
  if (unresolvedBank.size) {
    console.log(`\n!! ${unresolvedBank.size} bank account name(s) had no local chart_of_accounts match -- those cheques carry a NULL account_id:`);
    console.log(`   ${[...unresolvedBank].slice(0, 20).join(' | ')}`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
