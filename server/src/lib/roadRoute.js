const crypto = require('crypto');

// Road routing for a delivery run: the actual streets between the starting point and each stop,
// with distance and drive time per leg.
//
// GraphHopper, on their free plan. Chosen over the public OSRM demo server, which works and needs
// no key but whose operators ask people not to use it in production -- putting a company's daily
// dispatch on that is borrowing something we were told not to borrow. Measured against the real
// route first: Mandaue to Cebu Doctors Hospital comes back 10.81km / 24 min, against 7.4km as the
// crow flies, so the straight line was understating the journey by about a third.
//
// EVERY RESULT IS CACHED against a fingerprint of the ordered points. A route only changes when
// the points do -- reorder the stops, move a pin, change the origin. Opening the run, refreshing
// the driver's position every 30 seconds and printing all reuse it. Without that a dispatcher
// leaving the page open would spend a request a minute redrawing a line that had not moved.
const ENDPOINT = 'https://graphhopper.com/api/1/route';
const TIMEOUT_MS = 12000;
// GraphHopper's free plan allows a handful of points per request and a few hundred requests a day.
// A delivery run with more stops than this is not a routing problem, it is a planning one.
const MAX_POINTS = 20;

// The fingerprint. Coordinates are rounded to five decimals -- about a metre, far finer than a
// delivery address needs -- so floating-point noise between reads cannot invalidate a cache that
// is actually still correct.
function routeKey(points) {
  const flat = points.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(';');
  return crypto.createHash('sha256').update(flat).digest('hex').slice(0, 64);
}

// Builds the ordered list of points: the starting point, then each pinned stop in delivery order.
// Unpinned stops are skipped rather than guessed at -- a stop with no coordinates is simply not on
// the map, and inventing one would route a van somewhere it was never sent.
function pointsFor(run, stops) {
  const points = [];
  if (run.origin_latitude != null && run.origin_longitude != null) {
    points.push([Number(run.origin_latitude), Number(run.origin_longitude)]);
  }
  for (const s of stops) {
    if (s.latitude == null || s.longitude == null) continue;
    points.push([Number(s.latitude), Number(s.longitude)]);
  }
  return points;
}

async function fetchRoute(points) {
  const key = process.env.GRAPHHOPPER_API_KEY;
  if (!key) return { error: 'no_key' };
  if (points.length < 2) return { error: 'not_enough_points' };
  if (points.length > MAX_POINTS) return { error: 'too_many_points' };

  const qs = points.map(([lat, lng]) => `point=${lat},${lng}`).join('&');
  const url = `${ENDPOINT}?${qs}&profile=car&points_encoded=false&instructions=false&key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.json();
    if (!res.ok || !body.paths || !body.paths.length) {
      // The service's own message is far more useful than a generic failure -- it says "outside
      // supported area" or "quota exceeded", and the planner should see which.
      return { error: 'routing_failed', detail: String(body.message || res.status).slice(0, 200) };
    }
    const path = body.paths[0];
    return {
      // GeoJSON is [lng, lat]; Leaflet wants [lat, lng]. Flipped here, once, rather than in the
      // component -- getting this backwards puts Cebu in Somalia.
      geometry: (path.points?.coordinates || []).map(([lng, lat]) => [lat, lng]),
      legs: (path.details?.legs || []).length ? path.details.legs : null,
      distance_m: Math.round(path.distance || 0),
      duration_s: Math.round((path.time || 0) / 1000),
    };
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'timeout' };
    return { error: 'unreachable', detail: String(err.message).slice(0, 200) };
  } finally { clearTimeout(timer); }
}

// Leg-by-leg distance and time, so the planner can see that stop 3 is the long one.
//
// Asked for as separate two-point routes rather than read out of the multi-point response:
// GraphHopper returns per-leg detail only on paid plans, and a handful of extra cached requests
// costs less than being wrong about which drop eats the morning.
async function fetchLegs(points) {
  const legs = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const r = await fetchRoute([points[i], points[i + 1]]);
    if (r.error) return null;
    legs.push({ from: i, to: i + 1, distance_m: r.distance_m, duration_s: r.duration_s });
  }
  return legs;
}

module.exports = { routeKey, pointsFor, fetchRoute, fetchLegs, MAX_POINTS };
