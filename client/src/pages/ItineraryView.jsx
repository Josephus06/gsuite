import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const STATUS_BADGE = {
  draft: 'badge-muted', scheduled: 'badge-info', dispatched: 'badge-warning',
  completed: 'badge-success', cancelled: 'badge-muted',
};
const STOP_BADGE = { pending: 'badge-muted', delivered: 'badge-success', failed: 'badge-warning' };

function fmtDate(v) { return v ? String(v).slice(0, 10) : ''; }
function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 16).replace('T', ' ')
    : d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
}
// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time. Feeding it an ISO string in UTC shifts
// the arrival by the timezone offset, which on a delivery log reads as the driver arriving hours
// early.
function toLocalInput(v) {
  const d = v ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Picking which pending Sales Orders join this run.
function AddStopsModal({ itineraryId, onClose, onSaved }) {
  const [rows, setRows] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (q, all) => {
    setLoading(true);
    try {
      const { data } = await api.get('/itineraries/schedulable', {
        params: { search: q || undefined, all: all ? 1 : undefined },
      });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load Sales Orders.'); }
    setLoading(false);
  }, []);
  useEffect(() => { load(search, showAll); }, [load, showAll]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id) {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function save() {
    if (!picked.size) { setError('Choose at least one Sales Order.'); return; }
    setError(''); setSaving(true);
    try {
      const { data } = await api.post(`/itineraries/${itineraryId}/stops`, { sales_order_ids: [...picked] });
      onSaved(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not add the stops.'); setSaving(false); }
  }

  return (
    <Modal title="Add Sales Orders to this run" onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Search</label>
        <input value={search} placeholder="SO number or customer"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(search, showAll)} />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {showAll
            ? 'Every Sales Order holding quantity that is built, QI-passed and not yet delivered — whatever its status.'
            : 'Sales Orders awaiting delivery, with quantity that is built, QI-passed and not yet delivered.'}
        </div>
        {/* A few orders read 'billed' while still holding undelivered stock. They are out of the
            way by default, but reachable -- otherwise that stock could never be put on a run. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontWeight: 400 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span style={{ fontSize: 13 }}>Also show orders already billed or invoiced that still hold stock</span>
        </label>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="responsive-cards">
            <thead>
              <tr><th /><th>SO #</th><th>Customer</th><th>Qty Ready</th><th>Status</th><th>Address</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  Nothing is ready to deliver.
                </td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td data-label="SO #">
                    {r.sales_order_no}
                    {/* Already on another run: offered, not hidden -- moving a stop between days
                        is normal, scheduling it twice by accident is not. */}
                    {r.scheduled_on && (
                      <div style={{ color: '#b45309', fontSize: 11 }}>already on {r.scheduled_on}</div>
                    )}
                  </td>
                  <td data-label="Customer">{r.customer_name}</td>
                  <td data-label="Qty Ready">{qty(r.qty_ready)}</td>
                  <td data-label="Status"><span className="badge badge-muted">{r.status}</span></td>
                  <td data-label="Address" style={{ maxWidth: 260, fontSize: 12 }}>{r.shipping_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !picked.size} onClick={save}>
          {saving ? 'Adding...' : `Add ${picked.size || ''} to run`}
        </button>
      </div>
    </Modal>
  );
}

// Arrival time and the receiver's signature, drawn on the screen.
function SignModal({ stop, onClose, onSaved }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const [arrival, setArrival] = useState(toLocalInput(stop.time_of_arrival));
  const [name, setName] = useState(stop.signed_by_name || stop.person_in_charge || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Sized to its own CSS box and scaled for the device pixel ratio, otherwise the stroke lands
  // offset from the fingertip on any phone with a retina screen -- which is every phone a driver
  // will be holding.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * ratio;
    c.height = rect.height * ratio;
    const ctx = c.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  }, []);

  function pos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function start(e) {
    e.preventDefault();
    drawing.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pos(e);
    ctx.beginPath(); ctx.moveTo(x, y);
  }
  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pos(e);
    ctx.lineTo(x, y); ctx.stroke();
    dirty.current = true;
  }
  function end() { drawing.current = false; }
  function clear() {
    const c = canvasRef.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    dirty.current = false;
  }

  async function save(withSignature) {
    setError(''); setSaving(true);
    try {
      const body = { time_of_arrival: arrival || null, signed_by_name: name };
      if (withSignature) {
        if (!dirty.current) { setError('Nothing has been signed yet.'); setSaving(false); return; }
        body.signature_data = canvasRef.current.toDataURL('image/png');
      }
      await api.post(`/itineraries/stops/${stop.id}/signature`, body);
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save.');
      setSaving(false);
    }
  }

  return (
    <Modal title={`${stop.sales_order_no} — arrival & signature`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="field">
          <label>Time of Arrival</label>
          <input type="datetime-local" value={arrival} onChange={(e) => setArrival(e.target.value)} />
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }}
            onClick={() => setArrival(toLocalInput())}>Now</button>
        </div>
        <div className="field">
          <label>Received By</label>
          <input value={name} maxLength={150} onChange={(e) => setName(e.target.value)}
            placeholder="Who signed for it" />
        </div>
      </div>

      <div className="field">
        <label>Signature</label>
        <canvas
          ref={canvasRef}
          style={{
            width: '100%', height: 180, borderRadius: 8, touchAction: 'none',
            border: '1px dashed var(--border, #cbd5e1)', background: '#fff', display: 'block',
          }}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        />
        <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={clear}>Clear</button>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving} onClick={() => save(false)}>
          Save arrival only
        </button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => save(true)}>
          {saving ? 'Saving...' : 'Save signature'}
        </button>
      </div>
    </Modal>
  );
}

