import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { STATUS_LABELS } from '../utils/assetLabels';

const TYPES_PER_PAGE = 10;
const ROWS_PER_PAGE = 15;

// The asset register, shown the way the equipment is actually described -- the type on top, its
// reference numbers underneath:
//
//   UPS
//     Ref 023123   Warehouse - Central   Juan Dela Cruz
//     Ref 123124   Admin Office          Maria Santos
//
// Location and custodian are the EFFECTIVE ones. A unit attached to another (a UPS plugged into
// "PC 1") shows where its host is, with the host named beside it, because that is the answer the
// audit team needs -- not the location column that unit happens to carry.
export default function Assets() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [view, setView] = useState('grouped');
  const [groups, setGroups] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const [filters, setFilters] = useState({ search: '', status: '', location_id: '', custodian_employee_id: '', category: '', attached: '' });
  const [applied, setApplied] = useState({ search: '', status: '', location_id: '', custodian_employee_id: '', category: '', attached: '' });

  useEffect(() => { api.get('/assets/meta').then(({ data }) => setMeta(data)).catch(() => setMeta({ locations: [], employees: [], categories: [], items: [] })); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const params = { page, page_size: view === 'grouped' ? TYPES_PER_PAGE : ROWS_PER_PAGE };
    for (const [k, v] of Object.entries(applied)) if (v) params[k] = v;
    try {
      if (view === 'grouped') {
        const { data } = await api.get('/assets/tree', { params });
        setGroups(data.groups); setTotal(data.total);
      } else {
        const { data } = await api.get('/assets', { params });
        setRows(data.rows); setTotal(data.total);
      }
    } catch (e) { setError(e.response?.data?.error || 'Failed to load the register.'); }
    setLoading(false);
  }, [page, applied, view]);

  useEffect(() => { load(); }, [load]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  function runSearch() { setPage(1); setApplied(filters); }
  function switchView(next) { setView(next); setPage(1); }

  const totalPages = Math.max(1, Math.ceil(total / (view === 'grouped' ? TYPES_PER_PAGE : ROWS_PER_PAGE)));

  function unitRow(u) {
    return (
      <tr key={u.id}>
        <td data-label="Reference No">
          <button type="button" className="link-btn" onClick={() => navigate(`/assets/${u.id}`)}>{u.reference_no}</button>
        </td>
        <td data-label="Serial">{u.serial_no || '—'}</td>
        <td data-label="Location">{u.location_name || <span className="muted">Unassigned</span>}</td>
        <td data-label="Custodian">{u.custodian_name?.trim() || '—'}</td>
        <td data-label="Assigned Location">{u.assigned_location_name || '—'}</td>
        <td data-label="Attached To">
          {u.parent_asset_id
            ? <span title="This unit is wherever its host asset is">{u.parent_item_name} · {u.parent_reference_no}</span>
            : '—'}
        </td>
        <td data-label="Status">{STATUS_LABELS[u.status] || u.status}</td>
      </tr>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Assets</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {can('/asset-items', 'can_view') && <Link className="btn btn-sm" to="/asset-items">Asset Types</Link>}
          {can('/asset-transfers', 'can_view') && <Link className="btn btn-sm" to="/asset-transfers">Transfers</Link>}
          {can('/assets', 'can_add') && <Link className="btn btn-primary" to="/assets/new">Add New</Link>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={filters.search} onChange={(e) => setF({ search: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Reference no, serial, type..." />
          </div>
          <div className="field">
            <label>Location</label>
            <select value={filters.location_id} onChange={(e) => setF({ location_id: e.target.value })}>
              <option value="">--ALL--</option>
              {(meta?.locations || []).map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Custodian</label>
            <select value={filters.custodian_employee_id} onChange={(e) => setF({ custodian_employee_id: e.target.value })}>
              <option value="">--ALL--</option>
              {(meta?.employees || []).map((e2) => <option key={e2.id} value={e2.id}>{e2.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Category</label>
            <select value={filters.category} onChange={(e) => setF({ category: e.target.value })}>
              <option value="">--ALL--</option>
              {(meta?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Attachment</label>
            <select value={filters.attached} onChange={(e) => setF({ attached: e.target.value })}>
              <option value="">--ALL--</option>
              <option value="no">Standalone only</option>
              <option value="yes">Attached only</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={runSearch}>Search</button>
          <div className="status-tabs" style={{ marginLeft: 'auto' }}>
            <button className={`status-tab ${view === 'grouped' ? 'active' : ''}`} onClick={() => switchView('grouped')}>Grouped by Type</button>
            <button className={`status-tab ${view === 'flat' ? 'active' : ''}`} onClick={() => switchView('flat')}>Flat List</button>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : view === 'grouped' ? (
          <>
            {groups.length === 0 && <p className="muted" style={{ textAlign: 'center', padding: 20 }}>No assets found.</p>}
            {groups.map((g) => (
              <div key={g.id} style={{ marginBottom: 18 }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '2px solid var(--border, #e2e8f0)', cursor: 'pointer' }}
                  onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}
                >
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{collapsed[g.id] ? '▶' : '▼'}</span>
                  <strong style={{ fontSize: 15 }}>{g.display_name}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {g.item_code}{g.brand ? ` · ${g.brand}` : ''}{g.model ? ` ${g.model}` : ''}{g.category ? ` · ${g.category}` : ''}
                  </span>
                  <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{g.unit_count} unit{Number(g.unit_count) === 1 ? '' : 's'}</span>
                </div>
                {!collapsed[g.id] && (
                  <div className="table-wrap">
                    <table className="responsive-cards">
                      <thead>
                        <tr><th>Reference No</th><th>Serial</th><th>Location</th><th>Assigned Location</th><th>Custodian</th><th>Attached To</th><th>Status</th></tr>
                      </thead>
                      <tbody>{(g.units || []).map(unitRow)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </>
        ) : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Reference No</th><th>Asset Type</th><th>Serial</th><th>Location</th><th>Custodian</th><th>Attached To</th><th>Status</th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No assets found.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Reference No"><button type="button" className="link-btn" onClick={() => navigate(`/assets/${r.id}`)}>{r.reference_no}</button></td>
                    <td data-label="Asset Type">{r.item_name}</td>
                    <td data-label="Serial">{r.serial_no || '—'}</td>
                    <td data-label="Location">{r.location_name || <span className="muted">Unassigned</span>}</td>
                    <td data-label="Custodian">{r.custodian_name?.trim() || '—'}</td>
                    <td data-label="Attached To">{r.parent_asset_id ? `${r.parent_item_name} · ${r.parent_reference_no}` : '—'}</td>
                    <td data-label="Status">{STATUS_LABELS[r.status] || r.status}</td>
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
