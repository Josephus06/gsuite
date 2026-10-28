// Give imported Check Voucher lines the DEPARTMENT the source records on each line (2026-10-28,
// asked alongside the liquidation bills: Journals and Checks with no department on the Income Statement).
//
// import-cheques.js looked for a department NAME on the entry (DepartmentName_LdgrEntries, which the
// source does not send) or on the header (almost always blank), so imported cheque lines came in
// without one. The source keeps it per ledger entry as a pk: SysFK_Dept_LdgrEntries. The importer
// now reads that; this fills the cheques imported before.
//
// The same approach as backfill-journal-line-departments.js: for each source cheque it finds the T1S
// cheque with the same number AND date, takes the entries the importer took (the 'X' ones), and
// matches them to T1S lines by position, requiring the same line count and the same amount on every
// line. Only a blank department is filled; anything set by hand stays.
//
//   node src/db/backfill-cheque-line-departments.js            # preview
//   node src/db/backfill-cheque-line-departments.js --apply    # writes a rollback file
//   node src/db/backfill-cheque-line-departments.js --rollback=rollback/cheque-line-dept-<stamp>.json
// Re-run whenever a department is added to T1S that the source already used.
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=').slice(1).join('=');
const PAGE = 200;
const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
const deptKey = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(t, ep, payload) {
  for (let a = 0; a < 5; a += 1) {
    try { return await L.api(t, ep, payload); } catch (e) { if (a === 4) throw e; await sleep(3000 * (a + 1)); }
  }
  return null;
}

// The amount import-cheques.js stored for an entry.
const entryAmount = (e) => {
  const gross = num(e.GrossAmount_LdgrEntries) || num(e.DRAmount_LdgrEntries);
  return num(num(e.DRAmount_LdgrEntries) || (gross - num(e.TaxAmount_LdgrEntries)));
};

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLYING' : 'PREVIEW'}`);
  if (ROLLBACK) {
    const ids = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const [r] = await pool.query('UPDATE cheque_lines SET department_id = NULL WHERE id IN (?)', [ids.slice(i, i + 500)]);
      n += r.affectedRows;
    }
    console.log(`Department cleared again on ${n} cheque line(s).`);
    await pool.end();
    return;
  }

  const t = await L.login();
  const liveDepts = L.listRows(await api(t, 'get_departments', {}));
  const [localDepts] = await pool.query('SELECT id, name FROM departments');
  const byName = new Map(localDepts.map((d) => [deptKey(d.name), d.id]));
  const deptByLive = new Map(liveDepts.map((d) => [d.SysPK_Dept, byName.get(deptKey(d.Name_Dept || d.Title_Dept || d.name)) || null]));
  const unmappedDepts = new Set();

  const [mine] = await pool.query('SELECT id, cheque_no, date_created FROM cheques');
  const byNo = new Map();
  for (const c of mine) { if (!byNo.has(c.cheque_no)) byNo.set(c.cheque_no, []); byNo.get(c.cheque_no).push(c); }

  const stats = { seen: 0, noLocal: 0, countDiffers: 0, amountDiffers: 0, cheques: 0, lines: 0, noDeptInSource: 0 };
  const updates = []; // [line_id, department_id]
  for (let off = 0; off < 200000; off += PAGE) {
    const page = L.listRows(await api(t, 'get_transactions', {
      where: { Module_TransH: 'CHEQUE' }, include: ['transaction_transactionledgerentries'],
      order: [['ID_TransH', 'ASC']], limit: PAGE, offset: off,
    }));
    if (!page.length) break;
    for (const h of page) {
      stats.seen += 1;
      const local = (byNo.get(h.UserPK_TransH) || []).find((c) => day(c.date_created) === day(h.DateCreated_TransH));
      if (!local) { stats.noLocal += 1; continue; }
      const entries = (h.transaction_transactionledgerentries || []).filter((e) => e.Module_LdgrEntries === 'X');
      const [lines] = await pool.query('SELECT id, amount, department_id FROM cheque_lines WHERE cheque_id = ? ORDER BY line_no', [local.id]);
      if (lines.length !== entries.length) { stats.countDiffers += 1; continue; }
      if (lines.some((l, i) => num(l.amount) !== entryAmount(entries[i]))) { stats.amountDiffers += 1; continue; }
      let touched = false;
      lines.forEach((l, i) => {
        if (l.department_id) return;
        const pk = entries[i].SysFK_Dept_LdgrEntries;
        if (!pk) { stats.noDeptInSource += 1; return; }
        const dept = deptByLive.get(pk);
        if (!dept) { unmappedDepts.add(pk); return; }
        updates.push([l.id, dept]); stats.lines += 1; touched = true;
      });
      if (touched) stats.cheques += 1;
    }
    process.stdout.write(`\r  ${stats.seen} source cheques read, ${stats.lines} lines to fill`);
    if (page.length < PAGE) break;
  }
  console.log(`\n${JSON.stringify(stats)}`);
  const nameById = new Map(localDepts.map((d) => [d.id, d.name]));
  const perDept = new Map();
  for (const [, dept] of updates) perDept.set(dept, (perDept.get(dept) || 0) + 1);
  for (const [dept, n] of [...perDept].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${nameById.get(dept) || `#${dept}`}`);
  if (unmappedDepts.size) {
    const names = liveDepts.filter((d) => unmappedDepts.has(d.SysPK_Dept)).map((d) => d.Name_Dept || d.Title_Dept);
    console.log(`Source departments with no T1S match (${unmappedDepts.size}): ${names.join(', ')}`);
  }
  if (!APPLY || !updates.length) { if (!APPLY) console.log('\nPREVIEW -- nothing written. Re-run with --apply.'); await pool.end(); return; }

  const dir = path.join(__dirname, '..', '..', 'rollback');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `cheque-line-dept-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(updates.map(([id]) => id)));
  console.log(`Rollback (line ids that were blank): ${backup}`);
  let n = 0;
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [id, dept] of chunk) {
        const [r] = await conn.query('UPDATE cheque_lines SET department_id = ? WHERE id = ? AND department_id IS NULL', [dept, id]);
        n += r.affectedRows;
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); console.error(e.message); } finally { conn.release(); }
    await sleep(200); // gentle on the live box and on replication
  }
  console.log(`Department filled on ${n} cheque lines.`);
  await pool.end();
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
