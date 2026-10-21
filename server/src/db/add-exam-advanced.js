// Examinations, second round (asked 2026-10-21):
//
//   exam_sets.mode / rules          RANDOM sets: rules like "10 Machinery + 5 Safety (hard)" drawn
//                                   from the bank for each examinee when they start, so no two
//                                   co-workers get the same questions. mode 'fixed' is the old list.
//   exam_questions.image_data       a picture on a question ("identify this machine part")
//   exam_attempts.reminded_3_at /   the deadline reminders sent (3 days before, the day before),
//                 reminded_1_at     once each
//   exam_schedules.overdue_notified_at  the "N did not take it" note to the schedule's creator, once
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-exam-advanced.js
require('dotenv').config();
const pool = require('../db');

const COLUMNS = [
  ['exam_sets', 'mode', "VARCHAR(10) NOT NULL DEFAULT 'fixed'"],
  ['exam_sets', 'rules', 'JSON NULL'],
  ['exam_questions', 'image_data', 'MEDIUMTEXT NULL'],
  ['exam_attempts', 'reminded_3_at', 'DATETIME NULL'],
  ['exam_attempts', 'reminded_1_at', 'DATETIME NULL'],
  ['exam_schedules', 'overdue_notified_at', 'DATETIME NULL'],
  // Enumeration (2026-10-21): each answer box marked, and HR's overrides of a box (a misspelling).
  ['exam_attempt_answers', 'item_marks', 'JSON NULL'],
  ['exam_attempt_answers', 'item_overrides', 'JSON NULL'],
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const [table, col, def] of COLUMNS) {
    const [c] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [col]);
    if (c.length) console.log(`  ${table}.${col} already there -- skipped`);
    else { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); console.log(`  added ${table}.${col}`); }
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
