// Give imported journal lines the DEPARTMENT the source records on each line.
//
// import-journals.js took a line's department from the journal HEADER's department, which source
// journals almost never carry -- the source keeps it per ledger entry (SysFK_Dept_LdgrEntries). So
// nearly every imported line came in without one (2026-10-03: 7,873 of 7,873 lines in 2025, 6,415
// of 6,418 in 2026; reported on JRNL-6087, a 159-line payroll journal), and department reports
// and budgets could not see journal amounts.
//
// For each source journal it finds the T1S journal with the same number AND date (T1S journals
// that took a source number are different documents -- see doc-number collisions), takes the same
// entries the importer took ('X' when present, else 'GENENTRY'), and matches them to T1S lines by
// position, requiring the same line count and the same debit/credit on every line. Only a blank
// department is filled; anything set by hand stays.
//
//   node src/db/backfill-journal-line-departments.js            # preview
//   node src/db/backfill-journal-line-departments.js --apply    # backs up to /root/match2026/
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
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

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const t = await L.login();
  const liveDepts = L.listRows(await api(t, 'get_departments', {}));
  const [localDepts] = await pool.query('SELECT id, name FROM departments');
  const byName = new Map(localDepts.map((d) => [deptKey(d.name), d.id]));
  const deptByLive = new Map(liveDepts.map((d) => [d.SysPK_Dept, byName.get(deptKey(d.Name_Dept || d.Title_Dept || d.name)) || null]));
  const unmappedDepts = new Set();

  const [mine] = await pool.query('SELECT id, journal_no, date_created FROM journals');
  const byNo = new Map();
  for (const j of mine) { if (!byNo.has(j.journal_no)) byNo.set(j.journal_no, []); byNo.get(j.journal_no).push(j); }

  const stats = { seen: 0, noLocal: 0, countDiffers: 0, amountDiffers: 0, journals: 0, lines: 0, noDeptInSource: 0 };
  const updates = []; // [line_id, department_id]
  for (let off = 0; off < 100000; off += PAGE) {
    const page = L.listRows(await api(t, 'get_transactions', {
      where: { Module_TransH: 'JOURNAL' }, include: ['transaction_transactionledgerentries'],
      order: [['ID_TransH', 'ASC']], limit: PAGE, offset: off,
    }));
    if (!page.length) break;
    for (const h of page) {
      stats.seen += 1;
      const local = (byNo.get(h.UserPK_TransH) || []).find((j) => day(j.date_created) === day(h.DateCreated_TransH));
      if (!local) { stats.noLocal += 1; continue; }
      const all = h.transaction_transactionledgerentries || [];
      const xs = all.filter((e) => e.Module_LdgrEntries === 'X');
      const entries = xs.length ? xs : all.filter((e) => e.Module_LdgrEntries === 'GENENTRY');
      const [lines] = await pool.query('SELECT id, debit, credit, department_id FROM journal_lines WHERE journal_id = ? ORDER BY line_no', [local.id]);
      if (lines.length !== entries.length) { stats.countDiffers += 1; continue; }
      if (lines.some((l, i) => num(l.debit) !== num(entries[i].DRAmount_LdgrEntries) || num(l.credit) !== num(entries[i].CRAmount_LdgrEntries))) {
        stats.amountDiffers += 1; continue;
      }
      let touched = false;
      lines.forEach((l, i) => {
        if (l.department_id) return;
        const pk = entries[i].SysFK_Dept_LdgrEntries;
        if (!pk) { stats.noDeptInSource += 1; return; }
        const dept = deptByLive.get(pk);
        if (!dept) { unmappedDepts.add(pk); return; }
        updates.push([l.id, dept]); stats.lines += 1; touched = true;
      });
      if (touched) stats.journals += 1;
    }
    process.stdout.write(`\r  ${stats.seen} source journals read, ${stats.lines} lines to fill`);
    if (page.length < PAGE) break;
  }
  console.log(`\n${JSON.stringify(stats)}`);
  if (unmappedDepts.size) {
    const names = liveDepts.filter((d) => unmappedDepts.has(d.SysPK_Dept)).map((d) => d.Name_Dept || d.Title_Dept);
    console.log(`Source departments with no T1S match (${unmappedDepts.size}): ${names.join(', ')}`);
  }
  if (!APPLY || !updates.length) { await pool.end(); return; }

  const dir = '/root/match2026';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const backup = `${dir}/journal-line-departments-${Date.now()}.json`;
  fs.writeFileSync(backup, JSON.stringify(updates.map(([id]) => id)));
  console.log(`Backup (line ids that were blank): ${backup}`);
  let n = 0;
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [id, dept] of chunk) {
        const [r] = await conn.query('UPDATE journal_lines SET department_id = ? WHERE id = ? AND department_id IS NULL', [dept, id]);
        n += r.affectedRows;
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); console.error(e.message); } finally { conn.release(); }
    await sleep(200); // gentle on the live box and on replication
  }
  console.log(`Department filled on ${n} journal lines.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
