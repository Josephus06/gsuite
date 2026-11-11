// Installation Planner > Delays (asked 2026-11-11): a phase could not be worked on its day (bad weather,
// site not ready) -- the planner records the day(s) lost and the reason, and the phase, every later
// phase and their crew slots are pushed back by N days. Dragging a project's bar can likewise carry its
// phases and crew along.
//
// Both are reschedule requests (installation_reschedule_requests), so they share the SBU approval and
// the history: when the project's end date moves, the SBU decides; a delay that fits inside the current
// timeline is applied at once (recorded as approved by the planner).
//
//   kind          'reschedule' (the drag, as before) or 'delay'
//   phase_id      the delayed phase; work_type_name keeps its name if the phase is later removed
//   lost_from/to  the day(s) not worked
//   shift_days    how far the phase (from lost_from on) and the later phases move
//   move_phases   a drag that moves the phases and crew by the start's shift
//   result_note   what was moved when it was applied, and any crew slot that could not move (clash)
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-installation-phase-delays.js
require('dotenv').config();
const pool = require('../db');

const COLUMNS = [
  ['kind', "ENUM('reschedule', 'delay') NOT NULL DEFAULT 'reschedule' AFTER project_id"],
  ['phase_id', 'BIGINT NULL AFTER kind'],
  ['work_type_name', 'VARCHAR(100) NULL AFTER phase_id'],
  ['lost_from', 'DATE NULL AFTER work_type_name'],
  ['lost_to', 'DATE NULL AFTER lost_from'],
  ['shift_days', 'INT NULL AFTER lost_to'],
  ['move_phases', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER shift_days'],
  ['result_note', 'TEXT NULL AFTER decision_note'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const have = (await pool.query('SHOW COLUMNS FROM installation_reschedule_requests'))[0].map((c) => c.Field);
  for (const [name, def] of COLUMNS) {
    if (have.includes(name)) { console.log(`  ${name} already there`); continue; }
    await pool.query(`ALTER TABLE installation_reschedule_requests ADD COLUMN ${name} ${def}`);
    console.log(`  added ${name}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
