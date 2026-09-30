// Add the source's processes that T1S does not have yet (matched on process_code = UserPK_Proc).
// Insert-only: an existing process is never changed. An estimate or job order naming a process
// created in the source after the catalog was imported otherwise fails with "process_id cannot be
// null" (29 estimates on 2026-10-01).
//
// READ-ONLY against the source (get_processes, paged).
//   node src/db/import-missing-processes.js --dry-run
//   node src/db/import-missing-processes.js
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const clean = (s) => (s || '').toString().trim();

async function main() {
  const t = await L.login();
  const live = [];
  for (let off = 0; ; off += 500) {
    const page = L.listRows(await L.api(t, 'get_processes', { order: [['Name_Proc', 'ASC']], limit: 500, offset: off }));
    live.push(...page);
    if (page.length < 500) break;
  }
  const [local] = await pool.query('SELECT process_code FROM processes');
  const have = new Set(local.map((p) => clean(p.process_code).toLowerCase()));
  const [units] = await pool.query('SELECT id, code FROM units_of_measure');
  const unitId = new Map(units.map((u) => [clean(u.code).toLowerCase(), u.id]));
  const missing = live.filter((p) => clean(p.UserPK_Proc) && !have.has(clean(p.UserPK_Proc).toLowerCase()));
  console.log(`source processes ${live.length} | T1S ${local.length} | missing ${missing.length}`);
  for (const p of missing) {
    console.log(`  + ${clean(p.UserPK_Proc)}  ${clean(p.Name_Proc)}  [${clean(p.UOM_Proc)}]${p.IsActive_Proc ? '' : ' (inactive)'}`);
    if (DRY_RUN) continue;
    await pool.query('INSERT INTO processes (process_code, process_name, base_unit_id, is_active) VALUES (?, ?, ?, ?)',
      [clean(p.UserPK_Proc), clean(p.Name_Proc) || clean(p.UserPK_Proc), unitId.get(clean(p.UOM_Proc).toLowerCase()) || null, p.IsActive_Proc ? 1 : 0]);
  }
  console.log(DRY_RUN ? 'DRY RUN -- nothing written.' : `Added ${missing.length} process(es).`);
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
