import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { ENTRY_TYPE_LABELS, ARCHIVE_STATUS_LABELS, formatDate } from '../utils/archiverLabels';

const PAGE_SIZE = 20;

// The Archiver: the vault index. Deliberately shows no secrets and no hint of them beyond whether
// one is stored -- opening a credential is a separate, verified act on the entry's own page.
export default function Archiver() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ search: '', category_id: '', entry_type: '', status: '', expiring: '' });
  const [applied, setApplied] = useState({ search: '', category_id: '', entry_type: '', status: '', expiring: '' });

  useEffect(() => { api.get('/archiver/credentials/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    for (const [k, v] of Object.entries(applied)) if (v) params[k] = v;
    const { data } = await api.get('/archiver/credentials', { params });
    setRows(data.rows); setTotal(data.total); setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  function runSearch(overrides = {}) {
    const next = { ...filters, ...overrides };
    setFilters(next); setPage(1); setApplied(next);
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Renewal dates are the reason to open this page when you are not fetching a password.
  function renewalCell(r) {
    const date = r.renews_on || r.expires_on;
    if (!date) return '—';
    const days = Math.ceil((new Date(`${String(date).slice(0, 10)}T00:00:00`) - new Date()) / 86400000);
    const overdue = days < 0;
    const soon = days >= 0 && days <= 30;
    return (
      <span style={{ color: overdue ? '#b91c1c' : soon ? '#b45309' : undefined }}>
        {formatDate(date)}
        {overdue ? ` · ${Math.abs(days)}d overdue` : soon ? ` · in ${days}d` : ''}
      </span>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Archiver</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {can('/archiver/credentials', 'can_approve') && <Link className="btn btn-sm" to="/archiver/credentials/audit">Audit Log</Link>}
          {can('/archiver/credentials', 'can_add') && <Link className="btn btn-primary" to="/archiver/credentials/new">Add Entry</Link>}
        </div>
      </div>

      {meta && !meta.vault_configured && (
        <div className="error-banner">
          <strong>The vault is not configured.</strong> ARCHIVER_KEY is not set on this server, so secrets
          cannot be stored or revealed. Entries can still be recorded without a password. Ask a System
          Administrator to set the key — and it must be the <em>same</em> key on every server sharing this database.
        </div>
      )}
      {meta && meta.vault_configured && !meta.email_configured && (
        <div className="error-banner">
          Email is not configured on this server, so verification codes cannot be sent and no secret can be
          revealed here.
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={filters.search} onChange={(e) => setF({ search: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Title, vendor, username, reference..." />
          </div>
          <div className="field">
            <label>Category</label>
            <select value={filters.category_id} onChange={(e) => setF({ category_id: e.target.value })}>
              <option value="">--ALL--</option>
              {(meta?.categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Type</label>
            <select value={filters.entry_type} onChange={(e) => setF({ entry_type: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(ENTRY_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(ARCHIVE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => runSearch()}>Search</button>
          <button className="btn btn-sm" onClick={() => runSearch({ expiring: applied.expiring === 'yes' ? '' : 'yes' })}>
            {applied.expiring === 'yes' ? 'Show all' : 'Renewing in 30 days'}
          </button>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Entry</th><th>Vendor</th><th>Type</th><th>Category</th><th>Username</th>
                  <th>Secret</th><th>Renews / Expires</th><th>Owner</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing here. Entries you own or that have been shared with you appear in this list.
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Entry">
                      <button type="button" className="link-btn" onClick={() => navigate(`/archiver/credentials/${r.id}`)}>{r.title}</button>
                      <div className="muted" style={{ fontSize: 11 }}>{r.entry_no}</div>
                    </td>
                    <td data-label="Vendor">{r.vendor || '—'}</td>
                    <td data-label="Type">{ENTRY_TYPE_LABELS[r.entry_type] || r.entry_type}</td>
                    <td data-label="Category">{r.category_name || '—'}</td>
                    <td data-label="Username">{r.username || '—'}</td>
                    <td data-label="Secret">{r.has_secret ? '••••••' : <span className="muted">none</span>}</td>
                    <td data-label="Renews / Expires">{renewalCell(r)}</td>
                    <td data-label="Owner">{r.owner_name || '—'}</td>
                    <td data-label="Status">{ARCHIVE_STATUS_LABELS[r.status] || r.status}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/archiver/credentials/${r.id}`)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
          Passwords are never shown in this list. Open an entry and verify by email to reveal one — every reveal is logged.
        </p>
      </div>
    </div>
  );
}
