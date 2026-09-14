import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { STATUS_BADGE, TYPE_LABELS, fmtDate, money, pretty } from '../utils/requestForms';

// The approval queue -- what is waiting on a decision, rather than what you filed.
//
// Drafts never appear: a form nobody has submitted is its owner's business alone. The default view
// is what still needs someone (submitted and noted); Approved and Rejected are there to look back
// at, not to work through.
const TABS = [
  { key: 'open', label: 'Needs a Decision' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'noted', label: 'Noted' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

export default function FormsApproval() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [tab, setTab] = useState('open');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/forms/approval/queue', {
        params: { status: tab === 'open' ? undefined : tab, type: type || undefined },
      });
      // "Needs a decision" is the two live statuses. Filtered here rather than with another query
      // parameter, since the queue endpoint already returns exactly the four workflow statuses.
      setRows(tab === 'open' ? data.filter((r) => ['submitted', 'noted'].includes(r.status)) : data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the approval queue.'); }
    setLoading(false);
  }, [tab, type]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="page-header">
        <h1>Forms Approval</h1>
        <Link className="btn btn-sm" to="/forms">My Forms</Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="status-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`status-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Form</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">--ALL--</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>REQ #</th>
                  <th>Form</th>
                  <th>Filed By</th>
                  <th>Department</th>
                  <th>Submitted</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing here.
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="REQ #">{r.request_no}</td>
                    <td data-label="Form">{TYPE_LABELS[r.type] || pretty(r.type)}</td>
                    <td data-label="Filed By">{r.owner_name || '—'}</td>
                    <td data-label="Department">{r.department || '—'}</td>
                    <td data-label="Submitted">{fmtDate(r.submitted_at)}</td>
                    <td data-label="Amount">{r.type === 'business_trip' ? '—' : money(r.total_amount)}</td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{pretty(r.status)}</span>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-primary" onClick={() => navigate(`/forms/${r.id}`)}>Review</button>
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
