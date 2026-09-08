import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { FILE_STATUS_LABELS, formatBytes, formatDate } from '../utils/archiverLabels';

const PAGE_SIZE = 20;

// Archiver > Files: the documents the company has to be able to produce years later.
export default function ArchiverFiles() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ search: '', folder_id: '', status: '', expiring: '' });
  const [applied, setApplied] = useState({ search: '', folder_id: '', status: '', expiring: '' });

  useEffect(() => { api.get('/archiver/files/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    for (const [k, v] of Object.entries(applied)) if (v) params[k] = v;
    const { data } = await api.get('/archiver/files', { params });
    setRows(data.rows); setTotal(data.total); setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  function runSearch(overrides = {}) {
    const next = { ...filters, ...overrides };
    setFilters(next); setPage(1); setApplied(next);
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function expiryCell(r) {
    if (!r.expires_on) return '—';
    const days = Math.ceil((new Date(`${String(r.expires_on).slice(0, 10)}T00:00:00`) - new Date()) / 86400000);
    return (
      <span style={{ color: days < 0 ? '#b91c1c' : days <= 30 ? '#b45309' : undefined }}>
        {formatDate(r.expires_on)}
        {days < 0 ? ` · expired` : days <= 30 ? ` · in ${days}d` : ''}
      </span>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Files</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/archiver/credentials">Credentials</Link>
          {can('/archiver/files', 'can_add') && <Link className="btn btn-primary" to="/archiver/files/new">Upload Document</Link>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={filters.search} onChange={(e) => setF({ search: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Title, description or reference..." />
          </div>
          <div className="field">
            <label>Folder</label>
            <select value={filters.folder_id} onChange={(e) => setF({ folder_id: e.target.value })}>
              <option value="">--ALL--</option>
              {(meta?.folders || []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(FILE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => runSearch()}>Search</button>
          <button className="btn btn-sm" onClick={() => runSearch({ expiring: applied.expiring === 'yes' ? '' : 'yes' })}>
            {applied.expiring === 'yes' ? 'Show all' : 'Expiring in 30 days'}
          </button>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Document</th><th>Folder</th><th>File</th><th>Size</th>
                  <th>Document Date</th><th>Expires</th><th>Ver</th><th>Owner</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No documents. Ones you own, that are shared with you, or marked company-wide appear here.
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Document">
                      <button type="button" className="link-btn" onClick={() => navigate(`/archiver/files/${r.id}`)}>{r.title}</button>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {r.file_no}{r.visibility === 'company' ? ' · company-wide' : ''}
                      </div>
                    </td>
                    <td data-label="Folder">{r.folder_name || '—'}</td>
                    <td data-label="File" style={{ fontSize: 12 }}>{r.file_name || '—'}</td>
                    <td data-label="Size">{formatBytes(r.size_bytes)}</td>
                    <td data-label="Document Date">{formatDate(r.document_date)}</td>
                    <td data-label="Expires">{expiryCell(r)}</td>
                    <td data-label="Ver">v{r.current_version}</td>
                    <td data-label="Owner">{r.owner_name || '—'}</td>
                    <td data-label="Status">{FILE_STATUS_LABELS[r.status] || r.status}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/archiver/files/${r.id}`)}>Open</button></td>
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
