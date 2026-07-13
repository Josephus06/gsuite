const bcrypt = require('bcryptjs');
const pool = require('../db');
require('dotenv').config();

const PAGES = [
  { name: 'Dashboard', route: '/dashboard', icon: 'home', sort_order: 1 },
  { name: 'Employees', route: '/employees', icon: 'users', sort_order: 2 },
  { name: 'Users & Permissions', route: '/users', icon: 'shield', sort_order: 3 },
  { name: 'Customers', route: '/customers', icon: 'briefcase', sort_order: 4 },
  { name: 'Suppliers', route: '/suppliers', icon: 'truck', sort_order: 5 },
  { name: 'Inventory Items', route: '/inventory', icon: 'box', sort_order: 6 },
  { name: 'Estimates', route: '/estimates', icon: 'file-text', sort_order: 7 },
  { name: 'Sales Orders', route: '/sales-orders', icon: 'shopping-cart', sort_order: 8 },
  { name: 'Process Costing', route: '/process-costing', icon: 'calculator', sort_order: 9 },
  { name: 'Lookups', route: '/lookups', icon: 'settings', sort_order: 10 },
];

const LOOKUP_SEED = {
  departments: [
    { name: 'Production', description: 'Production floor' },
    { name: 'Sales', description: 'Sales & marketing' },
    { name: 'Accounting', description: 'Finance & accounting' },
  ],
  units_of_measure: [
    { code: 'PC', title: 'Piece' },
    { code: 'LOT', title: 'Lot' },
    { code: 'SQFT', title: 'Square Foot' },
    { code: 'KG', title: 'Kilogram' },
  ],
  locations: [
    { location_code: 'MAIN', location_name: 'Main Branch', location_type: 'Branch' },
    { location_code: 'WH01', location_name: 'Main Warehouse', location_type: 'Warehouse' },
  ],
  business_styles: [{ name: 'Sole Proprietorship' }, { name: 'Corporation' }],
  payment_terms: [
    { term_name: 'Cash on Delivery', no_of_days: 0 },
    { term_name: 'Net 30', no_of_days: 30 },
  ],
  sales_divisions: [{ name: 'Support' }, { name: 'Direct Sales' }],
  inventory_categories: [{ name: 'Raw Materials' }, { name: 'Finished Goods' }],
};

function columnList(table) {
  return Object.keys(LOOKUP_SEED[table][0]);
}

async function seedLookups() {
  for (const table of Object.keys(LOOKUP_SEED)) {
    const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    if (count > 0) continue;
    const cols = columnList(table);
    for (const row of LOOKUP_SEED[table]) {
      const values = cols.map((c) => row[c]);
      await pool.query(
        `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        values
      );
    }
    console.log(`Seeded ${LOOKUP_SEED[table].length} rows into ${table}`);
  }
}

async function seedPages() {
  const ids = {};
  for (const page of PAGES) {
    const [existing] = await pool.query('SELECT id FROM pages WHERE route = ?', [page.route]);
    if (existing.length) {
      ids[page.route] = existing[0].id;
      continue;
    }
    const [result] = await pool.query(
      'INSERT INTO pages (name, route, icon, sort_order) VALUES (?, ?, ?, ?)',
      [page.name, page.route, page.icon, page.sort_order]
    );
    ids[page.route] = result.insertId;
  }
  return ids;
}

async function seedAdmin(pageIds) {
  const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', ['admin']);
  let userId;
  if (existing.length) {
    userId = existing[0].id;
    console.log('Admin user already exists, skipping creation.');
  } else {
    const [empResult] = await pool.query(
      `INSERT INTO employees (employee_code, first_name, last_name, position_title, email)
       VALUES (?, ?, ?, ?, ?)`,
      ['EMP-0001', 'System', 'Administrator', 'Administrator', 'admin@gsuite.local']
    );
    const passwordHash = await bcrypt.hash('Admin123!', 10);
    const [userResult] = await pool.query(
      `INSERT INTO users (employee_id, username, email, password_hash, display_name)
       VALUES (?, ?, ?, ?, ?)`,
      [empResult.insertId, 'admin', 'admin@gsuite.local', passwordHash, 'System Administrator']
    );
    userId = userResult.insertId;
    console.log('Created admin user -> username: admin / password: Admin123!');
  }

  for (const pageId of Object.values(pageIds)) {
    const [existingPerm] = await pool.query(
      'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
      [userId, pageId]
    );
    if (existingPerm.length) continue;
    await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
       VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)`,
      [userId, pageId]
    );
  }
  console.log('Granted admin full permissions on all seeded pages.');
}

async function main() {
  await seedLookups();
  const pageIds = await seedPages();
  await seedAdmin(pageIds);
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
