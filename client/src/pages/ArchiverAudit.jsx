import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { ACCESS_ACTION_LABELS, ACCESS_OUTCOME_LABELS, formatDateTime } from '../utils/archiverLabels';

const PAGE_SIZE = 50;

// The vault-wide log. System Admin only, because it names every entry and everyone who has opened
// one -- more than any individual share is meant to reveal.
//
// The rows worth looking for are the failures: a run of wrong codes against one entry is what an
// attempt to open someone else's credential looks like from here.
export default function ArchiverAudit() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ action: '', outcome: '' });
  const [applied, setApplied] = useState({ action: '', outcome: '' });

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const params = { page, page_size: PAGE_SIZE };
    for (const [k, v] of Object.entries(applied)) if (v) params[k] = v;
    try {
      const { data } = await api.get('/archiver/audit/all', { params });
      setRows(data.rows); setTotal(data.total);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the audit log.'); }
    setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const failures = rows.filter((r) => r.outcome !== 'success').length;

  return (
    <div>
      <div className="page-header">
        <h1>Archiver Audit Log</h1>
        <Link className="btn btn-sm" to="/archiver">Back to Archiver</Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Action</label>
            <select value={filters.action} onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}>
              <option value="">--ALL--</option>
              {Object.entries(ACCESS_ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Outcome</label>
            <select value={filters.outcome} onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}>
              <option value="">--ALL--</option>
              {Object.entries(ACCESS_OUTCOME_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => { setPage(1); setApplied(filters); }}>Search</button>
          <button className="btn btn-sm" onClick={() => { const n = { action: '', outcome: 'failed' }; setFilters(n); setPage(1); setApplied(n); }}>
            Failed attempts only
          </button>
        </div>
        {failures > 0 && applied.outcome !== 'failed' && (
          <p className="muted" style={{ marginTop: 10, marginBottom: 0, color: '#b45309' }}>
            {failures} of the {rows.length} entries on this page did not succeed.
          </p>
        )}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>When</th><th>Who</th><th>Entry</th><th>Action</th><th>Outcome</th><th>Detail</th><th>IP</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing recorded yet.</td></tr>}
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td data-label="When">{formatDateTime(l.created_at)}</td>
                    <td data-label="Who">{l.user_name || '—'}</td>
                    <td data-label="Entry">
                      {l.entry_id
                        ? <Link className="link-btn" to={`/archiver/${l.entry_id}`}>{l.entry_no || l.entry_id}</Link>
                        : <span className="muted">{l.detail?.split(' ')[0] || 'deleted'}</span>}
                      {l.title && <div className="muted" style={{ fontSize: 11 }}>{l.title}</div>}
                    </td>
                    <td data-label="Action">{ACCESS_ACTION_LABELS[l.action] || l.action}</td>
                    <td data-label="Outcome" style={{ color: l.outcome !== 'success' ? '#b91c1c' : undefined, fontWeight: l.outcome !== 'success' ? 600 : undefined }}>
                      {ACCESS_OUTCOME_LABELS[l.outcome] || l.outcome}
                    </td>
                    <td data-label="Detail">{l.detail || '—'}</td>
                    <td data-label="IP" style={{ fontFamily: 'monospace', fontSize: 11 }}>{l.ip_address || '—'}</td>
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
