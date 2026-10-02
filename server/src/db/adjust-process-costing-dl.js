// Raise one cost column on every Process Costing bracket by a percentage -- DL by default. Asked
// 2026-10-01: "add 8% to all DL in all processes", then "also in the Sub Con add 8%".
//
//   --field=direct_labor (DL, the default) | sub_con (Sub Con)
//
// What it changes: that one column only. Everything computed from it follows on screen (Mark-Up
// Sub Con is Sub Con x its %, then Total, Total Price, and Selling Price = Total Price rounded up,
// see shared/costing.js); saved estimates keep the prices they were quoted at. Assembly Builds post DL to the
// GL from the bracket (lib/glImpact.js), so builds from then on book the higher labour cost.
//
// Each change is written to the process's System Info like an edit made on the screen
// ("1-269 · DL (+8%, <tag>)", old -> new). The tag makes a run refuse to repeat itself, so a
// column can never be raised twice by re-running. A rollback file of every old value is written first.
//
//   node src/db/adjust-process-costing-dl.js --pct=8 --tag=2026-10-01 [--field=sub_con] --dry-run
//   node src/db/adjust-process-costing-dl.js --pct=8 --tag=2026-10-01 [--field=sub_con]
//   node src/db/adjust-process-costing-dl.js --rollback=<file>      (puts every old value back)
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const DRY = process.argv.includes('--dry-run');
const display = (v) => (v === null || v === undefined ? null : String(Number(v)));
const bracketName = (r) => `${display(r.qty_min) ?? '?'}-${display(r.qty_max) ?? '?'}`;
// The columns this may touch, with the screen's own label for the audit line.
const FIELDS = { direct_labor: 'DL', sub_con: 'Sub Con' };

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");

  if (arg('rollback')) {
    const rows = JSON.parse(fs.readFileSync(arg('rollback'), 'utf8'));
    for (const r of rows) {
      // The first (DL) file stored { direct_labor, new_dl }; later ones { field, old, new }.
      const field = r.field || 'direct_labor';
      const oldV = r.field ? r.old : r.direct_labor; const newV = r.field ? r.new : r.new_dl;
      if (!FIELDS[field]) throw new Error(`Unknown field in rollback file: ${field}`);
      if (!DRY) {
        await pool.query(`UPDATE process_cost_brackets SET ${field} = ?, updated_at = NOW() WHERE id = ?`, [oldV, r.id]);
        await pool.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
          [r.process_id, `${bracketName(r)} · ${FIELDS[field]} (rolled back)`.slice(0, 150), display(newV), display(oldV), admin.id]);
      }
    }
    console.log(`${DRY ? 'Would restore' : 'Restored'} ${rows.length} bracket(s).`);
    await pool.end(); return;
  }

  const field = arg('field') || 'direct_labor';
  if (!FIELDS[field]) throw new Error(`--field must be one of: ${Object.keys(FIELDS).join(', ')}`);
  const pct = Number(arg('pct')); const tag = arg('tag');
  if (!pct || !tag) throw new Error('Give --pct=8 --tag=<date or name of this run>.');
  const label = `${FIELDS[field]} (+${pct}%, ${tag})`;
  const [[done]] = await pool.query(
    "SELECT COUNT(*) n FROM audit_logs WHERE auditable_type = 'ProcessCosting' AND field_name LIKE ?", [`% · ${label}`]);
  if (Number(done.n)) throw new Error(`This run (${label}) has already been applied to ${done.n} bracket(s). Refusing to raise ${FIELDS[field]} twice.`);

  const [rows] = await pool.query(
    `SELECT id, process_id, qty_min, qty_max, ${field} AS old FROM process_cost_brackets WHERE ${field} > 0 ORDER BY process_id, qty_min`);
  const factor = 1 + pct / 100;
  const plan = rows.map((r) => ({ ...r, field, old: Number(r.old), new: Math.round(Number(r.old) * factor * 10000) / 10000 }));
  const before = plan.reduce((s, r) => s + r.old, 0);
  const after = plan.reduce((s, r) => s + r.new, 0);
  console.log(`${plan.length} bracket(s) with a ${FIELDS[field]}, across ${new Set(plan.map((r) => r.process_id)).size} process(es). Total ${FIELDS[field]} ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  for (const r of plan.slice(0, 5)) console.log(`  process ${r.process_id} ${bracketName(r)}: ${display(r.old)} -> ${display(r.new)}`);
  if (DRY || !plan.length) { await pool.end(); return; }

  // Kept somewhere a reboot does not clear (not /tmp).
  const name = `process-costing-${field === 'direct_labor' ? 'dl' : field.replace('_', '')}-before-${tag}.json`.replace(/[^\w.-]/g, '_');
  const out = process.platform === 'win32' ? name : `/root/${name}`;
  fs.writeFileSync(out, JSON.stringify(plan));
  console.log(`Rollback file: ${out}`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of plan) {
      await conn.query(`UPDATE process_cost_brackets SET ${field} = ?, updated_at = NOW() WHERE id = ?`, [r.new, r.id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
        [r.process_id, `${bracketName(r)} · ${label}`.slice(0, 150), display(r.old), display(r.new), admin.id]);
    }
    await conn.commit();
    console.log(`Raised ${FIELDS[field]} by ${pct}% on ${plan.length} bracket(s).`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
