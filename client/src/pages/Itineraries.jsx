import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: '', label: 'All' },
];

const STATUS_BADGE = {
  draft: 'badge-muted',
  scheduled: 'badge-info',
  dispatched: 'badge-warning',
  completed: 'badge-success',
  cancelled: 'badge-muted',
};

function fmtDate(v) { return v ? String(v).slice(0, 10) : ''; }

function NewRunModal({ drivers, onClose, onSaved }) {
  const [form, setForm] = useState({
    itinerary_date: new Date().toISOString().slice(0, 10),
    driver_id: '', plate_no: '', remarks: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Picking a driver fills the plate from their record, but leaves it editable -- a driver taking a
  // different truck today is normal and should not mean editing the driver master list.
  function pickDriver(id) {
    const d = drivers.find((x) => String(x.id) === String(id));
    setForm((f) => ({ ...f, driver_id: id, plate_no: d?.plate_no || f.plate_no }));
  }

  async function save() {
    if (!form.itinerary_date) { setError('Pick the date for this run.'); return; }
    setError(''); setSaving(true);
    try { const { data } = await api.post('/itineraries', form); onSaved(data); }
    catch (e) { setError(e.response?.data?.error || 'Could not create the run.'); setSaving(false); }
  }

  return (
    <Modal title="New Itinerary" onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Date *</label>
        <input type="date" value={form.itinerary_date}
          onChange={(e) => setForm({ ...form, itinerary_date: e.target.value })} />
      </div>
      <div className="field">
        <label>Driver</label>
        <select value={form.driver_id} onChange={(e) => pickDriver(e.target.value)}>
          <option value="">--Not assigned yet--</option>
          {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.plate_no ? ` — ${d.plate_no}` : ''}</option>)}
        </select>
        {drivers.length === 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            No drivers defined yet. Add them from Manage Drivers.
          </div>
        )}
      </div>
      <div className="field">
        <label>Plate No.</label>
        <input value={form.plate_no} maxLength={30}
          onChange={(e) => setForm({ ...form, plate_no: e.target.value })} />
      </div>
      <div className="field">
        <label>Remarks</label>
        <textarea rows={2} value={form.remarks}
          onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Creating...' : 'Create Run'}
        </button>
      </div>
    </Modal>
  );
}

