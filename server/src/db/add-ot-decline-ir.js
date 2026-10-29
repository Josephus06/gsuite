// An Incident Report raised by itself when an ARTIST declines three overtime requests in a row within
// one month (asked 2026-10-29). lib/otDeclineIr.js does it, from the decline (routes/forms.js
// POST /:id/ot-respond).
//
// This sets up:
//   form_overtime_details.decline_violation_id   the charge a decline was counted into, so the same
//                                               declines never raise a second report
//   app_settings 'ot_decline_violation_type_id' the violation the charge is filed under. The list of
//                                               violations is HR's code of conduct (Manage Violations),
//                                               so an existing active one with "overtime" in its name
//                                               is used; only when there is none is one added --
//                                               "Declined Overtime (3 consecutive in a month)", minor --
//                                               which HR may rename or regrade there.
//   --type=<id>   use that violation instead.
//
//   node src/db/add-ot-decline-ir.js [--type=<id>]
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const TYPE_ARG = Number((process.argv.find((a) => a.startsWith('--type=')) || '').split('=')[1]) || null;
const KEY = 'ot_decline_violation_type_id';

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[col]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'form_overtime_details' AND column_name = 'decline_violation_id'`);
  if (!col.n) {
    await pool.query('ALTER TABLE form_overtime_details ADD COLUMN decline_violation_id BIGINT NULL');
    console.log('  form_overtime_details.decline_violation_id added');
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
      name VARCHAR(64) PRIMARY KEY,
      value VARCHAR(255) NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  let type = null;
  if (TYPE_ARG) {
    [[type]] = await pool.query('SELECT id, code, name, severity FROM hr_violation_types WHERE id = ?', [TYPE_ARG]);
    if (!type) throw new Error(`No violation with id ${TYPE_ARG}.`);
  } else {
    const [[set]] = await pool.query('SELECT value FROM app_settings WHERE name = ?', [KEY]);
    if (set) [[type]] = await pool.query('SELECT id, code, name, severity FROM hr_violation_types WHERE id = ?', [Number(set.value)]);
    if (!type) {
      [[type]] = await pool.query(
        "SELECT id, code, name, severity FROM hr_violation_types WHERE is_active = 1 AND name LIKE '%overtime%' ORDER BY id LIMIT 1");
    }
    if (!type) {
      const [r] = await pool.query(
        `INSERT INTO hr_violation_types (name, category, severity, description, is_active)
         VALUES ('Declined Overtime (3 consecutive in a month)', NULL, 'minor',
                 'Raised by the system when an artist declines three overtime requests in a row within one month.', 1)`);
      [[type]] = await pool.query('SELECT id, code, name, severity FROM hr_violation_types WHERE id = ?', [r.insertId]);
      console.log(`  violation added: #${type.id} ${type.name} -- rename or regrade it in HRD > Manage Violations`);
    }
  }
  await pool.query('INSERT INTO app_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, String(type.id)]);
  console.log(`  automatic IRs are filed under #${type.id} ${[type.code, type.name].filter(Boolean).join(' ')} (${type.severity})`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
