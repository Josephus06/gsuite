const crypto = require('crypto');

// Road routing for a delivery run: the actual streets between the starting point and each stop,
// with distance and drive time per leg.
//
// TWO PROVIDERS, tried in order. OpenRouteService first; GraphHopper if it fails and a key exists.
// That is not belt-and-braces for its own sake -- ORS publishes scheduled maintenance windows (one
// ran the afternoon this was written), and a dispatcher watching a van should not lose the line
// because a third party is doing an upgrade.
//
//   ORS          2,000 directions/day, and returns PER-LEG detail in the same response
//   GraphHopper    500/day, per-leg only on paid plans -- so a 4-stop run cost 5 requests there
//
// That per-leg difference is why ORS leads: the same run now costs one request instead of five.
//
// Both are measured against real Cebu geography before being trusted. Mandaue to Cebu Doctors
// Hospital: 10.80km / 21 min by ORS, 10.81km / 24 min by GraphHopper, against 7.4km as the crow
// flies -- so the straight line was understating the journey by about a third either way.
//
// EVERY RESULT IS CACHED against a fingerprint of the ordered points (see routes/itineraries.js).
// A route only changes when the points do.

// api.openrouteservice.org is being retired in favour of api.heigit.org. The new host does NOT
// mirror the old paths -- /v2/... 404s there; the prefix is /openrouteservice/v2/... Verified
// against both before switching, because a deprecated host that works today is worth less than the
// successor that will work next year.
const ORS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson';
const GH_URL = 'https://graphhopper.com/api/1/route';
const TIMEOUT_MS = 12000;
// ORS accepts far more, but a delivery run with more stops than this is not a routing problem,
// it is a planning one.
const MAX_POINTS = 25;

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

async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fn(controller.signal); }
  finally { clearTimeout(timer); }
}

// OpenRouteService. GeoJSON in, GeoJSON out; coordinates are [lng, lat] both ways.
async function fetchFromOrs(points) {
  const key = process.env.ORS_API_KEY;
  if (!key) return { error: 'no_key' };
  const body = JSON.stringify({ coordinates: points.map(([lat, lng]) => [lng, lat]) });

  const res = await withTimeout((signal) => fetch(ORS_URL, {
    method: 'POST', signal, body,
    headers: { Authorization: key, 'Content-Type': 'application/json' },
  }));
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.features?.length) {
    const detail = json?.error?.message || json?.error || res.status;
    return { error: 'routing_failed', detail: String(detail).slice(0, 200) };
  }

  const f = json.features[0];
  const props = f.properties || {};
  return {
    provider: 'ors',
    // [lng, lat] out of GeoJSON; Leaflet wants [lat, lng]. Flipped here, once, rather than in the
    // component -- getting this backwards puts Cebu in Somalia.
    geometry: (f.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng]),
    // Per leg, in the same response. This is the reason ORS leads.
    legs: (props.segments || []).map((s, i) => ({
      from: i, to: i + 1,
      distance_m: Math.round(s.distance || 0),
      duration_s: Math.round(s.duration || 0),
    })),
    distance_m: Math.round(props.summary?.distance || 0),
    duration_s: Math.round(props.summary?.duration || 0),
  };
}

// GraphHopper, the fallback. Returns no per-leg detail on the free plan, so legs come back null
// rather than being bought with N more requests -- the total is what matters when the primary is
// already down.
async function fetchFromGraphHopper(points) {
  const key = process.env.GRAPHHOPPER_API_KEY;
  if (!key) return { error: 'no_key' };
  const qs = points.map(([lat, lng]) => `point=${lat},${lng}`).join('&');
  const url = `${GH_URL}?${qs}&profile=car&points_encoded=false&instructions=false&key=${encodeURIComponent(key)}`;

  const res = await withTimeout((signal) => fetch(url, { signal }));
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.paths?.length) {
    return { error: 'routing_failed', detail: String(json?.message || res.status).slice(0, 200) };
  }
  const path = json.paths[0];
  return {
    provider: 'graphhopper',
    geometry: (path.points?.coordinates || []).map(([lng, lat]) => [lat, lng]),
    legs: null,
    distance_m: Math.round(path.distance || 0),
    duration_s: Math.round((path.time || 0) / 1000),
  };
}

