// Office Supply Requisition Form (asked 2026-10-23), after the paper form:
//
//   Department / Date
//   QTY / PARTICULARS / REMARKS  (the lines)
//   Requested by (the filer) / Noted by: Department Head's Signature
//   Released by: HR Department / Received by: Employee's Signature
//
// Routed like every form since 2026-10-22: the requestor picks the Noter (optional) and the Approver.
//
//   form_office_supply_details  (new)  one row per form: its date
//   form_office_supply_items    (new)  the lines: qty, particulars, remarks
//
// form_requests.type is a VARCHAR, so the new type needs no change there.
//
//   node src/db/add-office-supply-form.js
// Safe to re-run. Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

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

  if (await tableExists('form_office_supply_details')) console.log('  form_office_supply_details already there -- skipped');
  else {
    await pool.query(`CREATE TABLE form_office_supply_details (
      form_request_id ${col.t} NOT NULL PRIMARY KEY,
      osr_date DATE NOT NULL,
      KEY idx_office_supply_date (osr_date),
      CONSTRAINT fk_fosd_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_office_supply_details');
  }

  if (await tableExists('form_office_supply_items')) console.log('  form_office_supply_items already there -- skipped');
  else {
    await pool.query(`CREATE TABLE form_office_supply_items (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      form_request_id ${col.t} NOT NULL,
      line_no INT NOT NULL DEFAULT 1,
      quantity DECIMAL(12,2) NOT NULL,
      particulars VARCHAR(500) NOT NULL,
      remarks VARCHAR(500) NULL,
      KEY idx_office_supply_items_form (form_request_id),
      CONSTRAINT fk_fosi_form FOREIGN KEY (form_request_id) REFERENCES form_requests(id) ON DELETE CASCADE
    )`);
    console.log('  created form_office_supply_items');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