// Defining the drivers. A small hand-kept list rather than anything nested off employees --
// casual and contracted drivers turn up on run sheets without ever having a payroll record.
function DriversModal({ onClose, canEdit, canDelete }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: '', licence_no: '', contact_no: '', plate_no: '' });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.get('/itineraries/drivers', { params: { include_inactive: 1 } })
    .then(({ data }) => setRows(data)), []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setError(''); setBusy(true);
    try {
      if (editing) await api.put(`/itineraries/drivers/${editing}`, form);
      else await api.post('/itineraries/drivers', form);
      setForm({ name: '', licence_no: '', contact_no: '', plate_no: '' });
      setEditing(null);
      await load();
    } catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
    finally { setBusy(false); }
  }

  async function remove(d) {
    if (!confirm(`Remove ${d.name} from the driver list?`)) return;
    setBusy(true); setError('');
    try {
      const { data } = await api.delete(`/itineraries/drivers/${d.id}`);
      if (data.retired) {
        setError(`${d.name} has ${data.itineraries} run(s) on record, so they were retired rather than deleted.`);
      }
      await load();
    } catch (e) { setError(e.response?.data?.error || 'Could not remove.'); }
    finally { setBusy(false); }
  }

  async function toggle(d) {
    setBusy(true);
    try { await api.put(`/itineraries/drivers/${d.id}`, { ...d, is_active: !d.is_active }); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not update.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Drivers" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      {canEdit && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="field">
              <label>Name *</label>
              <input value={form.name} maxLength={150} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Licence No.</label>
              <input value={form.licence_no || ''} maxLength={60} onChange={(e) => setForm({ ...form, licence_no: e.target.value })} />
            </div>
            <div className="field">
              <label>Contact No.</label>
              <input value={form.contact_no || ''} maxLength={60} onChange={(e) => setForm({ ...form, contact_no: e.target.value })} />
            </div>
            <div className="field">
              <label>Plate No.</label>
              <input value={form.plate_no || ''} maxLength={30} onChange={(e) => setForm({ ...form, plate_no: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={save}>
              {editing ? 'Save Driver' : 'Add Driver'}
            </button>
            {editing && (
              <button className="btn btn-sm" onClick={() => { setEditing(null); setForm({ name: '', licence_no: '', contact_no: '', plate_no: '' }); }}>
                Cancel edit
              </button>
            )}
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="responsive-cards">
          <thead>
            <tr><th>Name</th><th>Licence</th><th>Contact</th><th>Plate</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                No drivers yet.
              </td></tr>
            )}
            {rows.map((d) => (
              <tr key={d.id} style={d.is_active ? undefined : { opacity: 0.55 }}>
                <td data-label="Name">{d.name}</td>
                <td data-label="Licence">{d.licence_no || '—'}</td>
                <td data-label="Contact">{d.contact_no || '—'}</td>
                <td data-label="Plate">{d.plate_no || '—'}</td>
                <td data-label="Status">
                  {d.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Retired</span>}
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  {canEdit && (
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => { setEditing(d.id); setForm({ name: d.name, licence_no: d.licence_no || '', contact_no: d.contact_no || '', plate_no: d.plate_no || '' }); }}>
                      Edit
                    </button>
                  )}
                  {canEdit && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => toggle(d)}>
                      {d.is_active ? 'Retire' : 'Reinstate'}
                    </button>
                  )}
                  {canDelete && d.is_active && (
                    <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => remove(d)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export default function Itineraries() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState({ rows: [], counts: {} });
  const [drivers, setDrivers] = useState([]);
  const [range, setRange] = useState('upcoming');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showDrivers, setShowDrivers] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/itineraries', { params: { range, search } });
      setData(d);
    } catch (e) { setError(e.response?.data?.error || 'Could not load itineraries.'); }
    setLoading(false);
  }, [range, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/itineraries/drivers').then(({ data: d }) => setDrivers(d)).catch(() => setDrivers([])); }, [showDrivers]);

  const counts = data.counts || {};

  return (
    <div>
      <div className="page-header">
        <h1>Itinerary</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/item-deliveries">Item Delivery</Link>
          {can('/itineraries', 'can_edit') && (
            <button className="btn btn-sm" onClick={() => setShowDrivers(true)}>Manage Drivers</button>
          )}
          {can('/itineraries', 'can_add') && (
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>New Itinerary</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* The forecast, as three numbers rather than three reports. Doubles as the range filter,
          so "what is going out this week" is one click from the answer. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[['today', 'Today', counts.today], ['week', 'This Week', counts.this_week], ['month', 'This Month', counts.this_month]].map(([key, label, n]) => (
          <button key={key} type="button" onClick={() => setRange(key)}
            style={{
              textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 10, color: 'inherit',
              border: range === key ? '2px solid var(--primary, #4f46e5)' : '1px solid var(--border, #e2e8f0)',
              background: 'transparent',
            }}>
            <div className="muted" style={{ fontSize: 12 }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{Number(n || 0)}</div>
            <div className="muted" style={{ fontSize: 12 }}>{Number(n || 0) === 1 ? 'run' : 'runs'}</div>
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0, flex: '1 1 240px' }}>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Run number or driver" />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {RANGES.map((r) => (
              <button key={r.key} className={`btn btn-sm ${range === r.key ? 'btn-primary' : ''}`}
                onClick={() => setRange(r.key)}>{r.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Run #</th><th>Date</th><th>Driver</th><th>Plate</th>
                  <th>Stops</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No itineraries in this window.
                  </td></tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Run #"><Link to={`/itineraries/${r.id}`}>{r.itinerary_no}</Link></td>
                    <td data-label="Date">{fmtDate(r.itinerary_date)}</td>
                    <td data-label="Driver">{r.driver_name || <span className="muted">Not assigned</span>}</td>
                    <td data-label="Plate">{r.plate_no || '—'}</td>
                    <td data-label="Stops">
                      {Number(r.delivered_count)} / {Number(r.stop_count)}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{r.status}</span>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-primary" onClick={() => navigate(`/itineraries/${r.id}`)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNew && (
        <NewRunModal drivers={drivers} onClose={() => setShowNew(false)}
          onSaved={(d) => { setShowNew(false); navigate(`/itineraries/${d.id}`); }} />
      )}
      {showDrivers && (
        <DriversModal onClose={() => setShowDrivers(false)}
          canEdit={can('/itineraries', 'can_edit')} canDelete={can('/itineraries', 'can_delete')} />
      )}
    </div>
  );
}
