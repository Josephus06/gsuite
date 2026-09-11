const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
// Minted here, spent there: the token generator lives with the driver routes it authorises.
const { newToken } = require('./driverRuns');

const router = express.Router();

// Production > Itinerary -- the run sheet. Which pending Sales Orders go out, in what order, on
// whose truck.
//
// Its own permission scope rather than Production's. Planning a delivery run is a different job
// from working the shop floor, and a module that borrows another page's scope cannot be found in
// the permission grid at all -- Item Delivery spent its whole life that way.
const ROUTE = '/itineraries';

const STATUSES = ['draft', 'scheduled', 'dispatched', 'completed', 'cancelled'];
const STOP_STATUSES = ['pending', 'delivered', 'failed'];
const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));

// A Sales Order is schedulable when some quantity is BOTH built and QI-passed and has not shipped
// -- the same test the Item Delivery form uses. Deliberately not the SO's status: 79 orders read
// 'billed' while still holding undelivered stock, and a run sheet that hid those would leave goods
// sitting in the warehouse because a document elsewhere said the order was finished.
const READY_QTY_SQL = `
  (SELECT COALESCE(SUM(LEAST(jo.quantity_built, jo.quantity_inspected) - jo.quantity_delivered), 0)
     FROM sales_order_lines sol
     JOIN job_orders jo ON jo.id = sol.job_order_id
    WHERE sol.sales_order_id = so.id
      AND LEAST(jo.quantity_built, jo.quantity_inspected) - jo.quantity_delivered > 0)`;

// Latitude and longitude move together or not at all -- a stop holding one of them would sit at
// the equator or on the Greenwich meridian, which is worse than not being on the map.
function readPoint(body, latKey, lngKey) {
  const has = body[latKey] !== undefined || body[lngKey] !== undefined;
  if (!has) return { skip: true };
  const lat = body[latKey] === null || body[latKey] === '' ? null : Number(body[latKey]);
  const lng = body[lngKey] === null || body[lngKey] === '' ? null : Number(body[lngKey]);
  if (lat === null || lng === null) return { lat: null, lng: null };
  if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: 'That position is not on the map.' };
  }
  return { lat, lng };
}

async function nextItineraryNo(conn, id) {
  await conn.query('UPDATE delivery_itineraries SET itinerary_no = ? WHERE id = ?', [`ITN-${id}`, id]);
  return `ITN-${id}`;
}

// --- drivers ------------------------------------------------------------------------------
//
// Maintained by hand, like the asset locations. A driver is not an employee record here: casual
// and contracted drivers turn up on run sheets without ever having a payroll row.

