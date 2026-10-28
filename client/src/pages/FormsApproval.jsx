import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import SearchInput from '../components/SearchInput';
import { NO_ITEM_TYPES, STATUS_BADGE, TYPE_LABELS, fmtDate, money, pretty, statusLabel } from '../utils/requestForms';

// The approval queue -- what is waiting on a decision, rather than what you filed.
//
// Drafts never appear: a form nobody has submitted is its owner's business alone. Submitted opens
// first because it is where a form waits longest -- on its department head. Approved and Rejected
// are there to look back at, not to work through.
const TABS = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'noted', label: 'Noted' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

export default function FormsApproval() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [tab, setTab] = useState('submitted');
  const [type, setType] = useState('');
  // Search and Department (asked 2026-10-27) filter the loaded tab in place -- the queue is one
  // short list per tab, so there is nothing to page through on the server.
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/forms/approval/queue', {
        params: { status: tab, type: type || undefined },
      });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the approval queue.'); }
    setLoading(false);
  }, [tab, type]);

  useEffect(() => { load(); }, [load]);

  const departments = useMemo(
    () => [...new Set(rows.map((r) => r.department).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (!department || r.department === department)
      && (!q || [r.request_no, r.owner_name, r.department, TYPE_LABELS[r.type] || pretty(r.type)]
        .some((v) => String(v || '').toLowerCase().includes(q))));
  }, [rows, search, department]);

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
          <div className="field">
            <label>Department</label>
            <select value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">--ALL--</option>
              {department && !departments.includes(department) && <option value={department}>{department}</option>}
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Search</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="REQ #, name or department..." />
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
                {shown.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    {rows.length ? 'Nothing matches.' : 'Nothing here.'}
                  </td></tr>
                )}
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td data-label="REQ #">{r.request_no}</td>
                    <td data-label="Form">{TYPE_LABELS[r.type] || pretty(r.type)}</td>
                    <td data-label="Filed By">{r.owner_name || '—'}</td>
                    <td data-label="Department">{r.department || '—'}</td>
                    <td data-label="Submitted">{fmtDate(r.submitted_at)}</td>
                    <td data-label="Amount">{NO_ITEM_TYPES.includes(r.type) ? '—' : money(r.total_amount)}</td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{r.status === 'noted' && Number(r.waiting_pre_approval) ? 'For Pre-Approval' : statusLabel(r.status)}</span>
                    </td>
                    <td>
                      <Link className="btn btn-sm btn-primary" to={`/forms/${r.id}`}>Review</Link>
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
