import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import SearchInput from '../components/SearchInput';
import DueCell from '../components/FleetDueCell';
import { vehicleName } from '../utils/fleet';

const km = (v) => (v == null ? '' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })} km`);

// Assets > Fleet (Vehicles) (asked 2026-10-19): every vehicle asset with what is due on it -- PMS,
// registration, insurance, emission -- overdue in red, due within 30 days (or 500 km) in amber.
// routes/fleet.js; the due logic is lib/fleet.js.

export default function Fleet() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/fleet', { params: { status: status || undefined } });
      setRows(data || []);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the fleet.'); }
    setLoading(false);
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const q = search.trim().toLowerCase();
  const shown = !q ? rows : rows.filter((v) => [v.plate_no, v.make, v.model, v.brand, v.asset_model, v.reference_no, v.custodian_name, v.incharge_name, v.driver_name]
    .some((x) => String(x || '').toLowerCase().includes(q)));
  const attention = rows.filter((v) => Object.values(v.due || {}).some((d) => d.status === 'overdue' || d.status === 'due_soon')).length;

  async function download() {
    const res = await api.get('/fleet/export', { params: { search: search.trim() || undefined, status: status || undefined }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = 'fleet.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Fleet (Vehicles)</h1>
        <button className="btn btn-primary" disabled={loading || !shown.length} onClick={download}>Export to Excel</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Plate, make / model, asset ref, custodian..." />
          </div>
          <div className="field">
            <label>Show</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All vehicles</option>
              <option value="attention">Needs attention (overdue or due soon)</option>
              <option value="overdue">Overdue only</option>
            </select>
          </div>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          A vehicle is an asset whose Asset Type has the Category "Vehicle" -- add it under Assets, then open it here to fill in its plate,
          registration, insurance and PMS interval. {attention > 0 && <strong>{attention} vehicle{attention === 1 ? '' : 's'} need attention.</strong>}
        </div>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Plate No</th><th>Vehicle</th><th>Custodian</th><th>In-charge</th><th style={{ textAlign: 'right' }}>Odometer</th>
                  <th>Last PMS</th><th>Next PMS</th><th>Registration</th><th>Insurance</th><th>Emission</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No vehicles{q || status ? ' match' : ' yet -- add one under Assets with an Asset Type whose Category is Vehicle'}.
                  </td></tr>
                )}
                {shown.map((v) => (
                  <tr key={v.asset_id} className="is-clickable" onClick={() => navigate(`/assets/fleet/${v.asset_id}`)}>
                    <td><Link className="link-btn" to={`/assets/fleet/${v.asset_id}`} onClick={(e) => e.stopPropagation()}>{v.plate_no || '(no plate)'}</Link></td>
                    <td>{vehicleName(v)}<div className="muted">{v.reference_no}</div></td>
                    <td>{v.custodian_name || '—'}</td>
                    <td>{v.incharge_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{km(v.current_odometer_km) || '—'}</td>
                    <td>{v.last_pms_date || '—'}{v.last_pms_km != null && <div className="muted">{km(v.last_pms_km)}</div>}</td>
                    <DueCell d={v.due?.pms}>
                      {[v.next_pms_date, v.next_pms_km != null ? km(v.next_pms_km) : null].filter(Boolean).join(' / ')}
                    </DueCell>
                    <DueCell d={v.due?.registration}>{v.registration_expiry}</DueCell>
                    <DueCell d={v.due?.insurance}>{v.insurance_expiry}</DueCell>
                    <DueCell d={v.due?.emission}>{v.emission_expiry}</DueCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
