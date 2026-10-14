// Manual step pictures (asked 2026-10-14): a screenshot under any step of any guide in the Manual
// (/process-flow). The guides' text lives in the client (data/flows); a picture is keyed to it by
// the flow, the node (box) and the step's position. Stored here, shrunk by the browser first.
//
//   node src/db/add-manual-step-images.js
// Safe to re-run. Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_step_images (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      flow_key VARCHAR(40) NOT NULL,
      node_id VARCHAR(60) NOT NULL,
      step_index INT NOT NULL,
      mime_type VARCHAR(50) NOT NULL,
      image_data MEDIUMBLOB NOT NULL,
      uploaded_by_user_id BIGINT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_manual_step (flow_key, node_id, step_index)
    )`);
  console.log('manual_step_images ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
