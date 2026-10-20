import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/useAuth';
import { fmtDate } from '../utils/requestForms';
import { parseUtc } from '../utils/datetime';

// HRD > OBT (asked 2026-10-20; routes/obt.js): every APPROVED Official Business Trip (Forms > Business
// Trip) for HR, each with Confirm. View on /hrd/obt lists them; Update confirms.
const TABS = [['pending', 'For Confirmation'], ['confirmed', 'Confirmed'], ['all', 'All']];
const clock = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const phDateTime = (v) => (v ? parseUtc(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');

export default function Obt() {
  const { can } = useAuth();
  const mayConfirm = can('/hrd/obt', 'can_update'); // Update on OBT confirms (2026-10-20)
  const [tab, setTab] = useState('pending');
  const [q, setQ] = useState('');
  const [data, setData] = useState({ rows: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/obt', { params: { status: tab, q: q.trim() || undefined } })
      .then(({ data: d }) => { setData(d); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the OBT list.'))
      .finally(() => setLoading(false));
  }, [tab, q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function confirm(r) {
    if (!window.confirm(`Confirm ${r.request_no} -- ${r.name || r.filed_by}'s trip on ${fmtDate(r.trip_date)}?`)) return;
    setBusy(r.id); setError('');
    try { await api.post(`/obt/${r.id}/confirm`); load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not confirm.'); }
    finally { setBusy(null); }
  }

  // Back in Office (2026-10-20): after confirmation, the click fills the trip's Time In with now.
  async function returned(r) {
    if (!window.confirm(`${r.name || r.filed_by} is back in the office? This fills ${r.request_no}'s Time In with the time now.`)) return;
    setBusy(r.id); setError('');
    try { await api.post(`/obt/${r.id}/returned`); load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not record the return.'); }
    finally { setBusy(null); }
  }

  return (
    <div>
      <div className="page-header"><h1>OBT <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>Official Business Trips</span></h1></div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field" style={{ maxWidth: 420, marginBottom: 0 }}>
          <label>Search</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Request #, name, purpose, driver, plate no." />
        </div>
      </div>
      <div className="status-tabs" style={{ marginBottom: 12 }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label} <span className="badge badge-muted" style={{ marginLeft: 4 }}>{data.counts?.[k] ?? 0}</span>
          </button>
        ))}
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Request #</th><th>Name</th><th>Department</th><th>Trip Date</th><th>Time Out</th><th>Time In</th>
                  <th>Driver</th><th>Vehicle</th><th>Purpose</th><th>Approved</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    {tab === 'pending' ? 'No approved trips waiting for confirmation.' : 'No trips.'}
                  </td></tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Request #">{r.request_no}</td>
                    <td data-label="Name">{r.name || r.filed_by}</td>
                    <td data-label="Department">{r.department || '—'}</td>
                    <td data-label="Trip Date">{fmtDate(r.trip_date)}</td>
                    <td data-label="Time Out">{clock(r.time_out)}</td>
                    <td data-label="Time In">
                      {clock(r.time_in)}
                      {r.obt_returned_at && <div className="muted" style={{ fontSize: 11 }} title={`Back in office ${phDateTime(r.obt_returned_at)}`}>back · {r.returned_by_name}</div>}
                    </td>
                    <td data-label="Driver">{r.driver_name || '—'}</td>
                    <td data-label="Vehicle">{r.vehicle_plate_no || '—'}</td>
                    <td data-label="Purpose" style={{ maxWidth: 280, whiteSpace: 'normal' }}>{r.purpose}</td>
                    <td data-label="Approved">{fmtDate(r.approved_at)}{r.approved_by_name ? <div className="muted" style={{ fontSize: 11 }}>{r.approved_by_name}</div> : null}</td>
                    <td data-label="Status">
                      {r.obt_confirmed_at
                        ? <span className="badge badge-success" title={`${r.confirmed_by_name || ''} · ${phDateTime(r.obt_confirmed_at)}`}>Confirmed</span>
                        : <span className="badge badge-warning">For Confirmation</span>}
                      {r.obt_confirmed_at && <div className="muted" style={{ fontSize: 11 }}>{r.confirmed_by_name} · {phDateTime(r.obt_confirmed_at)}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link className="btn btn-sm" to={`/forms/${r.id}`}>View</Link>{' '}
                      {mayConfirm && r.obt_confirmed_at && !r.obt_returned_at && (
                        <button type="button" className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => returned(r)}
                          title="Fills Time In with the time now">
                          {busy === r.id ? 'Saving…' : 'Back in Office'}
                        </button>
                      )}
                      {mayConfirm && !r.obt_confirmed_at && (
                        <button type="button" className="btn btn-sm btn-success" disabled={busy === r.id} onClick={() => confirm(r)}>
                          {busy === r.id ? 'Confirming…' : 'Confirm'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
