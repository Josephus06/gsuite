// One-off (2026-11-24): Pending Billing's "wt PAR&Pics" became two boxes, wt PAR and wt PICS. A hand tick
// made before the split meant BOTH were sent, so each 'par' mark is copied to a 'pics' mark for the same
// Job Order -- same sent date, same person, same time. A JO that already has a 'pics' mark is left alone,
// so running it twice changes nothing.
//
//   node src/db/copy-par-marks-to-pics.js [--dry-run]
//
// The droplet, office and SM boxes replicate: run on ONE box (the droplet).
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
// Only ticks made before the split -- later 'par' ticks are PAR alone.
const SPLIT_AT = process.argv.find((a) => a.startsWith('--before='))?.slice(9) || '2026-11-25 00:00:00';

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''} (par ticks made before ${SPLIT_AT})`);
  const [todo] = await pool.query(
    `SELECT p.target_id, p.marked_by_user_id, p.marked_at, p.sent_date
       FROM pending_billing_marks p
      WHERE p.target = 'par' AND p.marked_at < ?
        AND NOT EXISTS (SELECT 1 FROM pending_billing_marks q WHERE q.target = 'pics' AND q.target_id = p.target_id)`, [SPLIT_AT]);
  console.log(`  ${todo.length} 'par' tick(s) to copy to 'pics'`);
  if (DRY_RUN || !todo.length) return;
  for (const m of todo) {
    await pool.query(
      `INSERT IGNORE INTO pending_billing_marks (target, target_id, marked_by_user_id, marked_at, sent_date)
       VALUES ('pics', ?, ?, ?, ?)`, [m.target_id, m.marked_by_user_id, m.marked_at, m.sent_date]);
  }
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM pending_billing_marks WHERE target = 'pics'");
  console.log(`  + copied; 'pics' ticks now: ${n.n}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
