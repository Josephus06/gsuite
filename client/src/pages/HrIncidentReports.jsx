import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

const SEVERITY_BADGE = { minor: 'badge-muted', major: 'badge-warning', grave: 'badge-danger' };
const STATUS_BADGE = {
  for_evaluation: 'badge-warning',
  under_review: 'badge-info',
  substantiated: 'badge-danger',
  unsubstantiated: 'badge-success',
  dismissed: 'badge-muted',
};
const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'for_evaluation', label: 'For Evaluation' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'substantiated', label: 'Substantiated' },
  { key: 'unsubstantiated', label: 'Unsubstantiated' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
];

function fmtDate(v) { return v ? String(v).slice(0, 10) : ''; }
const pretty = (s) => (s ? String(s).replace(/_/g, ' ') : '');

export default function HrIncidentReports() {
  const navigate = useNavigate();
  const [data, setData] = useState({ rows: [], counts: {} });
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/hr-incident-reports', {
        params: { status, search: search || undefined },
      });
      setData(d);
    } catch (e) { setError(e.response?.data?.error || 'Could not load incident reports.'); }
    setLoading(false);
  }, [status, search]);

  useEffect(() => { load(); }, [load]);
  const counts = data.counts || {};

  return (
    <div>
      <div className="page-header">
        <h1>Incident Report</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/hrd">Files</Link>
          <Link className="btn btn-sm" to="/hrd/violations">Violations</Link>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* The queue at a glance. What is waiting is the number that matters -- a report nobody has
          picked up is an employee waiting to hear what happens to them. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[['for_evaluation', 'For Evaluation', counts.for_evaluation],
          ['under_review', 'Under Review', counts.under_review],
          ['all', 'Closed', counts.closed]].map(([key, label, n]) => (
            <button key={key} type="button" onClick={() => setStatus(key)}
              style={{
                textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 10, color: 'inherit',
                border: status === key ? '2px solid var(--accent, #4f46e5)' : '1px solid var(--border, #e2e8f0)',
                background: 'transparent',
              }}>
              <div className="muted" style={{ fontSize: 12 }}>{label}</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{Number(n || 0)}</div>
            </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0, flex: '1 1 260px' }}>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Employee, violation, IR or VIO number" />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <button key={f.key} className={`btn btn-sm ${status === f.key ? 'btn-primary' : ''}`}
                onClick={() => setStatus(f.key)}>{f.label}</button>
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
                  <th>IR #</th><th>Date</th><th>Employee</th><th>Department</th>
                  <th>Violation</th><th>Severity</th><th>Status</th><th>Recommendation</th><th />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing in this view.
                  </td></tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="IR #">
                      <strong>{r.incident_no}</strong>
                      <div className="muted" style={{ fontSize: 11 }}>{r.violation_no}</div>
                    </td>
                    <td data-label="Date">{fmtDate(r.violation_date)}</td>
                    <td data-label="Employee">
                      <strong>{r.employee_name}</strong>
                      {r.employee_code && <div className="muted" style={{ fontSize: 11 }}>{r.employee_code}</div>}
                    </td>
                    <td data-label="Department">{r.department_name || '—'}</td>
                    <td data-label="Violation">{r.violation_name}</td>
                    <td data-label="Severity">
                      <span className={`badge ${SEVERITY_BADGE[r.violation_severity] || 'badge-muted'}`}>
                        {r.violation_severity}
                      </span>
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{pretty(r.status)}</span>
                    </td>
                    <td data-label="Recommendation">{pretty(r.recommendation) || '—'}</td>
                    <td>
                      <button className="btn btn-sm btn-primary"
                        onClick={() => navigate(`/hrd/incident-reports/${r.id}`)}>Evaluate</button>
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