router.get('/drivers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === '1';
    const [rows] = await pool.query(
      `SELECT id, name, licence_no, contact_no, plate_no, is_active, remarks
         FROM delivery_drivers ${includeInactive ? '' : 'WHERE is_active = TRUE'}
        ORDER BY is_active DESC, name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/drivers', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const name = trunc(req.body.name, 150);
    if (!name) return res.status(400).json({ error: 'A driver name is required.' });
    const [[dupe]] = await pool.query('SELECT id FROM delivery_drivers WHERE name = ?', [name]);
    if (dupe) return res.status(400).json({ error: `"${name}" is already on the driver list.` });
    const [r] = await pool.query(
      'INSERT INTO delivery_drivers (name, licence_no, contact_no, plate_no, remarks) VALUES (?,?,?,?,?)',
      [name, trunc(req.body.licence_no, 60), trunc(req.body.contact_no, 60),
        trunc(req.body.plate_no, 30), trunc(req.body.remarks, 300)],
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.put('/drivers/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const name = trunc(req.body.name, 150);
    if (!name) return res.status(400).json({ error: 'A driver name is required.' });
    const [[dupe]] = await pool.query(
      'SELECT id FROM delivery_drivers WHERE name = ? AND id <> ?', [name, req.params.id]);
    if (dupe) return res.status(400).json({ error: `"${name}" is already on the driver list.` });
    const [r] = await pool.query(
      `UPDATE delivery_drivers SET name = ?, licence_no = ?, contact_no = ?, plate_no = ?,
              remarks = ?, is_active = ? WHERE id = ?`,
      [name, trunc(req.body.licence_no, 60), trunc(req.body.contact_no, 60), trunc(req.body.plate_no, 30),
        trunc(req.body.remarks, 300), req.body.is_active === false ? 0 : 1, req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Retired rather than deleted once a driver has run something -- deleting would strip the name off
// signed historical run sheets.
router.delete('/drivers/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query(
      'SELECT COUNT(*) AS n FROM delivery_itineraries WHERE driver_id = ?', [req.params.id]);
    if (used.n) {
      await pool.query('UPDATE delivery_drivers SET is_active = FALSE WHERE id = ?', [req.params.id]);
      return res.json({ ok: true, retired: true, itineraries: used.n });
    }
    const [r] = await pool.query('DELETE FROM delivery_drivers WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, retired: false });
  } catch (err) { return next(err); }
});

// --- the Sales Orders available to schedule -----------------------------------------------

// The statuses that actually owe a shipment.
//
// 'pending_delivery' is ready stock with nothing delivered yet. 'partially_delivered' is the same
// obligation half-met -- computeSalesOrderStatus reserves it for "there's ready stock sitting
// undelivered on some line, an action is owed (ship it)", which is precisely what the Partial/Full
// column on a stop exists for. Excluding it would strand every part-shipped order.
//
// Deliberately NOT here: 'pending_billing_partially_delivered', which means deliveries have caught
// up with everything ready and the rest simply is not produced yet, and 'billed'/'pending_billing',
// which are finished as far as the warehouse is concerned.
const PENDING_DELIVERY_STATUSES = ['pending_delivery', 'partially_delivered'];

router.get('/schedulable', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = ["so.status <> 'cancelled'", `${READY_QTY_SQL} > 0`];
    const params = [];

    // Restricted to orders whose status says a delivery is owed. `all=1` lifts it, because a
    // handful of orders read 'billed' while still holding undelivered stock -- an inconsistency
    // worth being able to see rather than one the run sheet hides forever.
    if (req.query.all !== '1') {
      where.push(`so.status IN (${PENDING_DELIVERY_STATUSES.map(() => '?').join(', ')})`);
      params.push(...PENDING_DELIVERY_STATUSES);
    }
    if (req.query.search) {
      where.push('(so.sales_order_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }
    // Already on a run sheet that has not been cancelled -- offered but flagged, rather than
    // hidden, so a planner moving a stop between days can see where it already is.
    const [rows] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.date_created, so.status, so.shipping_address,
              c.name AS customer_name, cc.contact_name,
              ${READY_QTY_SQL} AS qty_ready,
              (SELECT GROUP_CONCAT(DISTINCT i.itinerary_no)
                 FROM delivery_itinerary_stops s
                 JOIN delivery_itineraries i ON i.id = s.itinerary_id
                WHERE s.sales_order_id = so.id AND i.status <> 'cancelled') AS scheduled_on
         FROM sales_orders so
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
        WHERE ${where.join(' AND ')}
        ORDER BY so.date_created, so.id
        LIMIT 300`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// --- itineraries --------------------------------------------------------------------------

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    // today / week / month is the forecast the planner actually asks for. Computed in SQL against
    // CURDATE() so it follows the database's day rather than the browser's timezone.
    const range = String(req.query.range || '').toLowerCase();
    if (range === 'today') where.push('i.itinerary_date = CURDATE()');
    else if (range === 'week') where.push('YEARWEEK(i.itinerary_date, 1) = YEARWEEK(CURDATE(), 1)');
    else if (range === 'month') where.push('i.itinerary_date BETWEEN DATE_FORMAT(CURDATE(), \'%Y-%m-01\') AND LAST_DAY(CURDATE())');
    else if (range === 'upcoming') where.push('i.itinerary_date >= CURDATE()');
    if (req.query.from) { where.push('i.itinerary_date >= ?'); params.push(req.query.from); }
    if (req.query.to) { where.push('i.itinerary_date <= ?'); params.push(req.query.to); }
    if (req.query.status) { where.push('i.status = ?'); params.push(req.query.status); }
    if (req.query.driver_id) { where.push('i.driver_id = ?'); params.push(req.query.driver_id); }
    if (req.query.search) {
      where.push('(i.itinerary_no LIKE ? OR d.name LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT i.id, i.itinerary_no, i.itinerary_date, i.status, i.plate_no, i.remarks,
              d.name AS driver_name, u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM delivery_itinerary_stops s WHERE s.itinerary_id = i.id) AS stop_count,
              (SELECT COUNT(*) FROM delivery_itinerary_stops s WHERE s.itinerary_id = i.id AND s.status = 'delivered') AS delivered_count
         FROM delivery_itineraries i
         LEFT JOIN delivery_drivers d ON d.id = i.driver_id
         LEFT JOIN users u ON u.id = i.created_by_user_id
         ${whereSql}
        ORDER BY i.itinerary_date DESC, i.id DESC
        LIMIT 500`,
      params,
    );

    // The forecast the planner reads at a glance: how many runs and drops sit in each window.
    const [[counts]] = await pool.query(
      `SELECT
         SUM(itinerary_date = CURDATE()) AS today,
         SUM(YEARWEEK(itinerary_date, 1) = YEARWEEK(CURDATE(), 1)) AS this_week,
         SUM(itinerary_date BETWEEN DATE_FORMAT(CURDATE(), '%Y-%m-01') AND LAST_DAY(CURDATE())) AS this_month
       FROM delivery_itineraries WHERE status <> 'cancelled'`,
    );
    res.json({ rows, counts });
  } catch (err) { next(err); }
});

// --- address suggestions --------------------------------------------------------------------
//
// Proxied rather than called from the browser, for three reasons: the upstream sees one User-Agent
// it can identify and rate-limit fairly instead of every workstation separately; swapping provider
// later is a change here rather than in the client; and the browser never talks to a third party,
// so a customer address is not handed to one by every keystroke on a page.
//
// Photon is komoot's free OpenStreetMap geocoder, built for type-ahead -- unlike Nominatim, whose
// usage policy asks people not to use it for autocomplete. No key, no billing. Measured against
// real Cebu addresses before adopting it: Ayala Center, SM City, Cebu Doctors Hospital and
// J.S. Alinsug Street in Mandaue all resolve correctly.
//
// It will NOT find everything. Philippine addressing is house-number-and-barangay in places OSM
// has never mapped, which is exactly why the client can drop a pin by hand instead.
const GEOCODE_URL = 'https://photon.komoot.io/api/';
// Biases results toward Cebu without excluding anywhere else -- a nearby match beats an alphabetical
// one when somebody types "San Jose".
const BIAS = { lat: 10.3157, lon: 123.8854 };

function describe(f) {
  const p = f.properties || {};
  const line = [p.name, p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street,
    p.district, p.city || p.county, p.state, p.country];
  // Deduplicated: OSM often repeats the locality as both district and city, and "Cebu City,
  // Cebu City" reads like a bug.
  const seen = new Set();
  return line.filter((x) => x && !seen.has(x) && seen.add(x)).join(', ');
}

router.get('/geocode', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json([]);

    const url = `${GEOCODE_URL}?q=${encodeURIComponent(q)}&limit=6&lat=${BIAS.lat}&lon=${BIAS.lon}`;
    // Bounded: a geocoder having a slow day must not hold a request open while somebody types.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let out = [];
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GSUITE-ERP/1.0 (delivery itinerary address lookup)' },
      });
      if (r.ok) {
        const body = await r.json();
        out = (body.features || [])
          .filter((f) => f.geometry?.coordinates?.length === 2)
          .map((f) => ({
            label: describe(f),
            latitude: Number(f.geometry.coordinates[1]),
            longitude: Number(f.geometry.coordinates[0]),
          }))
          .filter((f) => f.label);
      }
    } finally { clearTimeout(timer); }

    // An empty list, never a 500. The address field has to keep working when the geocoder is
    // unreachable -- typing it by hand and pinning it is the fallback, not an error state.
    return res.json(out);
  } catch (err) {
    if (err.name === 'AbortError') return res.json([]);
    return next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[it]] = await pool.query(
      `SELECT i.*, d.name AS driver_name, d.contact_no AS driver_contact, d.licence_no AS driver_licence,
              u.display_name AS created_by_name
         FROM delivery_itineraries i
         LEFT JOIN delivery_drivers d ON d.id = i.driver_id
         LEFT JOIN users u ON u.id = i.created_by_user_id
        WHERE i.id = ?`, [req.params.id],
    );
    if (!it) return res.status(404).json({ error: 'Not found' });

    // signature_data is deliberately not selected -- a run sheet with twenty signed stops would
    // otherwise ship megabytes of PNG on every page load. `has_signature` is all the list needs;
    // the image itself is fetched per stop.
    const [stops] = await pool.query(
      `SELECT s.id, s.sequence_no, s.sales_order_id, s.delivery_date, s.customer_name,
              s.qty_to_deliver, s.fulfillment_type, s.delivery_address, s.latitude, s.longitude,
              s.person_in_charge, s.odometer,
              s.time_of_arrival, s.signed_by_name, s.signed_at, s.status, s.remarks,
              (s.signature_data IS NOT NULL) AS has_signature,
              so.sales_order_no, so.status AS so_status
         FROM delivery_itinerary_stops s
         LEFT JOIN sales_orders so ON so.id = s.sales_order_id
        WHERE s.itinerary_id = ?
        ORDER BY s.sequence_no, s.id`, [req.params.id],
    );
    return res.json({ ...it, stops });
  } catch (err) { return next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const date = req.body.itinerary_date;
    if (!date) return res.status(400).json({ error: 'A date for the run is required.' });
    const driverId = req.body.driver_id ? Number(req.body.driver_id) : null;
    if (driverId) {
      const [[d]] = await conn.query('SELECT id, is_active FROM delivery_drivers WHERE id = ?', [driverId]);
      if (!d) return res.status(400).json({ error: 'Unknown driver.' });
      if (!d.is_active) return res.status(400).json({ error: 'That driver is no longer active.' });
    }

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO delivery_itineraries (itinerary_date, driver_id, plate_no, remarks, created_by_user_id)
       VALUES (?,?,?,?,?)`,
      [date, driverId, trunc(req.body.plate_no, 30), trunc(req.body.remarks, 500), req.user.id],
    );
    const no = await nextItineraryNo(conn, r.insertId);
    await conn.commit();
    return res.status(201).json({ id: r.insertId, itinerary_no: no });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[it]] = await pool.query('SELECT status FROM delivery_itineraries WHERE id = ?', [req.params.id]);
    if (!it) return res.status(404).json({ error: 'Not found' });

    const fields = [];
    const params = [];
    if (req.body.itinerary_date) { fields.push('itinerary_date = ?'); params.push(req.body.itinerary_date); }
    if (req.body.driver_id !== undefined) {
      const driverId = req.body.driver_id ? Number(req.body.driver_id) : null;
      if (driverId) {
        const [[d]] = await pool.query('SELECT id FROM delivery_drivers WHERE id = ?', [driverId]);
        if (!d) return res.status(400).json({ error: 'Unknown driver.' });
      }
      fields.push('driver_id = ?'); params.push(driverId);
    }
    if (req.body.plate_no !== undefined) { fields.push('plate_no = ?'); params.push(trunc(req.body.plate_no, 30)); }
    // Where the run starts. Free text plus an optional pin, the same shape as a stop: the office
    // is usually one fixed place, but a run that begins at a branch or a supplier is normal.
    if (req.body.origin_name !== undefined) { fields.push('origin_name = ?'); params.push(trunc(req.body.origin_name, 200)); }
    if (req.body.origin_address !== undefined) { fields.push('origin_address = ?'); params.push(trunc(req.body.origin_address, 500)); }
    const origin = readPoint(req.body, 'origin_latitude', 'origin_longitude');
    if (origin.error) return res.status(400).json({ error: origin.error });
    if (!origin.skip) {
      fields.push('origin_latitude = ?', 'origin_longitude = ?');
      params.push(origin.lat, origin.lng);
    }
    if (req.body.remarks !== undefined) { fields.push('remarks = ?'); params.push(trunc(req.body.remarks, 500)); }
    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status.' });
      fields.push('status = ?'); params.push(req.body.status);
      if (req.body.status === 'dispatched') fields.push('dispatched_at = NOW()');
      if (req.body.status === 'completed') fields.push('completed_at = NOW()');
    }
    if (!fields.length) return res.json({ ok: true });

    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    await pool.query(`UPDATE delivery_itineraries SET ${fields.join(', ')} WHERE id = ?`, params);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// The driver's trail for this run. What the map on the itinerary screen draws.
