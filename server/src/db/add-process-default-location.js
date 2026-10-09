// Default Location on processes (2026-10-09). The source's process set-up carries one (SysFK_Loc_Proc:
// BR-BLUEPRINT-100L-A0 -> Branch - Ayala); T1S had no column for it. Adds processes.default_location_id
// and fills it from the source, matched on process_code = UserPK_Proc and the location by name.
//
// Only fills a process whose default location is still empty -- one set in T1S is never overwritten.
// READ-ONLY against the source (get_processes, get_locations).
//   node src/db/add-process-default-location.js --dry-run
//   node src/db/add-process-default-location.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [cols] = await pool.query("SHOW COLUMNS FROM processes LIKE 'default_location_id'");
  if (!cols.length) {
    if (DRY_RUN) console.log('would add processes.default_location_id');
    else {
      await pool.query(`ALTER TABLE processes ADD COLUMN default_location_id BIGINT NULL AFTER base_unit_id,
        ADD CONSTRAINT fk_processes_default_location FOREIGN KEY (default_location_id) REFERENCES locations(id) ON DELETE SET NULL`);
      console.log('Added processes.default_location_id.');
    }
  }

  const t = await L.login();
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const locByLivePk = new Map();
  const unmatchedLocs = new Set();
  for (let off = 0; ; off += 200) {
    const rows = L.listRows(await L.api(t, 'get_locations', { searchKey: '', limit: 200, offset: off }));
    for (const l of rows) {
      const id = locByName.get(norm(l.Name_Loc));
      if (id) locByLivePk.set(l.SysPK_Loc, id); else unmatchedLocs.add(l.SysPK_Loc + ' ' + l.Name_Loc);
    }
    if (rows.length < 200) break;
  }

  const live = [];
  for (let off = 0; ; off += 500) {
    const page = L.listRows(await L.api(t, 'get_processes', { order: [['Name_Proc', 'ASC']], limit: 500, offset: off }));
    live.push(...page);
    if (page.length < 500) break;
  }
  const [local] = await pool.query(`SELECT id, process_code, ${cols.length ? 'default_location_id' : 'NULL AS default_location_id'} FROM processes`);
  const byCode = new Map(local.map((p) => [norm(p.process_code), p]));

  let set = 0; let already = 0; let noLoc = 0; let unresolved = 0; let notInT1s = 0;
  const updates = [];
  for (const p of live) {
    const mine = byCode.get(norm(p.UserPK_Proc));
    if (!mine) { notInT1s += 1; continue; }
    if (!p.SysFK_Loc_Proc) { noLoc += 1; continue; }
    const locId = locByLivePk.get(p.SysFK_Loc_Proc);
    if (!locId) { unresolved += 1; continue; }
    if (mine.default_location_id) { already += 1; continue; }
    updates.push([locId, mine.id]);
    set += 1;
  }
  console.log(`source processes ${live.length} | T1S ${local.length} | to fill ${set} | already set ${already} | source has none ${noLoc} | location not in T1S ${unresolved} | process not in T1S ${notInT1s}`);
  if (unresolved && unmatchedLocs.size) console.log(`  source locations with no T1S match: ${[...unmatchedLocs].slice(0, 10).join('; ')}`);

  if (!DRY_RUN && updates.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [locId, id] of updates) await conn.query('UPDATE processes SET default_location_id = ? WHERE id = ?', [locId, id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    console.log(`Filled ${updates.length} process(es).`);
  }
  const [dist] = await pool.query(
    `SELECT l.location_name, COUNT(*) AS n FROM processes p JOIN locations l ON l.id = p.default_location_id GROUP BY l.location_name ORDER BY n DESC`).catch(() => [[]]);
  dist.forEach((d) => console.log(`  ${d.location_name}: ${d.n}`));
  await pool.end();
}
main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
