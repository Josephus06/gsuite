import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { STATUS_BADGE, fmtScore } from './perfUtils';

// Forms > My Performance (2026-10-23; routes/performance.js): your quarterly evaluations -- log your
// accomplishments while the quarter runs, rate yourself when it closes, sign conforme after the
// discussion. Supervisors see the people they rate; department heads the reviews waiting on them.
export default function MyPerformance() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('mine');
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/performance/inbox').then(({ data: d }) => {
      setData(d);
      if (!d.mine.length && d.team.length) setTab('team');
    }).catch((e) => setError(e.response?.data?.error || 'Could not load.'));
  }, []);
  if (!data) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const tabs = [['mine', 'My Evaluations', data.mine]];
  if (data.team.length) tabs.push(['team', 'My Team', data.team]);
  if (data.head.length) tabs.push(['head', 'Department Review', data.head]);
  const rows = (tabs.find((t) => t[0] === tab) || tabs[0])[2];
  const waiting = (k, list) => list.filter((r) => (k === 'team' ? ['open', 'supervisor_rating'].includes(r.status) : k === 'head' ? r.status === 'dept_head_review' : ['open', 'self_rating', 'discussion'].includes(r.status))).length;
  return (
    <div>
      <div className="page-header"><h1>My Performance</h1></div>
      <div className="status-tabs" style={{ marginBottom: 12 }}>
        {tabs.map(([k, label, list]) => (
          <button key={k} type="button" className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label} {waiting(k, list) > 0 && <span className="badge badge-warning" style={{ marginLeft: 4 }}>{waiting(k, list)}</span>}
          </button>
        ))}
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Quarter</th>{tab !== 'mine' && <th>Employee</th>}<th>Position</th><th>Rater</th><th>Status</th><th>Remarks</th><th style={{ textAlign: 'right' }}>Self</th><th style={{ textAlign: 'right' }}>Superior</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No evaluations yet. HR opens each quarter.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Quarter" style={{ fontWeight: 600 }}>Q{r.quarter} {r.year}</td>
                  {tab !== 'mine' && <td data-label="Employee">{r.employee_name}</td>}
                  <td data-label="Position">{r.position_title}</td>
                  <td data-label="Rater">{r.rater_name || '—'}</td>
                  <td data-label="Status"><span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{data.status_labels[r.status]}</span></td>
                  <td data-label="Remarks">{r.remarks}</td>
                  <td data-label="Self" style={{ textAlign: 'right' }}>{fmtScore(r.self_overall)}</td>
                  <td data-label="Superior" style={{ textAlign: 'right' }}>{tab === 'mine' && ['open', 'self_rating', 'supervisor_rating'].includes(r.status) ? '—' : fmtScore(r.sup_overall)}</td>
                  <td><Link className="btn btn-sm btn-primary" to={`/performance/${r.id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