//
// Capped and thinned rather than returned whole: a full day at a fix every 30 seconds is ~2,800
// points, which is more line than any screen can show a difference across. The most recent fix is
// always returned exactly -- that is the one the planner is actually looking at.
router.get('/:id/positions', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[latest]] = await pool.query(
      `SELECT latitude, longitude, accuracy_m, speed_kph, heading_deg, recorded_at
         FROM delivery_driver_positions WHERE itinerary_id = ?
        ORDER BY recorded_at DESC LIMIT 1`, [req.params.id],
    );

    const [count] = await pool.query(
      'SELECT COUNT(*) AS n FROM delivery_driver_positions WHERE itinerary_id = ?', [req.params.id]);
    const total = Number(count[0].n);
    // Every nth row, so the shape of the route survives however long the run was.
    const step = Math.max(1, Math.ceil(total / 300));

    const [trail] = await pool.query(
      `SELECT latitude, longitude, accuracy_m, recorded_at FROM (
         SELECT p.*, ROW_NUMBER() OVER (ORDER BY p.recorded_at) AS rn
           FROM delivery_driver_positions p WHERE p.itinerary_id = ?
       ) x WHERE MOD(x.rn - 1, ?) = 0 ORDER BY recorded_at`,
      [req.params.id, step],
    );

    return res.json({ latest: latest || null, trail, total, sampled_every: step });
  } catch (err) { return next(err); }
});

