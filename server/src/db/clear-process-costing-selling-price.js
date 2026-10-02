// Selling Price on Process Costing is now always Total Price rounded UP to the peso
// (shared/costing.js, 2026-10-02). This clears the stored per-bracket prices
// (process_cost_brackets.selling_price_override) the import carried from the old system, so the
// column cannot be mistaken for the price in force, and reports how far each price moved.
//
// Each cleared bracket gets a System Info line on its process ("1-269 · Selling Price", old ->
// the new computed price). A rollback file of every old value is written first.
//
//   node src/db/clear-process-costing-selling-price.js --dry-run
//   node src/db/clear-process-costing-selling-price.js
//   node src/db/clear-process-costing-selling-price.js --rollback=<file>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=').slice(1).join('=') || null;
const display = (v) => (v === null || v === undefined ? null : String(Number(v)));
const bracketName = (r) => `${display(r.qty_min) ?? '?'}-${display(r.qty_max) ?? '?'}`;

(async () => {
  // shared/costing.js is an ES module; load it the way server/src/lib/costing.js does.
  const { computeProcessCosting } = await import(`file://${path.resolve(__dirname, '../../../shared/costing.js').replace(/\\/g, '/')}`);
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");

  if (ROLLBACK) {
    const rows = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    if (!DRY) for (const r of rows) await pool.query('UPDATE process_cost_brackets SET selling_price_override = ? WHERE id = ?', [r.selling_price_override, r.id]);
    console.log(`${DRY ? 'Would restore' : 'Restored'} ${rows.length} stored price(s). (They take effect only if shared/costing.js reads them again.)`);
    await pool.end(); return;
  }

  const [rows] = await pool.query('SELECT * FROM process_cost_brackets WHERE selling_price_override IS NOT NULL');
  let up = 0; let down = 0; let same = 0; let maxUp = null; let maxDown = null;
  const plan = rows.map((r) => {
    // Total Price rounded up -- computed here rather than read from pricePerUnit, so this gives the
    // same answer whether or not the box already runs the new shared/costing.js.
    const now = Math.ceil(Number(computeProcessCosting({ ...r, selling_price_override: null }).priceUnrounded.toFixed(6)));
    const was = Number(r.selling_price_override);
    const d = now - was;
    if (Math.abs(d) < 0.005) same += 1; else if (d > 0) up += 1; else down += 1;
    if (!maxUp || d > maxUp.d) maxUp = { d, r, was, now };
    if (!maxDown || d < maxDown.d) maxDown = { d, r, was, now };
    return { id: r.id, process_id: r.process_id, qty_min: r.qty_min, qty_max: r.qty_max, selling_price_override: r.selling_price_override, now };
  });
  console.log(`${plan.length} bracket(s) carry a stored price. With Total Price rounded up: ${up} go up, ${down} go down, ${same} unchanged.`);
  if (maxUp) console.log(`  biggest rise: process ${maxUp.r.process_id} ${bracketName(maxUp.r)} ${maxUp.was} -> ${maxUp.now}`);
  if (maxDown) console.log(`  biggest fall: process ${maxDown.r.process_id} ${bracketName(maxDown.r)} ${maxDown.was} -> ${maxDown.now}`);
  // Brackets with no cost inputs at all: their only price WAS the stored one, so computing it
  // makes them 0. Listed so they can be costed before anyone quotes them.
  const zero = plan.filter((r) => r.now === 0 && Number(r.selling_price_override) > 0);
  if (zero.length) {
    const [names] = await pool.query('SELECT id, process_name FROM processes WHERE id IN (?)', [[...new Set(zero.map((r) => r.process_id))]]);
    const nameOf = new Map(names.map((n) => [n.id, n.process_name]));
    console.log(`  ${zero.length} bracket(s) on ${new Set(zero.map((r) => r.process_id)).size} process(es) have NO cost inputs, so their price would become 0, e.g.:`);
    for (const r of zero.sort((a, b) => b.selling_price_override - a.selling_price_override).slice(0, 15)) {
      console.log(`     ${nameOf.get(r.process_id) || r.process_id}  ${bracketName(r)}  was ${display(r.selling_price_override)}`);
    }
    if (process.argv.includes('--zero-list')) {
      fs.writeFileSync('zero-cost-brackets.json', JSON.stringify(zero.map((r) => ({ ...r, process_name: nameOf.get(r.process_id) }))));
    }
  }
  if (DRY || !plan.length) { await pool.end(); return; }

  const name = 'process-costing-selling-price-before-2026-10-02.json';
  const out = process.platform === 'win32' ? name : `/root/${name}`;
  fs.writeFileSync(out, JSON.stringify(plan));
  console.log(`Rollback file: ${out}`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of plan) {
      await conn.query('UPDATE process_cost_brackets SET selling_price_override = NULL WHERE id = ?', [r.id]);
      if (Math.abs(r.now - Number(r.selling_price_override)) >= 0.005) {
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
          [r.process_id, `${bracketName(r)} · Selling Price (now Total Price rounded up)`.slice(0, 150), display(r.selling_price_override), display(r.now), admin.id]);
      }
    }
    await conn.commit();
    console.log(`Cleared ${plan.length} stored price(s).`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
