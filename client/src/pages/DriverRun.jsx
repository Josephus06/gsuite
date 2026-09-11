import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';

// The driver's screen. Opened from a link, no login, on a phone in a van.
//
// It does NOT use the shared api client: that one attaches the logged-in user's token and
// redirects to /login on a 401, neither of which makes sense here. A plain axios instance keeps
// this page independent of whether anyone is signed in on the device -- a driver opening the link
// on a phone that once logged in as somebody else must not be treated as that person.
//
// Relative '/api', matching the web build: the page is served from the same origin it calls.
const api = axios.create({ baseURL: '/api' });

const fmtDate = (v) => (v ? String(v).slice(0, 10) : '');
function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(11, 16)
    : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};

// Everything here is sized for a thumb: 16px inputs so iOS does not zoom on focus, and targets
// well above the 44px minimum. A driver is using this standing at a tailgate, not at a desk.
const S = {
  page: { maxWidth: 560, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' },
  card: { border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 12, background: '#fff' },
  btn: {
    width: '100%', padding: '14px 16px', fontSize: 16, fontWeight: 600, borderRadius: 10,
    border: '1px solid #4f46e5', background: '#4f46e5', color: '#fff', cursor: 'pointer',
  },
  btnQuiet: {
    width: '100%', padding: '12px 16px', fontSize: 15, borderRadius: 10,
    border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a', cursor: 'pointer',
  },
  input: {
    width: '100%', padding: '12px', fontSize: 16, borderRadius: 8,
    border: '1px solid #cbd5e1', boxSizing: 'border-box',
  },
  label: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#334155' },
  muted: { color: '#64748b', fontSize: 13 },
  err: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 8, marginBottom: 12 },
};

