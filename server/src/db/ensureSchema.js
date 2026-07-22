const pool = require('../db');

async function ensureAssignedAtColumn() {
  const [rows] = await pool.query("SHOW COLUMNS FROM tickets LIKE 'assigned_at'");
  if (rows.length === 0) {
    console.log('Adding missing tickets.assigned_at column...');
    await pool.query('ALTER TABLE tickets ADD COLUMN assigned_at DATETIME NULL AFTER assigned_by_user_id');
    console.log('tickets.assigned_at column added successfully.');
  }
}

module.exports = {
  ensureAssignedAtColumn,
};
