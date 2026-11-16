// JO punchlist / checklist (asked 2026-11-16): every regular Job Order's own lines -- the rows of its
// Processes table -- are ticked off one by one, so no item of the job is missed out.
//
//   job_order_checklist_items  one row per JO process line (job_order_process_id), kept in step with
//                              the Processes table by lib/joChecklist.js, plus any extra item typed
//                              in for that one job (job_order_process_id NULL, item_text set)
//
// A REQUIRED item still open stops a QC from completing the JO (routes/qualityInspections.js).
// Regular JOs only: not NSJO, RWIP or RFQC.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/create-jo-checklists.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS job_order_checklist_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_order_id INT NOT NULL,
    job_order_process_id INT NULL,
    item_text VARCHAR(255) NULL,
    is_required BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 0,
    is_done BOOLEAN NOT NULL DEFAULT FALSE,
    done_by_user_id INT NULL,
    done_at DATETIME NULL,
    note VARCHAR(500) NULL,
    created_by_user_id INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_joci_job_order (job_order_id),
    UNIQUE KEY uq_joci_process (job_order_process_id)
  )`);
  console.log('  job_order_checklist_items ready');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
