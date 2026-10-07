// Remarks on every request form (liquidation, payment, fund transfer, business trip, revolving
// fund): the filer's own note on the request, shown on the form and printed on it. Not the
// approver's per-line rejection remarks (form_request_items.rejection_remark) -- those say what
// to fix; this says whatever the filer wants the approvers to know.
const pool = require('../db');

(async () => {
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM form_requests LIKE 'remarks'");
    if (rows.length) console.log('form_requests.remarks exists');
    else {
      await pool.query('ALTER TABLE form_requests ADD COLUMN remarks VARCHAR(2000) NULL AFTER name');
      console.log('Added form_requests.remarks');
    }
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
