// Backfill what import-nsso-chain.js left blank on a Non-Standard Job Order, from the source.
//
// Asked 2026-10-08 for NSJO-INT-1826-1-1. The chain importer created the JO and its process lines
// but never copied the Artist, the Layout job type or the Delivery Time, and a process line whose
// process name was not in T1S at the time came over with no process (two DPOD ink-coverage lines
// here, "DPOD - Printing Liquid - Sht - Ink Coverage - 1-5%", since added as process #1741).
//
// ONLY BLANKS ARE FILLED. Anything T1S already holds -- set or changed here since the import -- is
// left alone. Process lines are matched to the source's by position, and only when the item agrees,
// so a line that was added, removed or reordered in T1S is not touched.
//
// Source reads only (get_transactions, get_job_orders_for_cert, get_job_order). One audit row per
// field filled, under --by (default user #1, the admin who asked).
//
//   node src/db/backfill-nsjo-from-source.js NSJO-INT-1826-1-1 --dry-run
//   node src/db/backfill-nsjo-from-source.js NSJO-INT-1826-1-1[,NSJO-...]
// Droplet, office and SM replicate: run on ONE box (the droplet).
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;
const NUMBERS = [...new Set((process.argv.slice(2).find((a) => !a.startsWith('--')) || '').split(/[\s,]+/).filter(Boolean))];

const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ');
const norm = (s) => clean(s).toLowerCase();
// The source keeps a time as 1970-01-01T<UTC>; T1S stores the Manila wall-clock time (as import-rwip.js).
function manilaTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 19);
}

async function main() {
  if (!NUMBERS.length) { console.error('Give NSJO numbers: NSJO-INT-1826-1-1[,NSJO-...] [--dry-run]'); process.exit(2); }
  console.log(`${DRY_RUN ? 'DRY RUN -- ' : ''}Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const t = await L.login();

  const [emps] = await pool.query("SELECT id, CONCAT(TRIM(first_name), ' ', TRIM(last_name)) AS name, is_active FROM employees");
  const empByName = new Map();
  for (const e of emps) { if (!empByName.has(norm(e.name)) || e.is_active) empByName.set(norm(e.name), e.id); }
  const [ljts] = await pool.query('SELECT id, display_name FROM pms_job_types');
  const ljtByName = new Map(ljts.map((r) => [norm(r.display_name), r.id]));
  const [procs] = await pool.query('SELECT id, process_name FROM processes');
  const procByName = new Map(procs.map((r) => [norm(r.process_name), r.id]));
  const [invs] = await pool.query('SELECT id, item_code, display_name FROM inventories');
  const invIds = new Map();
  for (const i of invs) { invIds.set(norm(i.item_code), i.id); if (!invIds.has(norm(i.display_name))) invIds.set(norm(i.display_name), i.id); }

  for (const no of NUMBERS) {
    const [[jo]] = await pool.query('SELECT id, job_order_no, artist_id, layout_job_type_id, delivery_time FROM job_orders WHERE job_order_no = ?', [no]);
    if (!jo) { console.log(`${no}: not in T1S -- skipped.`); continue; }
    const nssoNo = no.replace(/^NSJO-/, 'NSSO-').replace(/-\d+-\d+$/, '');
    const h = L.listRows(await L.api(t, 'get_transactions', { where: { UserPK_TransH: nssoNo, Module_TransH: 'NONSALESORDER' }, limit: 1 }))[0];
    if (!h) { console.log(`${no}: ${nssoNo} not found in the source -- skipped.`); continue; }
    const liveJo = L.listRows(await L.api(t, 'get_job_orders_for_cert', { soPK: h.SysPK_TransH })).find((x) => x.UserPK_TransH === no);
    if (!liveJo) { console.log(`${no}: not on ${nssoNo} in the source -- skipped.`); continue; }
    const d = await L.api(t, 'get_job_order', { pk: liveJo.SysPK_TransH });
    const head = (Array.isArray(d.data) ? d.data[0] : null) || {};
    const srcLines = Array.isArray(d.data?.[2]) ? d.data[2] : [];

    const fills = [];
    const artistId = head.artist_name ? empByName.get(norm(head.artist_name)) : null;
    if (!jo.artist_id && artistId) fills.push(['artist_id', artistId, head.artist_name]);
    if (!jo.artist_id && head.artist_name && !artistId) console.log(`  ! artist "${head.artist_name}" is not an employee in T1S -- left blank`);
    const ljtId = head.DisplayName_JobT ? ljtByName.get(norm(head.DisplayName_JobT)) : null;
    if (!jo.layout_job_type_id && ljtId) fills.push(['layout_job_type_id', ljtId, head.DisplayName_JobT]);
    const time = manilaTime(head.DeliveryTime_TransH);
    if (!jo.delivery_time && time) fills.push(['delivery_time', time, time]);

    const [mine] = await pool.query('SELECT id, line_no, process_id, item_id FROM job_order_processes WHERE job_order_id = ? ORDER BY line_no, id', [jo.id]);
    const procFills = [];
    mine.forEach((m, idx) => {
      if (m.process_id) return;
      const s = srcLines[idx];
      if (!s?.Name_Proc) return;
      const srcItem = invIds.get(norm(s.UserPK_Invty)) ?? invIds.get(norm(s.SalesDescription_Invty)) ?? null;
      if (srcItem !== m.item_id) { console.log(`  ! line ${m.line_no}: item differs from the source's line ${idx + 1} -- left alone`); return; }
      const pid = procByName.get(norm(s.Name_Proc));
      if (!pid) { console.log(`  ! line ${m.line_no}: process "${s.Name_Proc}" is not in T1S -- left blank`); return; }
      procFills.push({ lineId: m.id, lineNo: m.line_no, pid, name: s.Name_Proc });
    });

    console.log(`${no} (#${jo.id})`);
    if (!fills.length && !procFills.length) { console.log('  nothing blank to fill.'); continue; }
    for (const [f, , label] of fills) console.log(`  ${DRY_RUN ? 'would set' : 'set'} ${f} = ${label}`);
    for (const p of procFills) console.log(`  ${DRY_RUN ? 'would set' : 'set'} line ${p.lineNo} process = ${p.name}`);
    if (DRY_RUN) continue;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [f, v] of fills) {
        await conn.query(`UPDATE job_orders SET ${f} = ? WHERE id = ? AND ${f} IS NULL`, [v, jo.id]);
      }
      for (const p of procFills) {
        await conn.query('UPDATE job_order_processes SET process_id = ? WHERE id = ? AND process_id IS NULL', [p.pid, p.lineId]);
      }
      const audits = [...fills.map(([f, , label]) => [f, label]), ...procFills.map((p) => [`line ${p.lineNo} process`, p.name])];
      for (const [field, value] of audits) {
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('JobOrder', ?, 'Updated', ?, NULL, ?, ?)`,
          [jo.id, String(field).slice(0, 150), String(value).slice(0, 2000), BY]);
      }
      await conn.commit();
    } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  }
  await pool.end();
}
main().catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
