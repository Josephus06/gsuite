import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import Pagination from '../components/Pagination';
import { useAuth } from '../context/useAuth';
import { STATUS_BADGE, TYPE_LABELS, fmtDate, money, pretty } from '../utils/requestForms';
import useAutoSearch from '../utils/useAutoSearch';

// Forms -- the request forms ported from the Booking system. Four company forms, one approval
// chain. This is the filer's own list: your forms, or everyone's if you hold Can View All.
//
// The approval queue is a separate page (/forms/approval) because it answers a different
// question -- "what is waiting on me" rather than "what did I file".
const PAGE_SIZE = 10;

export default function Forms() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/forms', {
        params: { status: status || undefined, type: type || undefined, search: search || undefined },
      });
      setRows(data);
      setPage(1);
    } catch (e) { setError(e.response?.data?.error || 'Could not load forms.'); }
    setLoading(false);
  }, [status, type, search]);

  useEffect(() => { load(); }, [status, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useAutoSearch(search, load);
  return (
    <div>
      <div className="page-header">
        <h1>Forms</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {can('/forms/approval', 'can_view') && (
            <Link className="btn btn-sm" to="/forms/approval">Approval Queue</Link>
          )}
          {can('/forms', 'can_add') && (
            <Link className="btn btn-primary" to="/forms/new">Fill Out a Form</Link>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder="REQ #, name or department..."
            />
          </div>
          <div className="field">
            <label>Form</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">--ALL--</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="noted">Noted</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={load}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>REQ #</th>
                  <th>Form</th>
                  <th>Date Created</th>
                  <th>Filed By</th>
                  <th>Department</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No forms yet. {can('/forms', 'can_add') ? 'Fill one out to get started.' : ''}
                  </td></tr>
                )}
                {pageRows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="REQ #">{r.request_no}</td>
                    <td data-label="Form">{TYPE_LABELS[r.type] || pretty(r.type)}</td>
                    <td data-label="Date Created">{fmtDate(r.created_at)}</td>
                    <td data-label="Filed By">{r.owner_name || '—'}</td>
                    <td data-label="Department">{r.department || '—'}</td>
                    {/* A business trip has no lines, so it has no amount -- a 0.00 there would
                        read as "this trip cost nothing" rather than "this form is not about money". */}
                    <td data-label="Amount">{r.type === 'business_trip' ? '—' : money(r.total_amount)}</td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{pretty(r.status)}</span>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-primary" onClick={() => navigate(`/forms/${r.id}`)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