// Minting the driver's link. An authenticated action on purpose: issuing a credential is the
// office's to do, never the holder's.
//
// Re-issuing replaces the old token, which is also how a link is revoked -- share it to the wrong
// group chat and you generate a new one, and the old link stops opening anything.
router.post('/:id/driver-link', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[run]] = await pool.query(
      'SELECT id, itinerary_date, status FROM delivery_itineraries WHERE id = ?', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (run.status === 'cancelled') return res.status(409).json({ error: 'This run is cancelled.' });

    // A week after the run date. Long enough for a late signature or a driver who forgot to close
    // one off; short enough that the link in last month's chat thread is already dead.
    const token = newToken();
    await pool.query(
      `UPDATE delivery_itineraries
          SET driver_token = ?, driver_token_expires_at = DATE_ADD(?, INTERVAL 7 DAY), updated_at = NOW()
        WHERE id = ?`,
      [token, run.itinerary_date, req.params.id],
    );
    return res.json({ token, path: `/driver/${token}` });
  } catch (err) { return next(err); }
});

router.delete('/:id/driver-link', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [r] = await pool.query(
      'UPDATE delivery_itineraries SET driver_token = NULL, driver_token_expires_at = NULL, updated_at = NOW() WHERE id = ?',
      [req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[signed]] = await conn.query(
      'SELECT COUNT(*) AS n FROM delivery_itinerary_stops WHERE itinerary_id = ? AND signature_data IS NOT NULL',
      [req.params.id],
    );
    // A signature is somebody's acknowledgement that they received goods. Cancel the run instead
    // of deleting the evidence.
    if (signed.n) {
      return res.status(409).json({
        error: `${signed.n} stop(s) on this run are signed for. Cancel the itinerary instead of deleting it.`,
      });
    }
    await conn.beginTransaction();
    await conn.query('DELETE FROM delivery_itinerary_stops WHERE itinerary_id = ?', [req.params.id]);
    const [r] = await conn.query('DELETE FROM delivery_itineraries WHERE id = ?', [req.params.id]);
    await conn.commit();
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

// --- stops --------------------------------------------------------------------------------
//
// Declared before the /:id/... routes below purely for readability; the two shapes cannot collide,
// since '/stops/7' needs a literal 'stops' first and '/7/stops' a literal 'stops' second.

// A signature is a scribble on a phone screen -- tens of KB of PNG at most. Capped at 512KB, which
// is generous for that and, crucially, sits well inside the app's global 2mb JSON body limit:
// base64 inflates by about a third, so a cap set AT the body limit would be rejected by the parser
// with a bare 413 before this handler ever saw it. That is exactly how the Archiver's upload broke.
const MAX_SIGNATURE_BYTES = 512 * 1024;

router.get('/stops/:stopId/signature', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[s]] = await pool.query(
      'SELECT signature_data, signature_mime FROM delivery_itinerary_stops WHERE id = ?', [req.params.stopId]);
    if (!s || !s.signature_data) return res.status(404).json({ error: 'No signature on this stop.' });
    res.setHeader('Content-Type', s.signature_mime || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(s.signature_data);
  } catch (err) { return next(err); }
});

