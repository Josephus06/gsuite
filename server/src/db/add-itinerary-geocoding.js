// Puts the run on the map: a starting point for the itinerary, and a pinned position per stop.
//
// The address text stays exactly as it is -- typed by a person, printed on the run sheet, and the
// thing a driver actually reads. The coordinates are a SEPARATE pair of columns beside it, not a
// replacement, because geocoding Philippine addresses succeeds often but never always, and an
// address that could not be found must still print and still be deliverable.
//
// That is why the pin is nullable and why nothing here tries to backfill: a stop with no
// coordinates simply does not appear on the map, which is honest. Guessing a position from a
// half-matched address would put a van on a street it was never sent to.
//
//   stops         latitude / longitude       where this drop is
//   itineraries   origin_*                   where the run starts, usually the office
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-itinerary-geocoding.js
const pool = require('../db');

const COLUMNS = [
  // DECIMAL(10,7), matching delivery_driver_positions -- about a centimetre, and no float drift
  // nudging a pin around between reads.
  ['delivery_itinerary_stops', 'latitude', 'DECIMAL(10,7) NULL AFTER delivery_address'],
  ['delivery_itinerary_stops', 'longitude', 'DECIMAL(10,7) NULL AFTER latitude'],
  ['delivery_itineraries', 'origin_name', 'VARCHAR(200) NULL AFTER plate_no'],
  ['delivery_itineraries', 'origin_address', 'VARCHAR(500) NULL AFTER origin_name'],
  ['delivery_itineraries', 'origin_latitude', 'DECIMAL(10,7) NULL AFTER origin_address'],
  ['delivery_itineraries', 'origin_longitude', 'DECIMAL(10,7) NULL AFTER origin_latitude'],
];

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  for (const [table, column, ddl] of COLUMNS) {
    if (await columnExists(table, column)) {
      console.log(`  ${table}.${column} already exists -- skipped.`);
    } else {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      console.log(`  ${table}.${column} added.`);
    }
  }

  const [[s]] = await pool.query(
    'SELECT COUNT(*) AS total, SUM(latitude IS NOT NULL) AS pinned FROM delivery_itinerary_stops');
  console.log(`\n${Number(s.pinned) || 0} of ${s.total} stops are pinned.`);
  console.log('Nothing is backfilled: an address is geocoded when somebody picks a suggestion or');
  console.log('drops a pin, never by guessing from text that was already there.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
