// Records HOW each Item Delivery went out -- Lalamove, in-house, or whatever comes next -- and
// what it cost, so the month-end question "how many did we send by Lalamove and what did we pay
// for it, versus how many we drove ourselves" can be answered from the data instead of from
// someone's recollection.
//
// A lookup table rather than an ENUM or a pair of hard-coded strings. Third-party couriers are
// exactly the kind of list that grows -- Grab, Transportify, a provincial forwarder -- and each
// new one should be a row somebody adds, not a migration and a deploy.
//
// The method is deliberately NULLABLE. There are ~75k deliveries already recorded and nobody
// knows how those went out; writing a guess into them would be inventing history, and the report
// counts them under "Not specified" rather than quietly folding them into In-house.
//
// IDEMPOTENT: safe to re-run. Every step checks first.
//
//   node src/db/add-delivery-method.js
const pool = require('../db');

const METHODS = [
  // In-house first: it is the default way things go out, so it should be the first thing in the
  // dropdown. is_third_party is what the report groups on -- an outside courier bills us and the
  // cost is a real payable, our own van does not.
  { code: 'IN_HOUSE', name: 'In-house', is_third_party: 0, sort_order: 1 },
  { code: 'LALAMOVE', name: 'Lalamove', is_third_party: 1, sort_order: 2 },
];

async function tableExists(name) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [name],
  );
  return r.n > 0;
}

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function indexExists(table, name) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, name],
  );
  return r.n > 0;
}

async function addColumn(table, column, ddl) {
  if (await columnExists(table, column)) {
    console.log(`  ${table}.${column} already exists -- skipped.`);
    return;
  }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`  ${table}.${column} added.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await tableExists('delivery_methods')) {
    console.log('Table delivery_methods already exists.');
  } else {
    await pool.query(`
      CREATE TABLE delivery_methods (
        id BIGINT NOT NULL AUTO_INCREMENT,
        code VARCHAR(30) NOT NULL,
        name VARCHAR(60) NOT NULL,
        is_third_party BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_delivery_methods_code (code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('Created table delivery_methods.');
  }

  console.log('');
  for (const m of METHODS) {
    const [[existing]] = await pool.query('SELECT id FROM delivery_methods WHERE code = ?', [m.code]);
    if (existing) {
      console.log(`  ${m.name} already seeded (id ${existing.id}).`);
      continue;
    }
    const [r] = await pool.query(
      'INSERT INTO delivery_methods (code, name, is_third_party, sort_order) VALUES (?,?,?,?)',
      [m.code, m.name, m.is_third_party, m.sort_order],
    );
    console.log(`  + ${m.name} (id ${r.insertId})`);
  }

  console.log('');
  await addColumn('item_deliveries', 'delivery_method_id',
    'delivery_method_id BIGINT NULL AFTER sales_order_id');
  // Money, so DECIMAL -- never a float. Nullable and separate from the method because the fare
  // is frequently not known when the delivery is raised: the Lalamove figure lands with the
  // booking, or on the monthly statement, so accounting fills it in afterwards.
  await addColumn('item_deliveries', 'delivery_cost',
    'delivery_cost DECIMAL(12,2) NULL AFTER delivery_method_id');
  // The courier's booking reference, or the plate number for our own van. This is what makes a
  // month-end total reconcilable against the courier's own invoice line by line.
  await addColumn('item_deliveries', 'delivery_reference',
    'delivery_reference VARCHAR(80) NULL AFTER delivery_cost');

  // The report groups by method across a month, so lead on the date.
  if (await indexExists('item_deliveries', 'idx_item_deliveries_date_method')) {
    console.log('  index idx_item_deliveries_date_method already exists -- skipped.');
  } else {
    await pool.query(
      'ALTER TABLE item_deliveries ADD INDEX idx_item_deliveries_date_method (date_created, delivery_method_id)');
    console.log('  index idx_item_deliveries_date_method added.');
  }

  // Its own page row rather than riding on /sales-orders like the Item Delivery screen does.
  // What a delivery cost is accounting's business, and this way it can be granted to the people
  // who reconcile the courier bill without opening it to everyone who raises a delivery.
  const ROUTE = '/reports/delivery-summary';
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = page?.id;
  if (pageId) {
    console.log(`\nPage ${ROUTE}: already registered (id ${pageId}).`);
  } else {
    const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [ROUTE, 'Delivery Summary']);
    pageId = r.insertId;
    console.log(`\nPage ${ROUTE}: registered (id ${pageId}).`);
  }

  for (const [table, col] of [['user_page_permissions', 'user_id'], ['account_type_permissions', 'account_type']]) {
    const hasViewAll = await columnExists(table, 'can_view_all');
    const cols = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print']
      .concat(hasViewAll ? ['can_view_all'] : []);
    const sets = cols.map((c) => `${c} = TRUE`).join(', ');
    if (table === 'user_page_permissions') {
      const [[row]] = await pool.query(
        `SELECT COUNT(*) AS n FROM ${table} upp JOIN users u ON u.id = upp.${col}
          WHERE u.account_type = 'System Admin' AND upp.page_id = ?`, [pageId],
      );
      if (!row.n) {
        await pool.query(
          `INSERT INTO ${table} (user_id, page_id, ${cols.join(', ')})
           SELECT u.id, ?, ${cols.map(() => 'TRUE').join(', ')} FROM users u
            WHERE u.account_type = 'System Admin'`, [pageId],
        );
        console.log('  System Admin granted on user_page_permissions.');
      } else {
        await pool.query(
          `UPDATE ${table} upp JOIN users u ON u.id = upp.user_id SET ${sets}
            WHERE u.account_type = 'System Admin' AND upp.page_id = ?`, [pageId],
        );
        console.log('  System Admin already granted on user_page_permissions -- refreshed.');
      }
    } else {
      const [[row]] = await pool.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE account_type = 'System Admin' AND page_id = ?`, [pageId],
      );
      if (!row.n) {
        await pool.query(
          `INSERT INTO ${table} (account_type, page_id, ${cols.join(', ')})
           VALUES ('System Admin', ?, ${cols.map(() => 'TRUE').join(', ')})`, [pageId],
        );
        console.log('  System Admin granted on account_type_permissions.');
      } else {
        console.log('  System Admin already granted on account_type_permissions.');
      }
    }
  }

  const [[unset]] = await pool.query(
    'SELECT COUNT(*) AS n FROM item_deliveries WHERE delivery_method_id IS NULL');
  console.log(`\n${unset.n} existing deliveries have no method recorded -- they report as "Not specified".`);
  console.log('Grant /reports/delivery-summary to whoever reconciles the courier bill.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
