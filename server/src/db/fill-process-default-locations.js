// Lookups > Processes (asked 2026-11-10): a process with no Default Location gets its department's
// warehouse from the first word of its Process Code --
//   DPOD-PRTG-LIQ-SHT-INKCOV-100%  ->  Warehouse - DPOD
//   SIGN-..., LFP-..., CNC-... / "CNC ETCHING"  ->  Warehouse - Sign / LFP / CNC
// Only blanks are filled: a process that already names a location keeps it.
//
//   node src/db/fill-process-default-locations.js            report only
//   node src/db/fill-process-default-locations.js --apply    write
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const PREFIXES = ['DPOD', 'SIGN', 'LFP', 'CNC'];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : '  (dry run)'}`);
  const [locs] = await pool.query("SELECT id, location_name FROM locations WHERE location_name LIKE 'Warehouse -%'");
  const warehouse = {};
  for (const p of PREFIXES) {
    const hit = locs.filter((l) => l.location_name.replace(/^Warehouse\s*-\s*/i, '').trim().toUpperCase() === p);
    if (hit.length !== 1) { console.log(`  ${p}: ${hit.length} warehouses named "Warehouse - ${p}" -- skipped`); continue; }
    warehouse[p] = hit[0];
  }
  const [rows] = await pool.query('SELECT id, process_code FROM processes WHERE default_location_id IS NULL');
  const byPrefix = {};
  for (const r of rows) {
    const first = String(r.process_code || '').trim().split(/[-\s]/)[0].toUpperCase();
    if (!warehouse[first]) continue;
    (byPrefix[first] = byPrefix[first] || []).push(r);
  }
  for (const [p, list] of Object.entries(byPrefix)) {
    console.log(`  ${p}: ${list.length} process(es) with no default location -> ${warehouse[p].location_name} (id ${warehouse[p].id}); e.g. ${list.slice(0, 3).map((r) => r.process_code).join(', ')}`);
    if (APPLY) {
      const [res] = await pool.query('UPDATE processes SET default_location_id = ? WHERE default_location_id IS NULL AND id IN (?)', [warehouse[p].id, list.map((r) => r.id)]);
      console.log(`     updated ${res.affectedRows}`);
    }
  }
  const other = rows.filter((r) => !warehouse[String(r.process_code || '').trim().split(/[-\s]/)[0].toUpperCase()]);
  console.log(`  left blank (first word is none of ${PREFIXES.join(', ')}): ${other.length}${other.length ? `; e.g. ${other.slice(0, 5).map((r) => r.process_code).join(', ')}` : ''}`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
