// Employee Gate Pass form (asked 2026-10-14), after the paper slip:
//
//   Location / Date (valid only on the date indicated) / Destination
//   ITEMS -- Description, Department, Noted by ("all items should be listed & noted by the dept.
//            concerned")
//   PERSONNEL -- Name, Department, Purpose (the form's own Name / Department, and Purpose here)
//   Approved by: Department Head   -> the form's NOTE step (the department's heads, as other forms)
//   Noted by: HR Department        -> the form's APPROVE step (Forms Approval)
//   Checked & Released by: Security Guard on Duty, Time OUT / Time IN
//
//   form_gate_pass_details  (new)  one row per gate pass: location, date, destination, purpose, and
//                                  the guard's Time OUT / Time IN and who recorded each
//   form_gate_pass_items    (new)  the items carried out: description and department
//   pages /forms/gate-pass-guard   who may record Time OUT / IN (the guard on duty): Edit on it.
//                                  System Admins are given it; grant it to the guards' accounts.
//
// form_requests.type is a VARCHAR, so the new type needs no change there.
//
//   node src/db/add-gate-pass-form.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const GUARD_ROUTE = '/forms/gate-pass-guard';
const GUARD_PAGE = 'Gate Pass (Security Guard)';

async function tableExists(name) {
  const [[t]] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  return Number(t.n) > 0;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  // The parent's id type decides the foreign key's, so it is read rather than assumed.
  const [[col]] = await pool.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_requests' AND COLUMN_NAME = 'id'");

  if (await tableExists('form_gate_pass_details')) console.log('  form_gate_pass_details already there -- skipped');
  else {
    await pool.query(`CREATE TABLE form_gate_pass_details (
      form_request_id ${col.t} NOT NULL PRIMARY KEY,
      location_id BIGINT NULL,
      pass_date DATE NOT NULL,
      destination VARCHAR(255) NULL,
      purpose TEXT NULL,
      time_out DATETIME NULL,
      time_out_by_user_id BIGINT NULL,
      time_in DATETIME NULL,
      time_in_by_user_id BIGINT NULL,
      KEY idx_gate_pass_date (pass_date),
      CONSTRAINT fk_fgpd_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_gate_pass_details');
  }

  if (await tableExists('form_gate_pass_items')) console.log('  form_gate_pass_items already there -- skipped');
  else {
    await pool.query(`CREATE TABLE form_gate_pass_items (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      form_request_id ${col.t} NOT NULL,
      line_no INT NOT NULL DEFAULT 1,
      description VARCHAR(500) NOT NULL,
      department VARCHAR(150) NULL,
      KEY idx_gate_pass_items_form (form_request_id),
      CONSTRAINT fk_fgpi_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_gate_pass_items');
  }

  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [GUARD_ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    const [r] = await pool.query('INSERT INTO pages (name, route, sort_order, is_active) VALUES (?, ?, 7, TRUE)', [GUARD_PAGE, GUARD_ROUTE]);
    pageId = r.insertId;
    console.log(`  registered ${GUARD_ROUTE} (id ${pageId})`);
  } else console.log(`  page ${GUARD_ROUTE} already registered (id ${pageId})`);
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const u of admins) {
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, pageId]);
    if (p) await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_edit = TRUE WHERE id = ?', [p.id]);
    else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_edit) VALUES (?, ?, TRUE, TRUE)', [u.id, pageId]);
  }
  console.log(`  ${admins.length} System Admin(s) may record Time OUT / IN`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
