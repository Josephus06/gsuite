// Vendor Bills raised from a Liquidation, put under the department of whoever FILED the liquidation
// (asked 2026-10-28, from the Income Statement's 30625 Transportation Expenses: VB-24868 "Liquidation
// REQ-37 -- Angelica Vanzuela" and the rest sat under whatever department was typed on the form).
//
// Create Vendor Bill now fills each line with the filer's department (their employee record) --
// StandaloneVendorBillModal.jsx. This re-points the bills made before: every line of a non-cancelled
// bill whose form_request_id is a liquidation, to the filer's department, when it differs. A filer
// with no department on their employee record is listed and left alone. The bills post from their
// lines (lib/glImpact.js), so the Income Statement follows at once.
//
// Dry run unless --apply; --apply writes a rollback file of the old departments.
//   node src/db/backfill-liquidation-bill-departments.js [--apply]
//   node src/db/backfill-liquidation-bill-departments.js --rollback=rollback/liq-bill-dept-<stamp>.json
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=').slice(1).join('=');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLYING' : 'DRY RUN'}`);
  if (ROLLBACK) {
    const rows = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of rows) await pool.query('UPDATE vendor_bill_lines SET department_id = ? WHERE id = ?', [r.department_id, r.id]);
    console.log(`Restored ${rows.length} line(s).`);
    await pool.end();
    return;
  }

  const [lines] = await pool.query(
    `SELECT vbl.id, vbl.department_id, vb.bill_no, fr.request_no, u.display_name AS filer,
            e.department_id AS filer_dept, d.name AS filer_dept_name, od.name AS old_dept_name
       FROM vendor_bill_lines vbl
       JOIN vendor_bills vb ON vb.id = vbl.vendor_bill_id
       JOIN form_requests fr ON fr.id = vb.form_request_id AND fr.type = 'liquidation'
       LEFT JOIN users u ON u.id = fr.user_id
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN departments od ON od.id = vbl.department_id
      WHERE COALESCE(vb.status, '') NOT IN ('cancelled', 'void')
      ORDER BY vb.id, vbl.id`);

  const change = lines.filter((l) => l.filer_dept && Number(l.filer_dept) !== Number(l.department_id || 0));
  const noDept = [...new Set(lines.filter((l) => !l.filer_dept).map((l) => `${l.bill_no} (${l.request_no}, ${l.filer || 'unknown'})`))];
  const bills = new Set(change.map((l) => l.bill_no));
  console.log(`Liquidation bill lines: ${lines.length}; to re-point: ${change.length} on ${bills.size} bill(s).`);
  for (const l of change.slice(0, 60)) console.log(`  ${l.bill_no} ${l.request_no} ${l.filer}: ${l.old_dept_name || '(none)'} -> ${l.filer_dept_name}`);
  if (change.length > 60) console.log(`  ... and ${change.length - 60} more`);
  if (noDept.length) console.log(`\nFiler has no department on their employee record -- left alone (${noDept.length}):\n  ${noDept.join('\n  ')}`);

  if (!APPLY) { console.log('\nDRY RUN -- nothing written. Re-run with --apply.'); await pool.end(); return; }
  if (change.length) {
    const dir = path.join(__dirname, '..', '..', 'rollback');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `liq-bill-dept-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(change.map((l) => ({ id: l.id, department_id: l.department_id }))));
    for (const l of change) await pool.query('UPDATE vendor_bill_lines SET department_id = ? WHERE id = ?', [l.filer_dept, l.id]);
    console.log(`\nUpdated ${change.length} line(s). Rollback: ${file}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('ERR', e.message); await pool.end(); process.exit(1); });
