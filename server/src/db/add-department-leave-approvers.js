// Lookups > Departments > Department Heads: "Approve leave" (asked 2026-10-19). Adds
// department_ticket_approvers.can_approve_leave -- the people who approve the Leave Applications
// filed from that department, once noted (routes/forms.js mayApprove). Off for everyone, so
// nothing changes until somebody is ticked: a department with nobody ticked keeps the Forms
// Approval page's approvers.
//
// Idempotent. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/add-department-leave-approvers.js --dry-run
//   node src/db/add-department-leave-approvers.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [[col]] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'department_ticket_approvers' AND COLUMN_NAME = 'can_approve_leave'`);
  if (col) console.log('= department_ticket_approvers.can_approve_leave already exists');
  else if (DRY_RUN) console.log('~ would add department_ticket_approvers.can_approve_leave');
  else {
    await pool.query(
      'ALTER TABLE department_ticket_approvers ADD COLUMN can_approve_leave TINYINT(1) NOT NULL DEFAULT 0 AFTER can_note_form');
    console.log('+ added department_ticket_approvers.can_approve_leave');
  }
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
