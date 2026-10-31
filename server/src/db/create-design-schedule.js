// Design > Design Schedule: the SBU's calendar of when a Job Order / Non-Standard Job Order should be
// drawn, and the Design Supervisor's confirmation of it (asked 2026-10-31).
//
// One row per scheduled order. The flow it carries:
//
//   Draft             the SBU has put the order on the calendar but not sent it yet
//   For Confirmation  forwarded to the Design Supervisors (forwarding also forwards the order itself
//                     into the design queue when it was still Pending / SBU Approved)
//   Rejected          a Design Supervisor turned the slot down, with a reason; the SBU can move it
//                     and forward again
//   Confirmed         accepted; the supervisor then assigns the artist through the existing
//                     assign-design / assign-artist endpoints, so the artist lives on the order and
//                     nowhere else -- "Assigned" and "Done" are read off the order, never stored here
//   Cancelled         withdrawn by the SBU
//
// A confirmed slot moved by one side is a PROPOSAL (proposed_start / proposed_end / proposed_by_side)
// until the other side accepts it: the Design Supervisor's move waits on the SBU, the SBU's on Design.
// The confirmed dates stay in force until then, so a rejected proposal leaves nothing to undo.
//
// Grants: System Admin full; the SBUs (is_sales_business_unit) view + add + edit; the Design
// Supervisors view + edit + approve; Artists view (they see their own assignments only).
//
// Idempotent -- safe to re-run:
//   node src/db/create-design-schedule.js
const pool = require('../db');

const ROUTE = '/design-schedule';
const NAME = 'Design Schedule';

async function grant(userIds, perms, label) {
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  const cols = Object.keys(perms);
  let added = 0;
  for (const userId of userIds) {
    const [[existing]] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [userId, page.id],
    );
    // Only ever widened: a re-run must not take back something granted by hand since.
    if (existing) {
      await pool.query(
        `UPDATE user_page_permissions SET ${cols.map((c) => `${c} = (${c} OR ?)`).join(', ')} WHERE id = ?`,
        [...cols.map((c) => perms[c]), existing.id],
      );
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`,
        [userId, page.id, ...cols.map((c) => perms[c])],
      );
      added += 1;
    }
  }
  console.log(`  ${label}: ${userIds.length} account(s), ${added} new row(s).`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_type ENUM('JO', 'NSTDJO') NOT NULL,
      order_id INT NOT NULL,
      scheduled_start DATETIME NOT NULL,
      scheduled_end DATETIME NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Draft',
      notes TEXT NULL,
      reject_reason TEXT NULL,
      proposed_start DATETIME NULL,
      proposed_end DATETIME NULL,
      proposed_by_side VARCHAR(10) NULL,
      proposed_by_user_id INT NULL,
      proposed_at DATETIME NULL,
      proposal_note TEXT NULL,
      created_by_user_id INT NOT NULL,
      forwarded_by_user_id INT NULL,
      forwarded_at DATETIME NULL,
      confirmed_by_user_id INT NULL,
      confirmed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_design_schedules_order (order_type, order_id),
      KEY idx_design_schedules_start (scheduled_start),
      KEY idx_design_schedules_status (status)
    )`);
  console.log('Table design_schedules ready.');

  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`Page ${ROUTE}: already registered (id ${page.id}).`);
  } else {
    const [[assigned]] = await pool.query("SELECT sort_order FROM pages WHERE route = '/assigned-jo'");
    const [r] = await pool.query(
      'INSERT INTO pages (route, name, sort_order) VALUES (?, ?, ?)', [ROUTE, NAME, assigned?.sort_order || 0],
    );
    page = { id: r.insertId };
    console.log(`Page ${ROUTE}: registered as "${NAME}" (id ${page.id}).`);
  }

  const ids = async (where) => (await pool.query(`SELECT id FROM users WHERE is_active = TRUE AND ${where}`))[0].map((u) => u.id);
  const all = { can_view: true, can_add: true, can_edit: true, can_delete: true, can_approve: true, can_print: true };
  await grant(await ids("account_type = 'System Admin'"), all, 'System Admin');
  await grant(await ids('is_sales_business_unit = TRUE'),
    { can_view: true, can_add: true, can_edit: true, can_delete: false, can_approve: false, can_print: false }, 'SBU');
  await grant(await ids('is_design_supervisor = TRUE'),
    { can_view: true, can_add: false, can_edit: true, can_delete: false, can_approve: true, can_print: false }, 'Design Supervisor');
  await grant(await ids("account_type = 'Artist'"),
    { can_view: true, can_add: false, can_edit: false, can_delete: false, can_approve: false, can_print: false }, 'Artist');

  console.log(`\nIt shows under Design as "${NAME}".`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
