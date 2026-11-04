import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { MaterialsTab, InkTab } from '../components/ProcessInkTabs';
import { displayDateTime } from '../utils/dates';

// Master Lists > Lookups > Processes > a process (2026-11-04): the header, and the source's Materials
// and Ink tabs with the Ink Calculation. Edited on /processes/:id/edit.
export default function ProcessView() {
  const { id } = useParams();
  const { can } = useAuth();
  const [p, setP] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('materials');

  useEffect(() => {
    api.get(`/processes/${id}`)
      .then(({ data }) => { setP(data); if (!data.materials.length && data.inks.length) setTab('inks'); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the process.'));
  }, [id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!p) return <LoadingSpinner />;
  const row = (label, value) => <div><span className="muted">{label} : </span>{value || ''}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Process</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/lookups?tab=processes">Back</Link>
          {can('/lookups', 'can_edit') && <Link className="btn btn-sm btn-primary" to={`/processes/${id}/edit`}>Edit</Link>}
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 6 }}>
        {row('Process Code', p.process_code)}
        {row('Process Name', p.process_name)}
        {row('Default Location', p.default_location_name)}
        {row('UOM', p.base_unit_title || p.base_unit_code)}
        {row('Minutes per Unit', p.minutes_per_unit != null ? Number(p.minutes_per_unit) : '')}
        {row('Active', p.is_active ? 'Yes' : 'No')}
      </div>

      <div className="status-tabs" style={{ marginTop: 16 }}>
        <button type="button" className={`status-tab ${tab === 'materials' ? 'active' : ''}`} onClick={() => setTab('materials')}>Materials</button>
        <button type="button" className={`status-tab ${tab === 'inks' ? 'active' : ''}`} onClick={() => setTab('inks')}>Inks</button>
        <button type="button" className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Information</button>
      </div>

      {tab === 'materials' && <MaterialsTab materials={p.materials} />}
      {tab === 'inks' && <InkTab process={p} inks={p.inks} />}
      {tab === 'system' && (
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          {row('Created', p.created_at ? displayDateTime(p.created_at) : '')}
          {row('Last Updated', p.updated_at ? displayDateTime(p.updated_at) : '')}
        </div>
      )}
    </div>
  );
}