// Fetched through the API client rather than pointed at with an <img src>. The endpoint is
// authenticated and a plain image request carries no Authorization header, so the tag would just
// render a broken icon.
function SignatureModal({ stop, onClose }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let objectUrl = '';
    api.get(`/itineraries/stops/${stop.id}/signature`, { responseType: 'blob' })
      .then((res) => { objectUrl = URL.createObjectURL(res.data); setUrl(objectUrl); })
      .catch(() => setError('The signature could not be loaded.'));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [stop.id]);

  return (
    <Modal title={`Signature — ${stop.sales_order_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ textAlign: 'center' }}>
        {url
          ? <img alt="Signature" src={url} style={{ maxWidth: '100%', background: '#fff', borderRadius: 8 }} />
          : !error && <LoadingSpinner />}
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          {stop.signed_by_name || 'Unnamed'} · {fmtTime(stop.signed_at)}
        </div>
      </div>
    </Modal>
  );
}

function EditStopModal({ stop, onClose, onSaved }) {
  const [form, setForm] = useState({
    delivery_date: fmtDate(stop.delivery_date),
    customer_name: stop.customer_name || '',
    qty_to_deliver: stop.qty_to_deliver ?? '',
    fulfillment_type: stop.fulfillment_type || 'full',
    delivery_address: stop.delivery_address || '',
    person_in_charge: stop.person_in_charge || '',
    odometer: stop.odometer || '',
    remarks: stop.remarks || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setError(''); setSaving(true);
    try { await api.put(`/itineraries/stops/${stop.id}`, form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); setSaving(false); }
  }

  return (
    <Modal title={`Edit stop — ${stop.sales_order_no}`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="field">
          <label>Delivery Date</label>
          <input type="date" value={form.delivery_date}
            onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} />
        </div>
        <div className="field">
          <label>Customer</label>
          <input value={form.customer_name} maxLength={255}
            onChange={(e) => setForm({ ...form, customer_name: e.target.value })} />
        </div>
        <div className="field">
          <label>Qty to Deliver</label>
          <input type="number" min="0" step="0.0001" value={form.qty_to_deliver}
            onChange={(e) => setForm({ ...form, qty_to_deliver: e.target.value })} />
        </div>
        <div className="field">
          <label>Partial / Full</label>
          <select value={form.fulfillment_type}
            onChange={(e) => setForm({ ...form, fulfillment_type: e.target.value })}>
            <option value="full">Full</option>
            <option value="partial">Partial</option>
          </select>
        </div>
        <div className="field">
          <label>Person in Charge</label>
          <input value={form.person_in_charge} maxLength={150}
            onChange={(e) => setForm({ ...form, person_in_charge: e.target.value })} />
        </div>
        <div className="field">
          <label>Odometer</label>
          <input value={form.odometer} maxLength={30}
            onChange={(e) => setForm({ ...form, odometer: e.target.value })}
            placeholder="Reading written on the sheet" />
        </div>
        <div className="field">
          <label>Remarks</label>
          <input value={form.remarks} maxLength={500}
            onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Delivery Address</label>
        <textarea rows={2} value={form.delivery_address} maxLength={500}
          onChange={(e) => setForm({ ...form, delivery_address: e.target.value })} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

export default function ItineraryView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [it, setIt] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [signing, setSigning] = useState(null);
  const [editing, setEditing] = useState(null);
  const [viewSig, setViewSig] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const canEdit = can('/itineraries', 'can_edit');
  const canDelete = can('/itineraries', 'can_delete');

  const load = useCallback(() => api.get(`/itineraries/${id}`)
    .then(({ data }) => { setIt(data); setLoading(false); }), [id]);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);
  useEffect(() => { api.get('/itineraries/drivers').then(({ data }) => setDrivers(data)).catch(() => setDrivers([])); }, []);

  async function patch(body) {
    setBusy(true); setError('');
    try { await api.put(`/itineraries/${id}`, body); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
    finally { setBusy(false); }
  }

  // Reordering is sent as the whole list, so the sequence on screen is the sequence stored --
  // no two stops can end up sharing a position.
  async function moveStop(index, delta) {
    const stops = [...(it.stops || [])];
    const target = index + delta;
    if (target < 0 || target >= stops.length) return;
    [stops[index], stops[target]] = [stops[target], stops[index]];
    setIt({ ...it, stops });
    setBusy(true); setError('');
    try { await api.put(`/itineraries/${id}/stops/order`, { stop_ids: stops.map((s) => s.id) }); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not reorder.'); await load(); }
    finally { setBusy(false); }
  }

  async function removeStop(stop) {
    if (!confirm(`Remove ${stop.sales_order_no} from this run?`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/itineraries/stops/${stop.id}`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not remove the stop.'); }
    finally { setBusy(false); }
  }

  async function removeRun() {
    if (!confirm('Delete this itinerary?')) return;
    setBusy(true); setError('');
    try { await api.delete(`/itineraries/${id}`); navigate('/itineraries'); }
    catch (e) { setError(e.response?.data?.error || 'Could not delete.'); setBusy(false); }
  }

  if (loading || !it) return <LoadingSpinner />;
  const stops = it.stops || [];
  const delivered = stops.filter((s) => s.status === 'delivered').length;
  const cancelled = it.status === 'cancelled';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/itineraries')}>Back</button>
          <button className="btn btn-sm" onClick={() => navigate(`/itineraries/${id}/print`)}>Print</button>
          {canEdit && !cancelled && (
            <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)}>Add Sales Orders</button>
          )}
          {canEdit && !cancelled && it.status === 'draft' && (
            <button className="btn btn-sm" disabled={busy} onClick={() => patch({ status: 'scheduled' })}>Mark Scheduled</button>
          )}
          {canEdit && !cancelled && (it.status === 'scheduled' || it.status === 'draft') && (
            <button className="btn btn-sm" disabled={busy} onClick={() => patch({ status: 'dispatched' })}>Dispatch</button>
          )}
          {canEdit && !cancelled && it.status === 'dispatched' && (
            <button className="btn btn-sm" disabled={busy} onClick={() => patch({ status: 'completed' })}>Complete</button>
          )}
          {canEdit && !cancelled && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => patch({ status: 'cancelled' })}>Cancel Run</button>
          )}
          {canDelete && <button className="btn btn-sm btn-warning" disabled={busy} onClick={removeRun}>Delete</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="muted" style={{ marginBottom: 8 }}>{notice}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Itinerary</h1>
          <span className="estimate-no">{it.itinerary_no}</span>
        </div>
        <div className="estimate-status">
          <span className={`badge ${STATUS_BADGE[it.status] || 'badge-muted'}`}>{it.status}</span>
        </div>
        <div className="estimate-detail-grid">
          <div>
            <h4>Run</h4>
            <div>Date : <span className="hi">{fmtDate(it.itinerary_date)}</span></div>
            <div>Stops : <span className="hi">{delivered} of {stops.length} delivered</span></div>
            <div>Prepared By : <span className="hi">{it.created_by_name || '—'}</span></div>
          </div>
          <div>
            <h4>Driver</h4>
            <div className="hi">{it.driver_name || 'Not assigned'}</div>
            <div>Plate : <span className="hi">{it.plate_no || '—'}</span></div>
            <div>Contact : <span className="hi">{it.driver_contact || '—'}</span></div>
            <div>Licence : <span className="hi">{it.driver_licence || '—'}</span></div>
          </div>
          <div>
            <div>Remarks : <span className="hi">{it.remarks || '—'}</span></div>
          </div>
        </div>
      </div>

      {canEdit && !cancelled && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="field">
              <label>Date</label>
              <input type="date" value={fmtDate(it.itinerary_date)} disabled={busy}
                onChange={(e) => patch({ itinerary_date: e.target.value })} />
            </div>
            <div className="field">
              <label>Driver</label>
              <select value={it.driver_id || ''} disabled={busy}
                onChange={(e) => patch({ driver_id: e.target.value || null })}>
                <option value="">--Not assigned--</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Plate No.</label>
              <input defaultValue={it.plate_no || ''} maxLength={30} disabled={busy}
                onBlur={(e) => e.target.value !== (it.plate_no || '') && patch({ plate_no: e.target.value })} />
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Stops ({stops.length})</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            In delivery order — use the arrows to decide what goes out first.
          </span>
        </div>

        <div className="table-wrap">
          <table className="responsive-cards">
            <thead>
              <tr>
                <th>#</th>
                <th>SO Number</th>
                <th>Delivery Date</th>
                <th>Customer</th>
                <th>Qty to Deliver</th>
                <th>Partial / Full</th>
                <th>Delivery Address</th>
                <th>Person in Charge</th>
                <th>Odometer</th>
                <th>Time of Arrival</th>
                <th>Signature</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stops.length === 0 && (
                <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No stops yet. Add the Sales Orders this run will deliver.
                </td></tr>
              )}
              {stops.map((s, i) => (
                <tr key={s.id}>
                  <td data-label="#">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <strong>{i + 1}</strong>
                      {canEdit && !cancelled && (
                        <span style={{ display: 'flex', flexDirection: 'column' }}>
                          <button className="link-btn" disabled={busy || i === 0} title="Move earlier"
                            onClick={() => moveStop(i, -1)}>▲</button>
                          <button className="link-btn" disabled={busy || i === stops.length - 1} title="Move later"
                            onClick={() => moveStop(i, 1)}>▼</button>
                        </span>
                      )}
                    </div>
                  </td>
                  <td data-label="SO Number">
                    <button type="button" className="link-btn"
                      onClick={() => navigate(`/sales-orders/${s.sales_order_id}`)}>{s.sales_order_no}</button>
                  </td>
                  <td data-label="Delivery Date">{fmtDate(s.delivery_date)}</td>
                  <td data-label="Customer">{s.customer_name || '—'}</td>
                  <td data-label="Qty to Deliver">{qty(s.qty_to_deliver)}</td>
                  <td data-label="Partial / Full">
                    <span className={`badge ${s.fulfillment_type === 'partial' ? 'badge-warning' : 'badge-muted'}`}>
                      {s.fulfillment_type === 'partial' ? 'Partial' : 'Full'}
                    </span>
                  </td>
                  <td data-label="Delivery Address" style={{ maxWidth: 220, fontSize: 12 }}>{s.delivery_address || '—'}</td>
                  <td data-label="Person in Charge">{s.person_in_charge || '—'}</td>
                  {/* Written on the printed sheet by the driver; kept here so it can be
                      keyed back in afterwards. */}
                  <td data-label="Odometer">{s.odometer || '—'}</td>
                  <td data-label="Time of Arrival">{fmtTime(s.time_of_arrival) || '—'}</td>
                  <td data-label="Signature">
                    {s.has_signature ? (
                      <button type="button" className="link-btn" onClick={() => setViewSig(s)}>
                        {s.signed_by_name || 'View'}
                      </button>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td data-label="Status">
                    <span className={`badge ${STOP_BADGE[s.status] || 'badge-muted'}`}>{s.status}</span>
                  </td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {canEdit && !cancelled && (
                      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setSigning(s)}>
                        {s.has_signature ? 'Re-sign' : 'Arrive / Sign'}
                      </button>
                    )}
                    {canEdit && !cancelled && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(s)}>Edit</button>
                    )}
                    {canEdit && !cancelled && !s.has_signature && (
                      <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => removeStop(s)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <AddStopsModal itineraryId={id} onClose={() => setShowAdd(false)}
          onSaved={(d) => {
            setShowAdd(false);
            setNotice(d.skipped?.length
              ? `${d.added} added, ${d.skipped.length} skipped (already on this run).`
              : `${d.added} added.`);
            load();
          }} />
      )}
      {signing && (
        <SignModal stop={signing} onClose={() => setSigning(null)}
          onSaved={() => { setSigning(null); load(); }} />
      )}
      {editing && (
        <EditStopModal stop={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      {viewSig && (
        <SignatureModal stop={viewSig} onClose={() => setViewSig(null)} />
      )}
    </div>
  );
}
