// Caches the road route for a run, so the map draws real streets without asking the routing
// service every time somebody opens the page.
//
// A route only changes when the points change: reorder the stops, move a pin, or set a different
// starting point. Everything else -- opening the run, refreshing the driver's position every 30
// seconds, printing -- can reuse what was worked out before. route_key is a fingerprint of the
// ordered coordinates; when it still matches, the stored geometry stands.
//
// That is what keeps this inside a free routing plan. Without it, a dispatcher leaving the page
// open would spend a request every refresh for a line that had not moved.
//
//   route_key         fingerprint of the ordered points the geometry was built from
//   route_geometry    the road shape, GeoJSON coordinate pairs
//   route_legs        distance and duration per leg, so the planner sees office->1, 1->2, ...
//   route_distance_m  / route_duration_s   totals for the whole run
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-itinerary-route-cache.js
const pool = require('../db');

const COLUMNS = [
  ['route_key', 'VARCHAR(64) NULL AFTER origin_longitude'],
  // LONGTEXT: a multi-stop city route is a few thousand coordinate pairs, which comfortably
  // exceeds TEXT's 64KB once it is JSON.
  ['route_geometry', 'LONGTEXT NULL AFTER route_key'],
  ['route_legs', 'TEXT NULL AFTER route_geometry'],
  ['route_distance_m', 'INT NULL AFTER route_legs'],
  ['route_duration_s', 'INT NULL AFTER route_distance_m'],
  ['route_cached_at', 'DATETIME NULL AFTER route_duration_s'],
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

  for (const [column, ddl] of COLUMNS) {
    if (await columnExists('delivery_itineraries', column)) {
      console.log(`  delivery_itineraries.${column} already exists -- skipped.`);
    } else {
      await pool.query(`ALTER TABLE delivery_itineraries ADD COLUMN ${column} ${ddl}`);
      console.log(`  delivery_itineraries.${column} added.`);
    }
  }

  const key = process.env.GRAPHHOPPER_API_KEY;
  console.log(`\nGRAPHHOPPER_API_KEY is ${key ? 'set' : 'NOT SET on this install'}.`);
  if (!key) {
    console.log('Without it the map falls back to straight lines between stops, which still shows');
    console.log('the sequence -- it just does not follow roads.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
