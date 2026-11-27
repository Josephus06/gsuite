// One-off migration (2026-11-27): audit_logs.event_type takes 'Printed' and 'Reprinted'.
// POST /api/forms/:id/printed (Fuel Slip print-once) logs them, and the Fuel Issuance report reads
// them; without them the print failed with "Data truncated for column 'event_type'" and was rolled back.
//
//   node src/db/add-audit-print-events.js [--dry-run]
//
// The droplet, office and SM boxes replicate: run on ONE box (the droplet). Railway: run it there too.
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const ADD = ['Printed', 'Reprinted'];

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [[col]] = await pool.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'event_type'`);
  if (!col) throw new Error('audit_logs.event_type not found');
  const m = /^enum\((.*)\)$/i.exec(col.COLUMN_TYPE);
  if (!m) { console.log(`  = event_type is ${col.COLUMN_TYPE}, not an ENUM; nothing to do`); return; }
  const values = m[1].match(/'((?:[^']|'')*)'/g).map((v) => v.slice(1, -1).replace(/''/g, "'"));
  const missing = ADD.filter((v) => !values.includes(v));
  if (!missing.length) { console.log('  = Printed / Reprinted already allowed'); return; }
  const next = [...values, ...missing];
  const sql = `ALTER TABLE audit_logs MODIFY COLUMN event_type ENUM(${next.map((v) => pool.escape(v)).join(',')})${col.IS_NULLABLE === 'NO' ? ' NOT NULL' : ' NULL'}`;
  if (DRY_RUN) { console.log(`  ~ would run: ${sql}`); return; }
  await pool.query(sql);
  console.log(`  + added ${missing.join(', ')}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
