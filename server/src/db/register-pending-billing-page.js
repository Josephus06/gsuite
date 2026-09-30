// Registers Sales > Pending Billing (/reports/pending-billing) in `pages`. Without the row,
// requirePermission refuses everyone -- as a 500 on some installs (see
// register-profitability-report-page.js). Access is seeded from Sales Orders: whoever can view
// Sales Orders can view this (it shows the same orders), and System Admins get full access.
//
// Idempotent -- safe to re-run, and --env picks the install:
//   node src/db/register-pending-billing-page.js [--dry-run] [--env=railway]
const envName = require('./lib/env')();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/reports/pending-billing';
const NAME = 'Pending Billing';
const MODULE = 'Sales';

async function main() {
  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${envName ? ` (--env=${envName})` : ''}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) console.log(`Page ${ROUTE} already registered (id ${page.id}).`);
  else if (!DRY_RUN) {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name']; const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push(MODULE); }
    const [r] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
    page = { id: r.insertId };
    console.log(`Registered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  } else console.log(`Would register ${ROUTE}.`);
  if (!page) { await pool.end(); return; }

  const [[so]] = await pool.query("SELECT id FROM pages WHERE route = '/sales-orders'");
  const [viewers] = so ? await pool.query(
    'SELECT user_id, can_print FROM user_page_permissions WHERE page_id = ? AND can_view = TRUE', [so.id]) : [[]];
  const [admins] = await pool.query("SELECT id AS user_id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  let added = 0;
  for (const v of [...viewers, ...admins.map((a) => ({ ...a, admin: true }))]) {
    const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [v.user_id, page.id]);
    if (existing) continue;
    added += 1;
    if (DRY_RUN) continue;
    await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print)
       VALUES (?, ?, TRUE, ?, ?, ?, ?, ?)`,
      [v.user_id, page.id, !!v.admin, !!v.admin, !!v.admin, !!v.admin, v.admin ? true : !!v.can_print]);
  }
  console.log(`${DRY_RUN ? 'Would grant' : 'Granted'} access to ${added} user(s) (Sales Orders viewers + System Admins).`);

  // The report's lookups, none of which had an index (the first version took ~30 s without them).
  for (const [name, table, column] of [
    ['idx_jo_production_stage', 'job_orders', 'production_stage'],
    ['idx_qi_job_order_id', 'quality_inspections', 'job_order_id'],
    ['idx_idl_job_order_id', 'item_delivery_lines', 'job_order_id'],
  ]) {
    const [existing] = await pool.query(`SHOW INDEX FROM ${table} WHERE Column_name = ? AND Seq_in_index = 1`, [column]);
    if (existing.length) { console.log(`${table}.${column} already indexed (${existing[0].Key_name}).`); continue; }
    if (DRY_RUN) { console.log(`Would create ${name}.`); continue; }
    await pool.query(`CREATE INDEX ${name} ON ${table} (${column})`);
    console.log(`Created ${name} on ${table} (${column}).`);
  }
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