function Signature({ onDone, onCancel, busy }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const [name, setName] = useState('');

  useEffect(() => {
    const c = ref.current;
    const ratio = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * ratio;
    c.height = rect.height * ratio;
    const ctx = c.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
  }, []);

  const pos = (e) => {
    const r = ref.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const start = (e) => { e.preventDefault(); drawing.current = true; const { x, y } = pos(e); const c = ref.current.getContext('2d'); c.beginPath(); c.moveTo(x, y); };
  const move = (e) => { if (!drawing.current) return; e.preventDefault(); const { x, y } = pos(e); const c = ref.current.getContext('2d'); c.lineTo(x, y); c.stroke(); dirty.current = true; };
  const end = () => { drawing.current = false; };

  return (
    <div style={{ marginTop: 10 }}>
      <label style={S.label}>Received by</label>
      <input style={S.input} value={name} maxLength={150} placeholder="Name of who signed"
        onChange={(e) => setName(e.target.value)} />
      <label style={{ ...S.label, marginTop: 10 }}>Signature</label>
      <canvas ref={ref}
        style={{ width: '100%', height: 170, border: '1px dashed #94a3b8', borderRadius: 10, background: '#fff', touchAction: 'none', display: 'block' }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" style={S.btnQuiet} disabled={busy}
          onClick={() => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); dirty.current = false; }}>
          Clear
        </button>
        <button type="button" style={S.btnQuiet} disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" style={S.btn} disabled={busy}
          onClick={() => {
            if (!dirty.current) { alert('Nothing has been signed yet.'); return; }
            onDone({ signature_data: ref.current.toDataURL('image/png'), signed_by_name: name });
          }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Stop({ stop, token, index, onChanged }) {
  const [open, setOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [odometer, setOdometer] = useState(stop.odometer || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const arrived = !!stop.time_of_arrival;
  const done = stop.status === 'delivered';
  const prev = stop.previous_odometer;
  const leg = num(odometer) !== null && prev !== null ? num(odometer) - prev : null;

  async function post(path, body) {
    setBusy(true); setError('');
    try { await api.post(`/driver/${token}${path}`, body); await onChanged(); return true; }
    catch (e) { setError(e.response?.data?.error || 'Could not save. Check your signal and try again.'); return false; }
    finally { setBusy(false); }
  }

  return (
    <div style={{ ...S.card, borderColor: done ? '#86efac' : '#e2e8f0', background: done ? '#f0fdf4' : '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 17 }}>{index}. {stop.customer_name || 'Customer'}</strong>
        <span style={{ ...S.muted, whiteSpace: 'nowrap' }}>
          {done ? '✓ delivered' : arrived ? `arrived ${fmtTime(stop.time_of_arrival)}` : ''}
        </span>
      </div>
      <div style={S.muted}>{stop.sales_order_no}{stop.qty_to_deliver ? ` · ${Number(stop.qty_to_deliver)} ${stop.fulfillment_type === 'partial' ? '(partial)' : ''}` : ''}</div>
      {stop.delivery_address && <div style={{ marginTop: 6 }}>{stop.delivery_address}</div>}
      {stop.person_in_charge && <div style={S.muted}>Contact: {stop.person_in_charge}</div>}

      {error && <div style={{ ...S.err, marginTop: 10, marginBottom: 0 }}>{error}</div>}

      {!open && !done && (
        <button type="button" style={{ ...S.btn, marginTop: 12 }} onClick={() => setOpen(true)}>
          {arrived ? 'Continue' : 'Arrive'}
        </button>
      )}

      {open && !signing && (
        <div style={{ marginTop: 12 }}>
          <label style={S.label}>Odometer now</label>
          <input style={S.input} type="text" inputMode="numeric" value={odometer}
            placeholder={prev !== null ? `last reading ${prev.toLocaleString()}` : 'reading on the dashboard'}
            onChange={(e) => setOdometer(e.target.value)} />
          {/* The app does the arithmetic; the driver reads the dashboard. A negative leg means a
              typo, and it is worth catching while they are still standing there. */}
          {leg !== null && (
            <div style={{ ...S.muted, marginTop: 6, color: leg < 0 ? '#b91c1c' : '#64748b' }}>
              {leg < 0 ? `That is ${Math.abs(leg).toLocaleString()} BELOW the last reading — check it.`
                : `${leg.toLocaleString()} since the last stop`}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={S.btnQuiet} disabled={busy} onClick={() => setOpen(false)}>Close</button>
            <button type="button" style={S.btn} disabled={busy}
              onClick={async () => { if (await post(`/stops/${stop.id}/arrive`, { odometer })) setSigning(true); }}>
              {busy ? 'Saving…' : arrived ? 'Save & sign' : 'Arrived — save'}
            </button>
          </div>
        </div>
      )}

      {signing && (
        <Signature busy={busy} onCancel={() => setSigning(false)}
          onDone={async (body) => { if (await post(`/stops/${stop.id}/sign`, body)) { setSigning(false); setOpen(false); } }} />
      )}

      {done && (
        <div style={{ ...S.muted, marginTop: 8 }}>
          {stop.odometer ? `Odometer ${stop.odometer}. ` : ''}
          Signed by {stop.signed_by_name || 'recipient'} at {fmtTime(stop.signed_at)}.
        </div>
      )}
    </div>
  );
}

// Reports where the phone is, every 30 seconds, while this page is open.
//
// Deliberately opt-in and visible. This tracks a person, so the driver taps to start it, can stop
// it at any time, and the page says plainly what it is doing -- a run sheet that quietly reported
// someone's location would be a nasty thing to discover.
//
// It only works over HTTPS. Browsers refuse geolocation on an insecure origin, which is why this
// reports nothing on the plain-HTTP office and droplet boxes.
function useLocationSharing(token) {
  const [state, setState] = useState('off'); // off | asking | on | denied | unsupported
  const [lastSent, setLastSent] = useState(null);
  const timer = useRef(null);

  const send = useCallback((pos) => {
    const c = pos.coords;
    api.post(`/driver/${token}/position`, {
      latitude: c.latitude,
      longitude: c.longitude,
      accuracy_m: c.accuracy,
      // The browser reports metres per second; the office reads km/h.
      speed_kph: c.speed === null || c.speed === undefined ? null : c.speed * 3.6,
      heading_deg: c.heading === null || c.heading === undefined ? null : c.heading,
    }).then(() => setLastSent(new Date())).catch(() => {});
  }, [token]);

  const stop = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    setState('off');
  }, []);

  const start = useCallback(() => {
    if (!navigator.geolocation) { setState('unsupported'); return; }
    setState('asking');
    const tick = () => navigator.geolocation.getCurrentPosition(
      (pos) => { setState('on'); send(pos); },
      (err) => setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'on'),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 },
    );
    tick();
    timer.current = setInterval(tick, 30000);
  }, [send]);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  return { state, lastSent, start, stop };
}

export default function DriverRun() {
  const { token } = useParams();
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [begin, setBegin] = useState('');
  const [busy, setBusy] = useState(false);
  const location = useLocationSharing(token);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/driver/${token}`);
      setRun(data);
      setBegin(data.beginning_odometer || '');
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'This link could not be opened.');
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={S.page}>Loading…</div>;
  if (!run) return <div style={S.page}><div style={S.err}>{error}</div></div>;

  const stops = run.stops || [];
  const delivered = stops.filter((s) => s.status === 'delivered').length;
  const started = !!run.beginning_odometer;

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 20, margin: '0 0 2px' }}>Delivery Run</h1>
      <div style={S.muted}>
        {run.itinerary_no} · {fmtDate(run.itinerary_date)}
        {run.driver_name ? ` · ${run.driver_name}` : ''}{run.plate_no ? ` · ${run.plate_no}` : ''}
      </div>
      <div style={{ ...S.muted, marginBottom: 12 }}>{delivered} of {stops.length} delivered</div>

      {error && <div style={S.err}>{error}</div>}

      {/* Said out loud, not buried. The driver chooses to share and can stop whenever. */}
      <div style={{ ...S.card, background: location.state === 'on' ? '#f0fdf4' : '#f8fafc' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <strong style={{ fontSize: 15 }}>
              {location.state === 'on' ? 'Sharing your location' : 'Location sharing is off'}
            </strong>
            <div style={S.muted}>
              {location.state === 'on'
                ? `The office can see where you are while this page is open.${location.lastSent ? ` Last sent ${fmtTime(location.lastSent)}.` : ''}`
                : location.state === 'denied'
                  ? 'Your phone blocked location. Allow it in your browser settings if the office needs it.'
                  : location.state === 'unsupported'
                    ? 'This phone cannot share location.'
                    : location.state === 'asking'
                      ? 'Waiting for your phone to allow it…'
                      : 'Turn this on so the office can see where you are during the run.'}
            </div>
          </div>
          <button type="button"
            style={{ ...S.btnQuiet, width: 'auto', whiteSpace: 'nowrap' }}
            onClick={() => (location.state === 'on' ? location.stop() : location.start())}>
            {location.state === 'on' ? 'Stop' : 'Share'}
          </button>
        </div>
        {location.state === 'on' && (
          <div style={{ ...S.muted, marginTop: 8, fontSize: 12 }}>
            Updates stop when you lock the phone or switch apps. Come back to this page to resume.
          </div>
        )}
      </div>

      {/* The run's starting reading. Every stop's leg is measured from here, so it is asked for
          once, up front, rather than being guessed backwards from the first stop. */}
      <div style={S.card}>
        <label style={S.label}>Odometer at the start of the run</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={S.input} type="text" inputMode="numeric" value={begin}
            placeholder="reading before leaving" onChange={(e) => setBegin(e.target.value)} />
          <button type="button" style={{ ...S.btn, width: 'auto', whiteSpace: 'nowrap' }} disabled={busy}
            onClick={async () => {
              setBusy(true); setError('');
              try { await api.post(`/driver/${token}/start`, { beginning_odometer: begin }); await load(); }
              catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
              finally { setBusy(false); }
            }}>
            {started ? 'Update' : 'Start'}
          </button>
        </div>
      </div>

      {stops.length === 0 && <div style={S.card}>No stops on this run yet.</div>}
      {stops.map((s, i) => (
        <Stop key={s.id} stop={s} token={token} index={i + 1} onChanged={load} />
      ))}

      {stops.length > 0 && delivered === stops.length && (
        <div style={{ ...S.card, background: '#f0fdf4', borderColor: '#86efac', textAlign: 'center' }}>
          <strong>All stops delivered.</strong>
          <div style={S.muted}>Nothing else to do — the office can see everything you recorded.</div>
        </div>
      )}
    </div>
  );
}
