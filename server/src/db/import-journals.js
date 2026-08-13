// Migrate General Journals (JRNL-####) and their lines from live.
//
// SHAPE ON LIVE: get_transactions {Module_TransH:'JOURNAL'} with the ledger entries included
// on the paged query, so this costs ~30 requests rather than one per journal.
//
// WHICH ENTRIES ARE THE JOURNAL:
//   A journal's ledger entries come in two flavours, and unlike the cheque importer we cannot
//   simply take the 'X' ones. Manually keyed journals carry 'X' lines (what the user typed)
//   alongside the 'GENENTRY' pair live posted from them. But system-generated REVERSAL
//   journals -- the ones raised when a cheque is voided -- have NO 'X' lines at all: 245 of a
//   600-journal sample. Taking only 'X' would leave 41% of journals with no lines.
//   So: use 'X' when present, otherwise fall back to 'GENENTRY'. Both sets balance
//   (0 unbalanced 'X', 1 unbalanced 'GENENTRY' in that sample).
//
// SOURCE LINKAGE: a reversal names its cheque in the line memo ("Voided from CHK-5636").
// Parsing that is what lets a Cheque show its journal under Related Records -- live has no
// foreign key for it, only the sentence.
//
// RESUMABLE + IDEMPOTENT: journals already present locally (by journal_no) are skipped.
//
//   node src/db/import-journals.js --dry-run
//   node src/db/import-journals.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
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

  const [coas] = await pool.query('SELECT id, account_code FROM chart_of_accounts');
  const coaByCode = new Map(coas.map((c) => [String(c.account_code), c.id]));
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const [depts] = await pool.query('SELECT id, name FROM departments');
  const deptByName = new Map(depts.map((d) => [norm(d.name), d.id]));
  const [users] = await pool.query('SELECT id, display_name FROM users');
  const userByName = new Map(users.map((u) => [norm(u.display_name), u.id]));
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE '%Head Office%' LIMIT 1");
  // Cheque numbers -> local id, so a reversal can point back at what it reversed.
  const [chqs] = await pool.query('SELECT id, cheque_no FROM cheques');
  const chequeByNo = new Map(chqs.map((c) => [c.cheque_no, c.id]));

  const [have] = await pool.query('SELECT journal_no FROM journals');
  const haveNo = new Set(have.map((r) => r.journal_no));
  console.log(`Local already holds ${haveNo.size} journal(s). ${chequeByNo.size} cheque(s) available to link.`);

  const token = await login();

  const coaPkToCode = new Map();
  for (let off = 0; off < 20000; off += PAGE) {
    const list = listRows(await api(token, 'get_chart_of_accounts', { searchKey: '', limit: PAGE, offset: off }));
    if (!list.length) break;
    for (const c of list) if (c.SysPK_COA && c.UserPK_COA) coaPkToCode.set(c.SysPK_COA, String(c.UserPK_COA));
    if (list.length < PAGE) break;
  }
  console.log(`Loaded ${coaPkToCode.size} live COA(s).\n`);

  let seen = 0, imported = 0, lineCount = 0, skippedExisting = 0, failed = 0;
  let fromX = 0, fromGen = 0, noLines = 0, linkedToCheque = 0, unbalanced = 0;

  for (let off = 0; off < 60000; off += PAGE) {
    let page;
    try {
      page = listRows(await api(token, 'get_transactions', {
        where: { Module_TransH: 'JOURNAL' },
        include: ['transaction_transactionledgerentries', 'transaction_department'],
        limit: PAGE, offset: off,
      }));
    } catch (e) {
      console.warn(`  !! page at offset ${off} failed after retries: ${e.message}`);
      failed += 1; continue;
    }
    if (!page.length) break;

    for (const h of page) {
      seen += 1;
      const journalNo = h.UserPK_TransH;
      if (!journalNo) { failed += 1; continue; }
      if (haveNo.has(journalNo)) { skippedExisting += 1; continue; }

      const all = h.transaction_transactionledgerentries || [];
      const xs = all.filter((e) => e.Module_LdgrEntries === 'X');
      const entries = xs.length ? xs : all.filter((e) => e.Module_LdgrEntries === 'GENENTRY');
      if (xs.length) fromX += 1; else if (entries.length) fromGen += 1;
      if (!entries.length) { noLines += 1; }

      const lines = entries.map((e, i) => ({
        line_no: i + 1,
        account_id: coaByCode.get(coaPkToCode.get(e.SysFK_COA_LdgrEntries)) || null,
        department_id: deptByName.get(norm(h.transaction_department?.Name_Dept)) || null,
        // Live names the counterparty only by type on the entry; the id/name are not carried
        // on the ledger row, so the type is recorded and the rest left null.
        party_type: e.LedgerAccountType_LdgrEntries || null,
        debit: num(e.DRAmount_LdgrEntries),
        credit: num(e.CRAmount_LdgrEntries),
        memo: e.Memo_LdgrEntries || e.Particulars_LdgrEntries || null,
      }));

      const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
      if (lines.length && Math.abs(totalDebit - totalCredit) > 0.01) unbalanced += 1;

      // "Voided from CHK-5636" in a line memo, or the header memo, is the only link live keeps.
      const haystack = `${h.Memo_TransH || ''} ${lines.map((l) => l.memo || '').join(' ')}`;
      const m = /\b(CHK-\d+)\b/.exec(haystack);
      const sourceId = m ? (chequeByNo.get(m[1]) || null) : null;
      if (sourceId) linkedToCheque += 1;

      if (DRY_RUN) {
        if (imported < 12) {
          console.log(`  ${journalNo} | ${day(h.DateCreated_TransH)} | ${h.Status_TransH || 'SAVED'} | ${lines.length} line(s) via ${xs.length ? 'X' : 'GENENTRY'} | dr ${totalDebit.toFixed(2)} cr ${totalCredit.toFixed(2)}${m ? ` | -> ${m[1]}${sourceId ? '' : ' (not local)'}` : ''}`);
        }
        imported += 1; lineCount += lines.length; continue;
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT INTO journals (journal_no, date_created, location_id, currency, conversion, memo, status,
                                 total_debit, total_credit, source_type, source_id, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            journalNo, dOrNull(h.DateCreated_TransH), locByName.get(norm(h.LocationName_TransH)) || headOffice?.id || null,
            h.Currency_TransH || 'PHP', num(h.Conversion_TransH) || 1, h.Memo_TransH || null,
            (h.Status_TransH || 'SAVED').toString().toUpperCase(),
            totalDebit, totalCredit,
            sourceId ? 'cheque' : null, sourceId,
            userByName.get(norm(h.PreparedBy_TransH)) || null,
          ]
        );
        for (const l of lines) {
          await conn.query(
            `INSERT INTO journal_lines (journal_id, line_no, account_id, department_id, party_type, party_id, party_name, debit, credit, memo)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
            [r.insertId, l.line_no, l.account_id, l.department_id, l.party_type, l.debit, l.credit, l.memo]
          );
        }
        await conn.commit();
        haveNo.add(journalNo);
        imported += 1; lineCount += lines.length;
      } catch (e) {
        await conn.rollback();
        failed += 1;
        console.warn(`  !! ${journalNo} failed: ${e.message}`);
      } finally {
        conn.release();
      }
    }

    if (seen % 1000 < PAGE) console.log(`  ...${seen} seen | ${imported} imported, ${skippedExisting} already local, ${failed} failed`);
    if (page.length < PAGE) break;
  }

  console.log(`\nDone. Imported ${imported} journal(s) with ${lineCount} line(s).`);
  console.log(`Seen ${seen} | already local ${skippedExisting} | failed ${failed}.`);
  console.log(`Lines taken from X: ${fromX} | from GENENTRY (reversals): ${fromGen} | journals with no entries at all: ${noLines}.`);
  console.log(`Linked back to a local cheque: ${linkedToCheque}. Out of balance: ${unbalanced}.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
