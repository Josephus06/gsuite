import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import api from '../api/client';

// Where the driver is, on the itinerary screen.
//
// Leaflet with OpenStreetMap tiles: no API key, no billing, no per-load cost. Good enough to plot a
// dot and a route; if addresses ever get geocoded into pins, that is the point to weigh a paid
// provider, because free geocoding of Philippine addresses is the weak part, not the tiles.
//
// Leaflet's default marker icons are resolved from the stylesheet as relative URLs, which a
// bundler rewrites into nothing useful -- hence plain divIcons below rather than the stock pin.
const OSM = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function ago(when) {
  if (!when) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(when).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}
function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
}

// A fix with a 2km radius is not a sighting. Saying so is the difference between a map that
// informs and one that misleads -- a phone indoors routinely reports hundreds of metres.
const VAGUE_ACCURACY_M = 500;

const km = (m) => (m == null ? null : (m / 1000).toFixed(1) + ' km');
const mins = (s) => {
  if (s == null) return null;
  const m = Math.round(s / 60);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

// A numbered pin for a stop, green once delivered. Built as HTML rather than an image so there is
// no icon asset to resolve and the number is legible at any zoom.
function stopIcon(n, delivered) {
  const bg = delivered ? '#16a34a' : '#0f172a';
  return L.divIcon({
    className: '',
    html: `<div style="width:24px;height:24px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);`
      + `background:${bg};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);`
      + `display:flex;align-items:center;justify-content:center">`
      + `<span style="transform:rotate(45deg);color:#fff;font:700 11px/1 system-ui">${n}</span></div>`,
    iconSize: [24, 24], iconAnchor: [12, 24],
  });
}

const originIcon = L.divIcon({
  className: '',
  html: '<div style="width:22px;height:22px;border-radius:4px;background:#b45309;border:2px solid #fff;'
    + 'box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center">'
    + '<span style="color:#fff;font:700 11px/1 system-ui">S</span></div>',
  iconSize: [22, 22], iconAnchor: [11, 11],
});

export default function DriverMap({ itineraryId, driverName, origin, stops = [] }) {
  const holder = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const [data, setData] = useState(null);
  const [route, setRoute] = useState(null);
  const [liveRoute, setLiveRoute] = useState(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(true);

  // Position and live route are fetched together on the same 30-second beat. The live route is
  // cheap to ask for: the server answers most calls from arithmetic and cache, and only routes
  // again when the driver has actually left the planned way or a stop has been delivered.
  const load = useCallback(async () => {
    try {
      const [pos, live] = await Promise.all([
        api.get(`/itineraries/${itineraryId}/positions`),
        api.get(`/itineraries/${itineraryId}/live-route`).catch(() => ({ data: null })),
      ]);
      setData(pos.data);
      setLiveRoute(live.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load the driver position.');
    }
  }, [itineraryId]);

  useEffect(() => { load(); }, [load]);

  // The road route. Asked for separately from the driver's position and NOT on the 30-second
  // refresh: a route only changes when the stops or pins do, and the server serves it from cache
  // until then. Re-requesting it every refresh would spend the routing quota on an unchanged line.
  //
  // Keyed on the pinned points so reordering stops or moving a pin does fetch a fresh one.
  const pinKey = JSON.stringify([
    origin?.latitude, origin?.longitude,
    ...stops.map((s) => [s.latitude, s.longitude]),
  ]);
  useEffect(() => {
    let alive = true;
    api.get(`/itineraries/${itineraryId}/route`)
      .then(({ data: r }) => { if (alive) setRoute(r); })
      .catch(() => { if (alive) setRoute(null); });
    return () => { alive = false; };
  }, [itineraryId, pinKey]);

  // Polled rather than pushed. The driver reports every 30 seconds at best, so a socket would buy
  // nothing over asking on the same cadence -- and this page is open on a desk, not a phone.
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [live, load]);

  useEffect(() => {
    if (!holder.current || map.current) return;
    // Cebu, so an empty map opens somewhere recognisable rather than in the ocean off Africa.
    map.current = L.map(holder.current, { scrollWheelZoom: false }).setView([10.3157, 123.8854], 12);
    L.tileLayer(OSM, { attribution: ATTRIB, maxZoom: 19 }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
  }, []);

  useEffect(() => {
    if (!map.current || !layer.current || !data) return;
    layer.current.clearLayers();
    const everything = [];

    // The plan: starting point, then the stops in delivery order. Dashed, because it is the
    // intended sequence rather than a road route -- drawing it solid would imply the van goes in
    // a straight line between drops.
    const planned = [];
    if (origin?.latitude != null && origin?.longitude != null) {
      const at = [Number(origin.latitude), Number(origin.longitude)];
      planned.push(at);
      everything.push(at);
      L.marker(at, { icon: originIcon }).addTo(layer.current)
        .bindPopup(`<strong>Start</strong><br>${origin.name || 'Starting point'}`);
    }
    stops.forEach((s, i) => {
      if (s.latitude == null || s.longitude == null) return;
      const at = [Number(s.latitude), Number(s.longitude)];
      planned.push(at);
      everything.push(at);
      L.marker(at, { icon: stopIcon(i + 1, s.status === 'delivered') }).addTo(layer.current)
        .bindPopup(`<strong>${i + 1}. ${s.customer_name || ''}</strong><br>${s.delivery_address || ''}`);
    });
    // The road route when we have one; the straight sequence only as a fallback, and kept dashed
    // so it never looks like a claimed route. Routing being unavailable degrades the map rather
    // than emptying it.
    if (route?.geometry?.length > 1) {
      L.polyline(route.geometry, { color: '#0f172a', weight: 4, opacity: 0.65 }).addTo(layer.current);
      everything.push(...route.geometry);
    } else if (planned.length > 1) {
      L.polyline(planned, { color: '#0f172a', weight: 2, opacity: 0.45, dashArray: '6 6' }).addTo(layer.current);
    }

    // The way ahead from where the driver actually is. Drawn over the plan rather than replacing
    // it, because the difference between the two IS the information.
    if (liveRoute?.geometry?.length > 1 && liveRoute.state === 'off_route') {
      L.polyline(liveRoute.geometry, { color: '#d97706', weight: 4, opacity: 0.85 }).addTo(layer.current);
      everything.push(...liveRoute.geometry);
    }

    const trail = (data.trail || []).map((p) => [Number(p.latitude), Number(p.longitude)]);
    everything.push(...trail);
    if (trail.length > 1) {
      L.polyline(trail, { color: '#4f46e5', weight: 3, opacity: 0.6 }).addTo(layer.current);
    }

    if (data.latest) {
      const at = [Number(data.latest.latitude), Number(data.latest.longitude)];
      const accuracy = Number(data.latest.accuracy_m);
      if (Number.isFinite(accuracy) && accuracy > 0) {
        L.circle(at, { radius: accuracy, color: '#4f46e5', weight: 1, fillOpacity: 0.08 }).addTo(layer.current);
      }
      L.marker(at, {
        icon: L.divIcon({
          className: '',
          html: '<div style="width:16px;height:16px;border-radius:50%;background:#4f46e5;border:3px solid #fff;box-shadow:0 0 0 1px #4f46e5"></div>',
          iconSize: [16, 16], iconAnchor: [8, 8],
        }),
      }).addTo(layer.current).bindPopup(
        `${driverName || 'Driver'}<br>${fmtTime(data.latest.recorded_at)}`,
      );
      everything.push(at);
      // Follow the van once it is reporting -- that is the thing being watched.
      map.current.setView(at, Math.max(map.current.getZoom(), 14));
    } else if (everything.length > 1) {
      map.current.fitBounds(L.latLngBounds(everything).pad(0.2));
    } else if (everything.length === 1) {
      map.current.setView(everything[0], 15);
    }
    // Leaflet measures the container when it is created; inside a card that was still laying out,
    // that measurement is wrong and half the tiles never load.
    setTimeout(() => map.current && map.current.invalidateSize(), 0);
  }, [data, route, liveRoute, driverName, origin, stops]);

  const latest = data?.latest;
  const vague = latest && Number(latest.accuracy_m) > VAGUE_ACCURACY_M;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Driver Location</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontWeight: 400, fontSize: 13 }}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Auto-refresh
          </label>
          <button className="btn btn-sm" onClick={load}>Refresh</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div ref={holder} style={{ height: 340, borderRadius: 10, overflow: 'hidden', background: '#e5e7eb' }} />

      {route?.distance_m != null && (
        <div style={{ fontSize: 13, marginTop: 8 }}>
          <strong>{km(route.distance_m)}</strong> and about <strong>{mins(route.duration_s)}</strong> driving
          for the whole run{route.legs?.length ? ', by road' : ''}.
          {route.legs?.length > 0 && (
            <div className="muted" style={{ marginTop: 4 }}>
              {route.legs.map((l, i) => (
                <span key={l.from}>
                  {i === 0 ? 'Start' : i}&nbsp;&rarr;&nbsp;{i + 1}: {km(l.distance_m)} / {mins(l.duration_s)}
                  {i < route.legs.length - 1 ? ' · ' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Said in words as well as colour. "Off the planned route" is the thing a dispatcher acts
          on -- a line changing shade is easy to miss on a screen nobody is staring at. */}
      {liveRoute?.state === 'off_route' && (
        <div style={{
          fontSize: 13, marginTop: 8, padding: '8px 10px', borderRadius: 8,
          background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e',
        }}>
          <strong>Driver is off the planned route</strong>
          {liveRoute.deviation?.distance_m != null
            ? ` — about ${liveRoute.deviation.distance_m}m from it.` : '.'}
          {liveRoute.distance_m != null && (
            <> The amber line is the way on from where they are: <strong>{km(liveRoute.distance_m)}</strong>,
              about <strong>{mins(liveRoute.duration_s)}</strong>
              {liveRoute.stops_remaining ? ` for ${liveRoute.stops_remaining} remaining stop${liveRoute.stops_remaining === 1 ? '' : 's'}` : ''}.
            </>
          )}
        </div>
      )}
      {liveRoute?.state === 'on_route' && liveRoute.deviation?.known && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          On the planned route ({liveRoute.deviation.distance_m}m from it).
        </div>
      )}
      {liveRoute?.deviation?.reason === 'fix_too_vague' && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {/* Honest about not knowing: a fix this vague is consistent with being on the route and
              with being nowhere near it. */}
          Cannot tell whether they are on route — that fix is only accurate to
          {' '}{liveRoute.deviation.accuracy_m}m.
        </div>
      )}
      {liveRoute?.state === 'all_delivered' && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Every stop delivered — nothing left to route.
        </div>
      )}

      {route?.error && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8, color: '#b45309' }}>
          Road routing unavailable ({route.error}). The dashed line shows the stop order instead.
        </div>
      )}
      <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        {latest ? (
          <>
            Last seen <strong>{ago(latest.recorded_at)}</strong> ({fmtTime(latest.recorded_at)})
            {Number.isFinite(Number(latest.accuracy_m)) ? ` · accurate to about ${Math.round(latest.accuracy_m)}m` : ''}
            {data.total > 1 ? ` · ${data.total} fixes this run` : ''}
            {vague && (
              <div style={{ color: '#b45309' }}>
                That fix is only accurate to {Math.round(latest.accuracy_m)}m, so treat the pin as the
                general area rather than the spot.
              </div>
            )}
          </>
        ) : (
          <>
            Nothing reported yet. The driver has to open their run link and tap <strong>Share</strong>,
            and their phone must be on the HTTPS address — browsers refuse location over plain HTTP.
          </>
        )}
      </div>
    </div>
  );
}
