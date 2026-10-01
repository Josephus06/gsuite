// Raise DL (process_cost_brackets.direct_labor) on every Process Costing bracket by a percentage --
// asked 2026-10-01: "add 8% to all DL in all processes".
//
// What it changes: direct_labor only. Selling Price is NOT recomputed -- every imported bracket
// carries a stored selling_price_override (see shared/costing.js), so estimates keep their prices
// and the increase shows in cost, GP and the bracket's Total Price. Assembly Builds post DL to the
// GL from the bracket (lib/glImpact.js), so builds from now on book the higher labour cost.
//
// Each change is written to the process's System Info like an edit made on the screen
// ("1-269 · DL (+8%, <tag>)", old -> new). The tag makes the run refuse to repeat itself, so DL
// can never be raised twice by re-running. A rollback file of every old value is written first.
//
//   node src/db/adjust-process-costing-dl.js --pct=8 --tag=2026-10-01 --dry-run
//   node src/db/adjust-process-costing-dl.js --pct=8 --tag=2026-10-01
//   node src/db/adjust-process-costing-dl.js --rollback=<file>      (puts every old value back)
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const DRY = process.argv.includes('--dry-run');
const display = (v) => (v === null || v === undefined ? null : String(Number(v)));
const bracketName = (r) => `${display(r.qty_min) ?? '?'}-${display(r.qty_max) ?? '?'}`;

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");

  if (arg('rollback')) {
    const rows = JSON.parse(fs.readFileSync(arg('rollback'), 'utf8'));
    for (const r of rows) {
      if (!DRY) {
        await pool.query('UPDATE process_cost_brackets SET direct_labor = ?, updated_at = NOW() WHERE id = ?', [r.direct_labor, r.id]);
        await pool.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
          [r.process_id, `${bracketName(r)} · DL (rolled back)`.slice(0, 150), display(r.new_dl), display(r.direct_labor), admin.id]);
      }
    }
    console.log(`${DRY ? 'Would restore' : 'Restored'} ${rows.length} bracket(s).`);
    await pool.end(); return;
  }

  const pct = Number(arg('pct')); const tag = arg('tag');
  if (!pct || !tag) throw new Error('Give --pct=8 --tag=<date or name of this run>.');
  const label = `DL (+${pct}%, ${tag})`;
  const [[done]] = await pool.query(
    "SELECT COUNT(*) n FROM audit_logs WHERE auditable_type = 'ProcessCosting' AND field_name LIKE ?", [`% · ${label}`]);
  if (Number(done.n)) throw new Error(`This run (${label}) has already been applied to ${done.n} bracket(s). Refusing to raise DL twice.`);

  const [rows] = await pool.query(
    'SELECT id, process_id, qty_min, qty_max, direct_labor FROM process_cost_brackets WHERE direct_labor > 0 ORDER BY process_id, qty_min');
  const factor = 1 + pct / 100;
  const plan = rows.map((r) => ({ ...r, new_dl: Math.round(Number(r.direct_labor) * factor * 10000) / 10000 }));
  const before = plan.reduce((s, r) => s + Number(r.direct_labor), 0);
  const after = plan.reduce((s, r) => s + r.new_dl, 0);
  console.log(`${plan.length} bracket(s) with a DL, across ${new Set(plan.map((r) => r.process_id)).size} process(es). Total DL ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  for (const r of plan.slice(0, 5)) console.log(`  process ${r.process_id} ${bracketName(r)}: ${display(r.direct_labor)} -> ${display(r.new_dl)}`);
  if (DRY) { await pool.end(); return; }

  // Kept somewhere a reboot does not clear (not /tmp).
  const name = `process-costing-dl-before-${tag}.json`.replace(/[^\w.-]/g, '_');
  const out = process.platform === 'win32' ? name : `/root/${name}`;
  fs.writeFileSync(out, JSON.stringify(plan));
  console.log(`Rollback file: ${out}`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of plan) {
      await conn.query('UPDATE process_cost_brackets SET direct_labor = ?, updated_at = NOW() WHERE id = ?', [r.new_dl, r.id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
        [r.process_id, `${bracketName(r)} · ${label}`.slice(0, 150), display(r.direct_labor), display(r.new_dl), admin.id]);
    }
    await conn.commit();
    console.log(`Raised DL by ${pct}% on ${plan.length} bracket(s).`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