// Arrival and signature land together, because that is how it happens: the driver arrives, the
// customer signs. Either can be sent on its own -- a stop can be marked arrived before anyone has
// found a pen.
router.post('/stops/:stopId/signature', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[s]] = await pool.query(
      `SELECT s.id, i.status AS itinerary_status FROM delivery_itinerary_stops s
         JOIN delivery_itineraries i ON i.id = s.itinerary_id WHERE s.id = ?`, [req.params.stopId]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.itinerary_status === 'cancelled') {
      return res.status(409).json({ error: 'This run is cancelled, so nothing can be signed against it.' });
    }

    const fields = [];
    const params = [];

    if (req.body.time_of_arrival !== undefined) {
      fields.push('time_of_arrival = ?');
      params.push(req.body.time_of_arrival || null);
    }

    if (req.body.signature_data) {
      const base64 = String(req.body.signature_data).replace(/^data:([^;]*);base64,/, '');
      let buf;
      try { buf = Buffer.from(base64, 'base64'); } catch { return res.status(400).json({ error: 'The signature could not be read.' }); }
      if (!buf.length) return res.status(400).json({ error: 'The signature is empty.' });
      if (buf.length > MAX_SIGNATURE_BYTES) {
        return res.status(400).json({ error: 'That signature image is too large.' });
      }
      const m = String(req.body.signature_data).match(/^data:([^;]+);base64,/);
      const mime = m ? m[1] : 'image/png';
      if (!/^image\//.test(mime)) return res.status(400).json({ error: 'A signature must be an image.' });
      fields.push('signature_data = ?', 'signature_mime = ?', 'signed_at = NOW()');
      params.push(buf, mime);
    }
    if (req.body.signed_by_name !== undefined) {
      fields.push('signed_by_name = ?');
      params.push(trunc(req.body.signed_by_name, 150));
    }
    // Signing for goods is the delivery happening, so the stop closes itself rather than needing a
    // second action someone will forget.
    if (req.body.signature_data) { fields.push('status = ?'); params.push('delivered'); }
    else if (req.body.status !== undefined) {
      if (!STOP_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown stop status.' });
      fields.push('status = ?'); params.push(req.body.status);
    }

    if (!fields.length) return res.json({ ok: true });
    fields.push('updated_at = NOW()');
    params.push(req.params.stopId);
    await pool.query(`UPDATE delivery_itinerary_stops SET ${fields.join(', ')} WHERE id = ?`, params);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.put('/stops/:stopId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const map = {
      delivery_date: () => req.body.delivery_date || null,
      qty_to_deliver: () => (req.body.qty_to_deliver === '' || req.body.qty_to_deliver == null
        ? null : Number(req.body.qty_to_deliver)),
      fulfillment_type: () => (req.body.fulfillment_type === 'partial' ? 'partial' : 'full'),
      delivery_address: () => trunc(req.body.delivery_address, 500),
      person_in_charge: () => trunc(req.body.person_in_charge, 150),
      odometer: () => trunc(req.body.odometer, 30),
      customer_name: () => trunc(req.body.customer_name, 255),
      remarks: () => trunc(req.body.remarks, 500),
      time_of_arrival: () => req.body.time_of_arrival || null,
    };

    const pt = readPoint(req.body, 'latitude', 'longitude');
    if (pt.error) return res.status(400).json({ error: pt.error });
    const fields = [];
    const params = [];
    for (const [col, read] of Object.entries(map)) {
      if (req.body[col] === undefined) continue;
      const v = read();
      if (col === 'qty_to_deliver' && v !== null && (!Number.isFinite(v) || v < 0)) {
        return res.status(400).json({ error: 'Quantity to deliver must be zero or more.' });
      }
      fields.push(`${col} = ?`); params.push(v);
    }
    if (req.body.status !== undefined) {
      if (!STOP_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown stop status.' });
      fields.push('status = ?'); params.push(req.body.status);
    }
    if (!pt.skip) {
      fields.push('latitude = ?', 'longitude = ?');
      params.push(pt.lat, pt.lng);
    }
    if (!fields.length) return res.json({ ok: true });
    fields.push('updated_at = NOW()');
    params.push(req.params.stopId);
    const [r] = await pool.query(`UPDATE delivery_itinerary_stops SET ${fields.join(', ')} WHERE id = ?`, params);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.delete('/stops/:stopId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[s]] = await pool.query(
      'SELECT (signature_data IS NOT NULL) AS signed FROM delivery_itinerary_stops WHERE id = ?', [req.params.stopId]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.signed) return res.status(409).json({ error: 'This stop is signed for and cannot be removed.' });
    await pool.query('DELETE FROM delivery_itinerary_stops WHERE id = ?', [req.params.stopId]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Adding Sales Orders to a run.
//
// Customer, address and quantity are COPIED onto the stop rather than joined at read time. A run
// sheet records what was planned and signed for on the day; correcting an SO's shipping address
// next month must not rewrite where last month's driver was actually sent.
router.post('/:id/stops', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[it]] = await conn.query(
      'SELECT id, itinerary_date, status FROM delivery_itineraries WHERE id = ?', [req.params.id]);
    if (!it) return res.status(404).json({ error: 'Not found' });
    if (it.status === 'cancelled') return res.status(409).json({ error: 'This run is cancelled.' });

    const ids = (Array.isArray(req.body.sales_order_ids) ? req.body.sales_order_ids : [])
      .map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one Sales Order.' });

    const [orders] = await conn.query(
      `SELECT so.id, so.shipping_address, c.name AS customer_name, cc.contact_name,
              ${READY_QTY_SQL} AS qty_ready
         FROM sales_orders so
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
        WHERE so.id IN (?)`, [ids],
    );
    const byId = new Map(orders.map((o) => [o.id, o]));

    const [[seq]] = await conn.query(
      'SELECT COALESCE(MAX(sequence_no), 0) AS n FROM delivery_itinerary_stops WHERE itinerary_id = ?',
      [req.params.id],
    );
    let next = Number(seq.n);

    await conn.beginTransaction();
    const added = [];
    const skipped = [];
    for (const soId of ids) {
      const o = byId.get(soId);
      if (!o) { skipped.push({ sales_order_id: soId, reason: 'not found' }); continue; }
      const [[dupe]] = await conn.query(
        'SELECT id FROM delivery_itinerary_stops WHERE itinerary_id = ? AND sales_order_id = ?',
        [req.params.id, soId],
      );
      if (dupe) { skipped.push({ sales_order_id: soId, reason: 'already on this run' }); continue; }
      next += 1;
      const [r] = await conn.query(
        `INSERT INTO delivery_itinerary_stops
           (itinerary_id, sequence_no, sales_order_id, delivery_date, customer_name, qty_to_deliver,
            fulfillment_type, delivery_address, person_in_charge)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [req.params.id, next, soId, it.itinerary_date, trunc(o.customer_name, 255), o.qty_ready,
          'full', trunc(o.shipping_address, 500), trunc(o.contact_name, 150)],
      );
      added.push(r.insertId);
    }
    await conn.commit();
    return res.status(201).json({ added: added.length, skipped });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

// Deciding what goes out first. The whole ordered list is sent at once rather than a swap at a
// time, so the sequence the planner sees is the sequence that gets stored -- no chance of two
// stops ending up sharing a position.
router.put('/:id/stops/order', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const order = (Array.isArray(req.body.stop_ids) ? req.body.stop_ids : []).map(Number).filter(Number.isInteger);
    if (!order.length) return res.status(400).json({ error: 'No order was given.' });

    const [existing] = await conn.query(
      'SELECT id FROM delivery_itinerary_stops WHERE itinerary_id = ?', [req.params.id]);
    const known = new Set(existing.map((s) => s.id));
    if (order.length !== known.size || !order.every((id) => known.has(id))) {
      return res.status(400).json({ error: 'The order must list every stop on this run exactly once.' });
    }

    await conn.beginTransaction();
    for (let i = 0; i < order.length; i += 1) {
      await conn.query(
        'UPDATE delivery_itinerary_stops SET sequence_no = ?, updated_at = NOW() WHERE id = ? AND itinerary_id = ?',
        [i + 1, order[i], req.params.id],
      );
    }
    await conn.commit();
    return res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
