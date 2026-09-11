// Gives each itinerary a link the driver can open without an account, and the run a beginning
// odometer for the stop readings to build on.
//
// Drivers are a hand-kept list, not users -- casual and contracted drivers turn up on run sheets
// without ever having a payroll record, let alone a password. So the run itself carries an
// unguessable token, and that token IS the credential: whoever holds the link sees that one run
// and can record arrivals against it. Nothing else.
//
// THE TRADE-OFF, stated plainly: anyone with the link sees that run's customer names, addresses
// and contact people. That is the price of not making drivers manage passwords. It is bounded
// three ways -- one run per token, 64 hex characters so it cannot be guessed, and an expiry a week
// after the run date so an old link in a chat thread stops working.
//
//   driver_token           the credential, NULL until the run is shared
//   driver_token_expires_at  when it stops working
//   beginning_odometer     the reading the van left with, which every stop's reading builds on
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-itinerary-driver-link.js
const pool = require('../db');

const COLUMNS = [
  ['driver_token', 'VARCHAR(64) NULL AFTER plate_no'],
  ['driver_token_expires_at', 'DATETIME NULL AFTER driver_token'],
  // VARCHAR, matching the stop's own odometer column. What gets written on a run sheet is
  // "123456", "123,456 km" or "123456.5", and a numeric column would reject two of those when
  // somebody types what is on the dashboard. Distance per leg is parsed from the digits.
  ['beginning_odometer', 'VARCHAR(30) NULL AFTER driver_token_expires_at'],
];

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

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  for (const [column, ddl] of COLUMNS) {
    if (await columnExists('delivery_itineraries', column)) {
      console.log(`  delivery_itineraries.${column} already exists -- skipped.`);
    } else {
      await pool.query(`ALTER TABLE delivery_itineraries ADD COLUMN ${column} ${ddl}`);
      console.log(`  delivery_itineraries.${column} added.`);
    }
  }

  // UNIQUE, because the token is the credential. A duplicate would mean one link opening two runs,
  // and the index is what the lookup rides on -- every driver page load is a search by token.
  if (await indexExists('delivery_itineraries', 'uq_itineraries_driver_token')) {
    console.log('  index uq_itineraries_driver_token already exists -- skipped.');
  } else {
    await pool.query(
      'ALTER TABLE delivery_itineraries ADD UNIQUE KEY uq_itineraries_driver_token (driver_token)');
    console.log('  index uq_itineraries_driver_token added.');
  }

  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM delivery_itineraries');
  console.log(`\n${n.n} itinerar(ies) on record. None has a driver link until someone shares one.`);
  console.log('A link is generated from the run screen and stops working a week after the run date.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
