// Where the driver is while a run is out.
//
// A trail rather than a single last-known point: knowing the van sat outside a customer for forty
// minutes is worth more than knowing where it is right now, and the map draws the route from it.
//
// THIS IS LOCATION DATA ABOUT A PERSON, so the table is built to forget:
//
//   * positions are only ever written against an open run, from that run's own token
//   * rows older than RETENTION_DAYS are pruned on write, so the table cannot grow without bound
//     and a trail from three months ago is simply gone
//   * nothing here is tied to a user account -- a row says "this run's phone was here", not
//     "this person was here", and the link dies a week after the run
//
// Accuracy is stored alongside the fix because a position with a 2km radius is not a sighting and
// the map has to be able to say so. A phone indoors reports wild accuracy figures.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/create-driver-positions.js
const pool = require('../db');

async function tableExists(name) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [name],
  );
  return r.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  if (await tableExists('delivery_driver_positions')) {
    console.log('  Table delivery_driver_positions already exists.');
  } else {
    // DECIMAL, not FLOAT. (10,7) holds a latitude to about a centimetre, and a float's rounding
    // would wander the marker around on its own.
    await pool.query(`
      CREATE TABLE delivery_driver_positions (
        id BIGINT NOT NULL AUTO_INCREMENT,
        itinerary_id BIGINT NOT NULL,
        latitude DECIMAL(10,7) NOT NULL,
        longitude DECIMAL(10,7) NOT NULL,
        accuracy_m INT NULL,
        speed_kph DECIMAL(6,2) NULL,
        heading_deg INT NULL,
        recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_driver_positions_run (itinerary_id, recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('  Created table delivery_driver_positions.');
  }

  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM delivery_driver_positions');
  console.log(`\n${n.n} position(s) recorded.`);
  console.log('Drivers only report while the run page is open on their phone, and only over HTTPS --');
  console.log('browsers refuse location on an insecure origin, so this works on Railway and will not');
  console.log('work on the plain-HTTP droplet or office box until they have a certificate.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
