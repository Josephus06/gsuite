const express = require('express');
const crypto = require('crypto');
const pool = require('../db');

const router = express.Router();

// The driver's view of one delivery run, opened from a link with no login.
//
// UNAUTHENTICATED BY DESIGN, and the second such surface in this app after /api/public. Drivers
// are a hand-kept list rather than users -- casual and contracted drivers turn up on run sheets
// without ever having a payroll record -- so the run carries a token and that token IS the
// credential.
//
// The surface is deliberately tiny, and everything is scoped to the ONE run the token names:
//
//   GET  /api/driver/:token              that run and its stops, in order
//   POST /api/driver/:token/start        record the beginning odometer
//   POST /api/driver/:token/stops/:id/arrive   stamp arrival, record the odometer
//   POST /api/driver/:token/stops/:id/sign     the receiver's signature
//
// What it will NOT do: list runs, name other drivers, touch a stop belonging to a different
// itinerary, change what is being delivered, or reveal anything priced. A driver needs to know
// where to go, what they are handing over and who signs for it -- nothing about what it is worth.
const SIGNATURE_MAX_BYTES = 512 * 1024;
const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));

// A token is 64 hex characters. Checked for shape before it ever reaches the database, so a
// malformed or probing value costs a regex rather than a query.
const TOKEN_RE = /^[a-f0-9]{64}$/;

// Resolves the token to a run, or explains why it will not open. The three refusals are kept
// distinct because they mean different things to whoever is holding the phone: a wrong link, an
// old one, and a run that was called off.
async function runForToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return { error: 'This link is not valid.', status: 404 };
  const [[run]] = await pool.query(
    `SELECT i.id, i.itinerary_no, i.itinerary_date, i.status, i.plate_no, i.remarks,
            i.beginning_odometer, i.driver_token_expires_at, d.name AS driver_name
       FROM delivery_itineraries i
       LEFT JOIN delivery_drivers d ON d.id = i.driver_id
      WHERE i.driver_token = ?`, [token],
  );
  if (!run) return { error: 'This link is not valid.', status: 404 };
  if (run.status === 'cancelled') return { error: 'This run has been cancelled.', status: 409 };
  if (run.driver_token_expires_at && new Date(run.driver_token_expires_at) < new Date()) {
    return { error: 'This link has expired. Ask the office for a new one.', status: 410 };
  }
  return { run };
}