async function fetchRoute(points) {
  if (points.length < 2) return { error: 'not_enough_points' };
  if (points.length > MAX_POINTS) return { error: 'too_many_points' };

  const attempts = [];
  for (const [name, fn] of [['ors', fetchFromOrs], ['graphhopper', fetchFromGraphHopper]]) {
    try {
      const out = await fn(points);
      if (!out.error) return out;
      // A missing key is not a failure worth reporting -- it just means that provider is not
      // configured here.
      if (out.error !== 'no_key') attempts.push(`${name}: ${out.detail || out.error}`);
    } catch (err) {
      attempts.push(`${name}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    }
  }
  return {
    error: attempts.length ? 'routing_failed' : 'no_key',
    detail: attempts.join(' | ').slice(0, 300) || null,
  };
}

// Kept for the caller that asks for legs separately. ORS supplies them inline, so this is only
// reached when GraphHopper served the route -- and there it would cost a request per leg, which is
// not worth spending while the primary provider is down.
async function fetchLegs() {
  return null;
}

// --- has the driver left the planned route? ---------------------------------------------------
//
// Answered with arithmetic, not another routing request. This is checked every time the driver's
// position refreshes -- every 30 seconds while a run is out -- and asking a routing service that
// often would exhaust a free plan by lunchtime. Distance from a point to a polyline is a few lines
// of maths; spending an API call on it would be absurd.

// Metres per degree at Cebu's latitude. An equirectangular approximation: wrong by a fraction of a
// percent over a city, and this is deciding "within 200m or not", not surveying a boundary.
const M_PER_DEG_LAT = 110574;
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// Shortest distance from p to the segment ab, all in metres, projected flat around p.
function distanceToSegment(p, a, b) {
  const kx = mPerDegLng(p[0]);
  const ax = (a[1] - p[1]) * kx; const ay = (a[0] - p[0]) * M_PER_DEG_LAT;
  const bx = (b[1] - p[1]) * kx; const by = (b[0] - p[0]) * M_PER_DEG_LAT;
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // A zero-length segment is just a point; routing geometry does contain repeated coordinates.
  if (len2 === 0) return Math.hypot(ax, ay);
  // How far along ab the perpendicular from p falls, clamped to the segment's ends.
  let t = -((ax * dx + ay * dy) / len2);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function distanceToPath(point, path) {
  if (!Array.isArray(path) || path.length < 2) return null;
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i += 1) {
    const d = distanceToSegment(point, path[i], path[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

// How far off the planned line counts as "gone another way".
//
// 200m, because city streets run parallel and a GPS fix is routinely 20-50m out; a tighter figure
// would cry deviation every time the van passed a block over. A fix whose OWN accuracy is worse
// than this cannot answer the question at all -- a 500m-accurate position is consistent with being
// on the route and with being nowhere near it -- so those are reported as unknown rather than
// guessed.
const DEVIATION_M = 200;

function deviation(position, plannedGeometry) {
  if (!position || !plannedGeometry?.length) return { known: false };
  const accuracy = Number(position.accuracy_m);
  if (Number.isFinite(accuracy) && accuracy > DEVIATION_M) {
    return { known: false, reason: 'fix_too_vague', accuracy_m: Math.round(accuracy) };
  }
  const d = distanceToPath([Number(position.latitude), Number(position.longitude)], plannedGeometry);
  if (d === null) return { known: false };
  return { known: true, distance_m: Math.round(d), off_route: d > DEVIATION_M };
}

module.exports = {
  routeKey, pointsFor, fetchRoute, fetchLegs, MAX_POINTS,
  distanceToPath, deviation, DEVIATION_M,
};
