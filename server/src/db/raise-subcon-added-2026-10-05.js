// One-off: the 4 brackets sync-process-costing.js --add-only inserted on 2026-10-05 07:42 went in
// at the source's Sub Con, before the sync learned to add T1S's +8% (a4a25ba). Every other Sub Con
// is source x 1.08 (check-subcon-raise.js), so these were 8% under their neighbours.
//
// Each is raised only while it still holds the source value, so a second run changes nothing.
// Each change is written to the process's System Info.
//
//   node src/db/raise-subcon-added-2026-10-05.js --dry-run
//   node src/db/raise-subcon-added-2026-10-05.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const display = (v) => String(Number(v));
// process_code, qty range, Sub Con as the source has it
const TARGETS = [
  ['DPOD-SUBCON', 0.001, 1000000, 864],
  ['SUBCON-INSTL-BLDUP-LGHTD-HIGH', 0.001, 50, 126.5],
  ['SUBCON-STKR-INST-LOWEL-SQFT-601-900', 0.001, 1000000, 16],
  ['SUBCON-WALLMURAL-INST-SQFT-151-200', 151, 200, 26],
];

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
  let changed = 0;
  for (const [code, min, max, source] of TARGETS) {
    const [[b]] = await pool.query(
      `SELECT b.id, b.process_id, b.sub_con FROM process_cost_brackets b JOIN processes p ON p.id = b.process_id
        WHERE p.process_code = ? AND ABS(b.qty_min - ?) < 0.00005 AND ABS(b.qty_max - ?) < 0.00005`, [code, min, max]);
    if (!b) { console.log(`  ${code} ${min}-${max}: no such bracket -- skipped`); continue; }
    const want = Math.round(source * 1.08 * 10000) / 10000;
    if (Math.abs(Number(b.sub_con) - source) >= 0.00005) {
      console.log(`  ${code} ${min}-${max}: Sub Con is ${display(b.sub_con)}, not the source's ${source} -- left alone`);
      continue;
    }
    console.log(`  ${code} ${min}-${max}: Sub Con ${source} -> ${want}`);
    changed += 1;
    if (DRY) continue;
    await pool.query('UPDATE process_cost_brackets SET sub_con = ?, updated_at = NOW() WHERE id = ?', [want, b.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
      [b.process_id, `${min}-${max} · Sub Con (+8%, 2026-10-05)`, display(source), display(want), admin.id]);
  }
  console.log(`${changed} bracket(s) ${DRY ? 'would be raised' : 'raised'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
