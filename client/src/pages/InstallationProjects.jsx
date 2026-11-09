import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import { API, BlobImage, ProgressBar, STATUS_LABEL, StatusBadge, errorOf } from './installation/common';

// Production > Installation Planner > Projects -- PLANNER's projects list: picture, name, timeline,
// status, progress, and View / Edit / Delete.
export default function InstallationProjects() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const due = params.get('due') === '1';
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [rights, setRights] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => { api.get(`${API}/meta`).then(({ data }) => setRights(data.rights)).catch(() => {}); }, []);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      api.get(`${API}/projects`, { params: { status: status || undefined, due: due ? 1 : undefined, search: search || undefined } })
        .then(({ data }) => { setRows(data); setError(''); })
        .catch((err) => setError(errorOf(err)))
        .finally(() => setLoading(false));
    }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, due, search, reload]);

  function setFilter(next) {
    const p = new URLSearchParams();
    if (next.status) p.set('status', next.status);
    if (next.due) p.set('due', '1');
    setParams(p, { replace: true });
  }

  async function remove(p) {
    if (!window.confirm(`Delete project ${p.project_no} "${p.title}"? Its checklist, BOM, files and updates go with it.`)) return;
    try { await api.delete(`${API}/projects/${p.id}`); setReload((n) => n + 1); } catch (err) { setError(errorOf(err)); }
  }

  return (
    <div className="page">
      <div className="page-header" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1>Installation Projects</h1>
          <div className="muted">Project management overview</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/installation-planner">Planner calendar</Link>
          {rights.can_add && <Link className="btn btn-primary" to="/installation-planner/projects/new">+ New Project</Link>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="search" placeholder="Search project #, title, JO #, customer..." value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ flex: '1 1 260px', maxWidth: 380 }} />
        <select value={due ? 'due' : status} onChange={(e) => setFilter(e.target.value === 'due' ? { due: true } : { status: e.target.value })}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          <option value="due">Due (end date today or past)</option>
        </select>
        <span className="muted" style={{ fontSize: 12 }}>{rows.length} project(s)</span>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : rows.length === 0 ? <div className="empty-state">No projects found.</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 96 }}>Picture</th>
                  <th>Project</th>
                  <th>Job Order</th>
                  <th>Timeline</th>
                  <th>Status</th>
                  <th style={{ width: 180 }}>Progress</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {Number(p.has_image) ? <BlobImage path={`${API}/projects/${p.id}/files/image`} style={{ width: 80, height: 56 }} />
                        : <span className="muted" style={{ fontSize: 12 }}>No image</span>}
                    </td>
                    <td>
                      <Link to={`/installation-planner/projects/${p.id}`}><strong>{p.title}</strong></Link>
                      <div className="muted" style={{ fontSize: 12 }}>{p.project_no}{p.category_name ? ` · ${p.category_name}` : ''}{p.planner_name ? ` · ${p.planner_name}` : ''}</div>
                    </td>
                    <td>
                      {p.job_order_id ? <Link to={`/job-orders/${p.job_order_id}`}>{p.job_order_no}</Link> : <span className="muted">—</span>}
                      {p.customer_name && <div className="muted" style={{ fontSize: 12 }}>{p.customer_name}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {p.date_from ? <>{displayDate(p.date_from)}<br />to {displayDate(p.date_to || p.date_from)}</> : <span className="muted">No schedule</span>}
                    </td>
                    <td><StatusBadge status={p.status} /></td>
                    <td><ProgressBar value={p.progress} height={18} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-sm" onClick={() => navigate(`/installation-planner/projects/${p.id}`)}>View</button>{' '}
                      {rights.can_edit && <button type="button" className="btn btn-sm" onClick={() => navigate(`/installation-planner/projects/${p.id}/edit`)}>Edit</button>}{' '}
                      {rights.can_delete && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(p)}>Delete</button>}
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