// Only the digits. A reading typed as "123,456 km" is the same number as "123456", and the driver
// should not have to care which the box wants.
function odometerNumber(v) {
  if (v === null || v === undefined) return null;
  const digits = String(v).replace(/[^0-9.]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

router.get('/:token', async (req, res, next) => {
  try {
    const { run, error, status } = await runForToken(req.params.token);
    if (error) return res.status(status).json({ error });

    const [stops] = await pool.query(
      `SELECT s.id, s.sequence_no, s.customer_name, s.delivery_address, s.person_in_charge,
              s.qty_to_deliver, s.fulfillment_type, s.odometer, s.time_of_arrival,
              s.signed_by_name, s.signed_at, s.status, s.remarks,
              (s.signature_data IS NOT NULL) AS has_signature,
              so.sales_order_no
         FROM delivery_itinerary_stops s
         LEFT JOIN sales_orders so ON so.id = s.sales_order_id
        WHERE s.itinerary_id = ?
        ORDER BY s.sequence_no, s.id`, [run.id],
    );

    // The previous reading each stop builds on: the one before it, falling back to the run's
    // beginning odometer. Sent so the phone can show "last reading 123,456" beside the box and
    // work out the leg once a number is typed -- the driver reads the dashboard, the app does
    // the arithmetic.
    let previous = odometerNumber(run.beginning_odometer);
    const withPrevious = stops.map((s) => {
      const own = odometerNumber(s.odometer);
      const row = { ...s, previous_odometer: previous, odometer_value: own };
      if (own !== null) previous = own;
      return row;
    });

    return res.json({
      itinerary_no: run.itinerary_no,
      itinerary_date: run.itinerary_date,
      status: run.status,
      driver_name: run.driver_name,
      plate_no: run.plate_no,
      remarks: run.remarks,
      beginning_odometer: run.beginning_odometer,
      stops: withPrevious,
    });
  } catch (err) { return next(err); }
});

router.post('/:token/start', async (req, res, next) => {
  try {
    const { run, error, status } = await runForToken(req.params.token);
    if (error) return res.status(status).json({ error });

    const reading = trunc(req.body.beginning_odometer, 30);
    if (reading === null) return res.status(400).json({ error: 'Enter the odometer reading.' });
    if (odometerNumber(reading) === null) {
      return res.status(400).json({ error: 'That does not look like an odometer reading.' });
    }

    await pool.query(
      `UPDATE delivery_itineraries
          SET beginning_odometer = ?, status = IF(status = 'draft' OR status = 'scheduled', 'dispatched', status),
              dispatched_at = COALESCE(dispatched_at, NOW()), updated_at = NOW()
        WHERE id = ?`,
      [reading, run.id],
    );
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Arriving. Stamps the time itself so nobody has to read a clock, and takes the odometer the
// driver read off the dashboard.
//
// The reading is NOT computed. A button press cannot know what the dashboard says, and this figure
// feeds mileage -- so the driver types it and the app checks it only for being a number that has
// not gone backwards.
router.post('/:token/stops/:stopId/arrive', async (req, res, next) => {
  try {
    const { run, error, status } = await runForToken(req.params.token);
    if (error) return res.status(status).json({ error });

    // Scoped to this run's stops. Without the itinerary_id the token for one run could stamp a
    // stop on another.
    const [[stop]] = await pool.query(
      'SELECT id, sequence_no FROM delivery_itinerary_stops WHERE id = ? AND itinerary_id = ?',
      [req.params.stopId, run.id],
    );
    if (!stop) return res.status(404).json({ error: 'That stop is not on this run.' });

    const reading = trunc(req.body.odometer, 30);
    const value = odometerNumber(reading);
    if (reading !== null && value === null) {
      return res.status(400).json({ error: 'That does not look like an odometer reading.' });
    }

    // An odometer only counts up. A reading below the last one is a typo, and catching it while
    // the driver is still standing there is worth more than a tidy number later.
    if (value !== null) {
      const [[prev]] = await pool.query(
        `SELECT COALESCE(
                  (SELECT s2.odometer FROM delivery_itinerary_stops s2
                    WHERE s2.itinerary_id = ? AND s2.odometer IS NOT NULL AND s2.sequence_no < ?
                    ORDER BY s2.sequence_no DESC LIMIT 1),
                  (SELECT beginning_odometer FROM delivery_itineraries WHERE id = ?)
                ) AS prev`,
        [run.id, stop.sequence_no, run.id],
      );
      const prevValue = odometerNumber(prev?.prev);
      if (prevValue !== null && value < prevValue) {
        return res.status(400).json({
          error: `That reading (${value.toLocaleString()}) is lower than the last one (${prevValue.toLocaleString()}). Check the dashboard.`,
        });
      }
    }

    await pool.query(
      `UPDATE delivery_itinerary_stops
          SET time_of_arrival = COALESCE(time_of_arrival, NOW()),
              odometer = COALESCE(?, odometer), updated_at = NOW()
        WHERE id = ?`,
      [reading, stop.id],
    );
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.post('/:token/stops/:stopId/sign', async (req, res, next) => {
  try {
    const { run, error, status } = await runForToken(req.params.token);
    if (error) return res.status(status).json({ error });

    const [[stop]] = await pool.query(
      'SELECT id FROM delivery_itinerary_stops WHERE id = ? AND itinerary_id = ?',
      [req.params.stopId, run.id],
    );
    if (!stop) return res.status(404).json({ error: 'That stop is not on this run.' });

    if (!req.body.signature_data) return res.status(400).json({ error: 'Nothing has been signed yet.' });
    const base64 = String(req.body.signature_data).replace(/^data:([^;]*);base64,/, '');
    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch { return res.status(400).json({ error: 'The signature could not be read.' }); }
    if (!buf.length) return res.status(400).json({ error: 'The signature is empty.' });
    if (buf.length > SIGNATURE_MAX_BYTES) return res.status(400).json({ error: 'That signature image is too large.' });
    const m = String(req.body.signature_data).match(/^data:([^;]+);base64,/);
    const mime = m ? m[1] : 'image/png';
    if (!/^image\//.test(mime)) return res.status(400).json({ error: 'A signature must be an image.' });

    // Signing for goods is the delivery happening, so the stop closes itself -- and the arrival
    // time is backfilled if the driver went straight to the signature without tapping Arrive.
    await pool.query(
      `UPDATE delivery_itinerary_stops
          SET signature_data = ?, signature_mime = ?, signed_at = NOW(), signed_by_name = ?,
              time_of_arrival = COALESCE(time_of_arrival, NOW()), status = 'delivered', updated_at = NOW()
        WHERE id = ?`,
      [buf, mime, trunc(req.body.signed_by_name, 150), stop.id],
    );
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// --- where the van is ---------------------------------------------------------------------
//
// Reported by the driver's phone while the run page is open. The browser refuses location on an
// insecure origin, so this only ever fires over HTTPS.

// Location data about a person, kept only as long as it is useful. A trail from three months ago
// answers no question anybody asks and is a liability to hold, so writes prune as they go rather
// than waiting for a job somebody has to remember to schedule.
const POSITION_RETENTION_DAYS = 30;
// A fix every 30 seconds is the plan; anything faster is a client misbehaving or retrying, and
// there is no reason to store two points a second apart.
const MIN_SECONDS_BETWEEN_FIXES = 10;

router.post('/:token/position', async (req, res, next) => {
  try {
    const { run, error, status } = await runForToken(req.params.token);
    if (error) return res.status(status).json({ error });

    const lat = Number(req.body.latitude);
    const lng = Number(req.body.longitude);
    // Range-checked rather than trusted. This endpoint takes no credential beyond the token, and
    // a nonsense pair would put the map somewhere in the Atlantic.
    if (!Number.isFinite(lat) || lat < -90 || lat > 90
        || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid position.' });
    }

    const [[last]] = await pool.query(
      'SELECT recorded_at FROM delivery_driver_positions WHERE itinerary_id = ? ORDER BY recorded_at DESC LIMIT 1',
      [run.id],
    );
    if (last && (Date.now() - new Date(last.recorded_at).getTime()) < MIN_SECONDS_BETWEEN_FIXES * 1000) {
      // Accepted, not stored. Telling the phone it failed would only make it retry.
      return res.json({ ok: true, skipped: 'too soon' });
    }

    const round = (v, d) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : null);
    await pool.query(
      `INSERT INTO delivery_driver_positions
         (itinerary_id, latitude, longitude, accuracy_m, speed_kph, heading_deg)
       VALUES (?,?,?,?,?,?)`,
      [run.id, lat, lng,
        Number.isFinite(Number(req.body.accuracy_m)) ? Math.round(Number(req.body.accuracy_m)) : null,
        round(req.body.speed_kph, 2),
        Number.isFinite(Number(req.body.heading_deg)) ? Math.round(Number(req.body.heading_deg)) : null],
    );

    await pool.query(
      'DELETE FROM delivery_driver_positions WHERE recorded_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [POSITION_RETENTION_DAYS],
    );
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Minted by the office, not here -- issuing a credential is not something an unauthenticated
// caller gets to do. Exported for routes/itineraries.js to use.
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = router;
module.exports.newToken = newToken;
module.exports.odometerNumber = odometerNumber;
