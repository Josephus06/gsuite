// Adds an Odometer column to an itinerary stop, sitting beside Person in Charge.
//
// Like Time of Arrival and the signature, this is filled in BY HAND on the printed run sheet --
// the driver writes the reading at each drop. The column exists so the figure can be keyed back
// in afterwards if anyone wants it in the system, and so the print has a header to rule a box
// under.
//
// VARCHAR rather than a number on purpose. What gets written on a run sheet is "123456",
// "123,456 km" or "123456.5", and a numeric column would reject two of those outright when
// somebody types what is on the paper. Nothing computes with it today; if mileage reporting is
// ever wanted, that is the point to tighten the type and clean the existing values, not before.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-itinerary-odometer.js
const pool = require('../db');

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await columnExists('delivery_itinerary_stops', 'odometer')) {
    console.log('  delivery_itinerary_stops.odometer already exists -- skipped.');
  } else {
    await pool.query(
      'ALTER TABLE delivery_itinerary_stops ADD COLUMN odometer VARCHAR(30) NULL AFTER person_in_charge');
    console.log('  delivery_itinerary_stops.odometer added.');
  }

  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM delivery_itinerary_stops');
  console.log(`\n${n.n} stop(s) on record. Odometer prints as a blank box for the driver to fill in.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
