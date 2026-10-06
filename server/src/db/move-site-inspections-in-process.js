// Moves SITE INSPECTION Non-Standard Job Orders that have cleared the SBU gate to In Process /
// Site Inspection -- the rule from 2026-10-06 (routes/nonStandardJobOrders.js afterSbuGate): a
// site inspection has no layout, so it never goes to Design or an artist; Production closes it
// with Complete. Orders approved before the rule sit on "SBU Approved" waiting for a Forward, or
// were forwarded into the Design Supervisor's queue with no artist yet. Both move.
//
// Left alone: anything awaiting SBU approval or in Sales Revision (approval will move them),
// anything with an artist assigned (work already started), and cancelled / completed orders.
//
//   node src/db/move-site-inspections-in-process.js            # preview
//   node src/db/move-site-inspections-in-process.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const FROM_SUB_STATUSES = ['Pending', 'SBU Approved', 'For Design Supervisor'];
const STATUS = 'In Process';
const SUB_STATUS = 'Site Inspection';

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
  const [rows] = await pool.query(
    `SELECT id, nstdjo_no, status, sub_status FROM non_standard_job_orders
      WHERE job_type = 'SITE INSPECTION' AND sub_status IN (?) AND artist_employee_id IS NULL
        AND status NOT IN ('Cancelled', 'COMPLETED')
      ORDER BY id`,
    [FROM_SUB_STATUSES],
  );
  for (const r of rows) console.log(`  ${r.nstdjo_no}: ${r.status} / ${r.sub_status} -> ${STATUS} / ${SUB_STATUS}`);
  if (APPLY && rows.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const r of rows) {
        await conn.query('UPDATE non_standard_job_orders SET status = ?, sub_status = ?, updated_at = NOW() WHERE id = ?', [STATUS, SUB_STATUS, r.id]);
        for (const [field, oldValue, newValue] of [['status', r.status, STATUS], ['sub_status', r.sub_status, SUB_STATUS]]) {
          await conn.query(
            `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
             VALUES ('NonStandardJobOrder', ?, 'Status Change', ?, ?, ?, ?)`,
            [r.id, field, oldValue, newValue, admin.id]);
        }
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`${rows.length} site inspection(s) ${APPLY ? 'moved' : 'would move'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
