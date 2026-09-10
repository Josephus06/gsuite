// Production > Itinerary: planning WHICH pending Sales Orders go out, in WHAT ORDER, on WHOSE
// truck.
//
// Item Delivery records what has already shipped. This is the step before it -- the run sheet the
// driver leaves with. So a stop here is a plan (an SO, an address, a quantity, a place in the
// queue) and becomes fact when the driver records an arrival time and gets a signature.
//
// Three tables:
//   delivery_drivers            the people who drive, maintained by hand
//   delivery_itineraries        one run: a date, a driver, a status
//   delivery_itinerary_stops    the SOs on that run, in sequence
//
// The stop keeps its OWN copy of customer, address and quantity rather than reading them back
// through the Sales Order every time. A run sheet is a record of what was planned and signed for
// on the day; if the SO's shipping address is corrected next month, last month's signed itinerary
// must still show the address the driver was actually sent to. Same reasoning as the artist
// archive snapshots.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/create-delivery-itinerary.js
const pool = require('../db');

const ROUTE = '/itineraries';

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

async function createTable(name, ddl) {
  if (await tableExists(name)) {
    console.log(`  Table ${name} already exists.`);
    return;
  }
  await pool.query(ddl);
  console.log(`  Created table ${name}.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  await createTable('delivery_drivers', `
    CREATE TABLE delivery_drivers (
      id BIGINT NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      licence_no VARCHAR(60) NULL,
      contact_no VARCHAR(60) NULL,
      plate_no VARCHAR(30) NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      remarks VARCHAR(300) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_delivery_drivers_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await createTable('delivery_itineraries', `
    CREATE TABLE delivery_itineraries (
      id BIGINT NOT NULL AUTO_INCREMENT,
      itinerary_no VARCHAR(30) NOT NULL DEFAULT '',
      itinerary_date DATE NOT NULL,
      driver_id BIGINT NULL,
      plate_no VARCHAR(30) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      remarks VARCHAR(500) NULL,
      created_by_user_id BIGINT NULL,
      dispatched_at DATETIME NULL,
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY idx_itineraries_date (itinerary_date),
      KEY idx_itineraries_driver (driver_id),
      KEY idx_itineraries_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // signature_data is a MEDIUMBLOB, not the LONGBLOB the archive uses. A signature is a few KB of
  // PNG drawn on a phone; capping it at 16MB is already far more headroom than a scribble needs,
  // and keeps a run sheet from becoming something that has to be paged.
  await createTable('delivery_itinerary_stops', `
    CREATE TABLE delivery_itinerary_stops (
      id BIGINT NOT NULL AUTO_INCREMENT,
      itinerary_id BIGINT NOT NULL,
      sequence_no INT NOT NULL DEFAULT 1,
      sales_order_id BIGINT NOT NULL,
      delivery_date DATE NULL,
      customer_name VARCHAR(255) NULL,
      qty_to_deliver DECIMAL(18,4) NULL,
      fulfillment_type VARCHAR(10) NOT NULL DEFAULT 'full',
      delivery_address VARCHAR(500) NULL,
      person_in_charge VARCHAR(150) NULL,
      time_of_arrival DATETIME NULL,
      signature_data MEDIUMBLOB NULL,
      signature_mime VARCHAR(60) NULL,
      signed_by_name VARCHAR(150) NULL,
      signed_at DATETIME NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      remarks VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY idx_stops_itinerary (itinerary_id, sequence_no),
      KEY idx_stops_so (sales_order_id),
      UNIQUE KEY uq_stops_itinerary_so (itinerary_id, sales_order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // The same Sales Order twice on one run sheet is a mistake rather than two drops, so the unique
  // key above refuses it. Scheduling it on a DIFFERENT day is fine, which is what a partial
  // delivery across two runs actually looks like.

  console.log('');
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = page?.id;
  if (pageId) {
    console.log(`Page ${ROUTE}: already registered (id ${pageId}).`);
  } else {
    const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [ROUTE, 'Itinerary']);
    pageId = r.insertId;
    console.log(`Page ${ROUTE}: registered (id ${pageId}).`);
  }

  // Its own page row, not Production's. Item Delivery spent its whole life borrowing Sales Orders'
  // scope and it meant nobody could find it in the permission grid -- no repeat of that here.
  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');
  const cols = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print']
    .concat(hasViewAll ? ['can_view_all'] : []);

  await pool.query(
    `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
     SELECT u.id, ?, ${cols.map(() => 'TRUE').join(', ')} FROM users u
      WHERE u.account_type = 'System Admin'
        AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e
                         WHERE e.user_id = u.id)`,
    [pageId, pageId],
  );
  await pool.query(
    `UPDATE user_page_permissions upp JOIN users u ON u.id = upp.user_id
        SET ${cols.map((c) => `upp.${c} = TRUE`).join(', ')}
      WHERE u.account_type = 'System Admin' AND upp.page_id = ?`, [pageId],
  );
  const [[atp]] = await pool.query(
    "SELECT COUNT(*) AS n FROM account_type_permissions WHERE account_type = 'System Admin' AND page_id = ?",
    [pageId],
  );
  if (!atp.n) {
    await pool.query(
      `INSERT INTO account_type_permissions (account_type, page_id, ${cols.join(', ')})
       VALUES ('System Admin', ?, ${cols.map(() => 'TRUE').join(', ')})`, [pageId],
    );
  }
  console.log('  System Admin granted in full.');

  const [[ready]] = await pool.query(
    `SELECT COUNT(DISTINCT so.id) AS n
       FROM sales_orders so
       JOIN sales_order_lines sol ON sol.sales_order_id = so.id
       JOIN job_orders jo ON jo.id = sol.job_order_id
      WHERE LEAST(jo.quantity_built, jo.quantity_inspected) - jo.quantity_delivered > 0
        AND so.status <> 'cancelled'`,
  );
  const [[drivers]] = await pool.query('SELECT COUNT(*) AS n FROM delivery_drivers');
  console.log(`\n${ready.n} Sales Orders currently have quantity ready to deliver.`);
  console.log(`${drivers.n} drivers defined -- add them from the Itinerary screen before scheduling a run.`);
  console.log(`Grant ${ROUTE} to whoever plans the deliveries.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
