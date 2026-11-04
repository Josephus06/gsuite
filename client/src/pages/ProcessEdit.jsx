import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { MaterialsTab, InkTab } from '../components/ProcessInkTabs';

// Add / Update Process (2026-11-04), as the source's process_crud: the header, then the Materials and
// Ink tabs with the Ink Calculation. Everything saves together (routes/processes.js).
const EMPTY = {
  process_code: '', process_name: '', base_unit_id: '', default_location_id: '', minutes_per_unit: '', is_active: true,
  ink_media_usage: '', ink_media_weight_wo_print: '', ink_media_weight_w_print: '', ink_weight_full: '', ink_weight_empty: '', ink_volume: '',
  ink_usage_costing: '', ink_price_per_ml_costing: '',
  materials: [], inks: [],
};

export default function ProcessEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState(id ? null : EMPTY);
  const [units, setUnits] = useState([]);
  const [locations, setLocations] = useState([]);
  const [tab, setTab] = useState('materials');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/lookups/units-of-measure').then(({ data }) => setUnits(data)).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(Array.isArray(data) ? data : (data?.rows || []))).catch(() => {});
    if (id) {
      api.get(`/processes/${id}`)
        .then(({ data }) => { setP({ ...data, is_active: !!data.is_active }); if (!data.materials.length && data.inks.length) setTab('inks'); })
        .catch((e) => setError(e.response?.data?.error || 'Could not load the process.'));
    }
  }, [id]);

  if (!p) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const set = (patch) => setP((x) => ({ ...x, ...patch }));

  async function save() {
    setSaving(true); setError('');
    try {
      const { data } = id ? await api.put(`/processes/${id}`, p) : await api.post('/processes', p);
      navigate(`/processes/${data.id}`);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save.');
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{id ? 'Update' : 'Add'} Process</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={id ? `/processes/${id}` : '/lookups?tab=processes'}>Back</Link>
          <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="filter-grid">
          <div className="field"><label>Process Code *</label><input value={p.process_code} onChange={(e) => set({ process_code: e.target.value })} /></div>
          <div className="field"><label>Process Name *</label><input value={p.process_name} onChange={(e) => set({ process_name: e.target.value })} /></div>
          <div className="field">
            <label>Default Location</label>
            <select value={p.default_location_id ?? ''} onChange={(e) => set({ default_location_id: e.target.value })}>
              <option value="">—</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>UOM *</label>
            <select value={p.base_unit_id ?? ''} onChange={(e) => set({ base_unit_id: e.target.value, base_unit_code: units.find((u) => String(u.id) === e.target.value)?.code })}>
              <option value="">—</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.title || u.code}</option>)}
            </select>
          </div>
          <div className="field"><label>Minutes per Unit</label><input type="number" step="any" value={p.minutes_per_unit ?? ''} onChange={(e) => set({ minutes_per_unit: e.target.value })} /></div>
          <div className="field">
            <label>Active</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={!!p.is_active} onChange={(e) => set({ is_active: e.target.checked })} /> Active
            </label>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 16 }}>
        <button type="button" className={`status-tab ${tab === 'materials' ? 'active' : ''}`} onClick={() => setTab('materials')}>Materials</button>
        <button type="button" className={`status-tab ${tab === 'inks' ? 'active' : ''}`} onClick={() => setTab('inks')}>Ink</button>
      </div>
      {tab === 'materials' && <MaterialsTab materials={p.materials} editable onChange={set} />}
      {tab === 'inks' && <InkTab process={p} inks={p.inks} editable onChange={set} />}
    </div>
  );
}
