import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { AUDIT_STATUS_LABELS } from '../utils/assetLabels';

const PAGE_SIZE = 15;

function thisMonth() { return new Date().toISOString().slice(0, 7); }
function formatMonth(v) {
  return v ? new Date(`${String(v).slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
}

// Generating a sheet freezes what the register currently claims onto every line. The preview count
// is shown before generating because a company-wide sheet is thousands of lines, and an auditor
// should know that before they create one, not after.
function NewAuditModal({ meta, onClose, onCreated }) {
  const [form, setForm] = useState({ period_month: thisMonth(), location_id: '', custodian_employee_id: '', include_attached: false, memo: '' });
  const [count, setCount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    const params = {};
    if (form.location_id) params.location_id = form.location_id;
    if (form.custodian_employee_id) params.custodian_employee_id = form.custodian_employee_id;
    if (form.include_attached) params.include_attached = 'yes';
    api.get('/asset-audits/preview-count', { params }).then(({ data }) => setCount(data.count)).catch(() => setCount(null));
  }, [form.location_id, form.custodian_employee_id, form.include_attached]);

  async function create() {
    setError(''); setSaving(true);
    try {
      const { data } = await api.post('/asset-audits', { ...form, include_attached: form.include_attached ? 'yes' : 'no' });
      onCreated(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not generate the audit sheet.'); setSaving(false); }
  }

  return (
    <Modal title="Generate Audit Sheet" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        <div className="field">
          <label>Audit Period *</label>
          <input type="month" value={form.period_month} onChange={(e) => set({ period_month: e.target.value })} />
        </div>
        <div className="field">
          <label>Location</label>
          <select value={form.location_id} onChange={(e) => set({ location_id: e.target.value })}>
            <option value="">--All locations--</option>
            {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Custodian</label>
          <select value={form.custodian_employee_id} onChange={(e) => set({ custodian_employee_id: e.target.value })}>
            <option value="">--All custodians--</option>
            {meta.employees.map((e2) => <option key={e2.id} value={e2.id}>{e2.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.include_attached} onChange={(e) => set({ include_attached: e.target.checked })} />
            Include attached assets
          </label>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Off by default — counting the RAM inside a system unit means opening the case.
          </div>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Memo</label>
          <textarea rows={2} value={form.memo} onChange={(e) => set({ memo: e.target.value })} />
        </div>
      </div>
      <p className="muted">
        {count == null ? 'Counting the assets in scope...' : `This sheet will cover ${count} asset${count === 1 ? '' : 's'}.`}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || count === 0} onClick={create}>{saving ? 'Generating...' : 'Generate'}</button>
      </div>
    </Modal>
  );
}

export default function AssetAudits() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);
  const [filters, setFilters] = useState({ search: '', status: '', location_id: '' });
  const [applied, setApplied] = useState({ search: '', status: '', location_id: '' });

  useEffect(() => { api.get('/asset-audits/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    for (const [k, v] of Object.entries(applied)) if (v) params[k] = v;
    const { data } = await api.get('/asset-audits', { params });
    setRows(data.rows); setTotal(data.total); setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  function runSearch() { setPage(1); setApplied(filters); }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <h1>Asset Audits</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/assets">Assets</Link>
          {can('/asset-audits', 'can_add') && meta && <button className="btn btn-primary" onClick={() => setShowNew(true)}>Generate Sheet</button>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={filters.search} onChange={(e) => setF({ search: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Audit no or memo..." />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(AUDIT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Location</label>
            <select value={filters.location_id} onChange={(e) => setF({ location_id: e.target.value })}>
              <option value="">--ALL--</option>
              {(meta?.locations || []).map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Audit No</th><th>Period</th><th>Scope</th><th style={{ textAlign: 'right' }}>Assets</th><th style={{ textAlign: 'right' }}>Uncounted</th><th style={{ textAlign: 'right' }}>Exceptions</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No audit sheets yet.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Audit No">{r.audit_no}</td>
                    <td data-label="Period">{formatMonth(r.period_month)}</td>
                    <td data-label="Scope">{r.location_name || 'All locations'}{r.custodian_name?.trim() ? ` · ${r.custodian_name}` : ''}</td>
                    <td data-label="Assets" style={{ textAlign: 'right' }}>{r.line_count}</td>
                    <td data-label="Uncounted" style={{ textAlign: 'right' }}>{r.pending_count}</td>
                    <td data-label="Exceptions" style={{ textAlign: 'right' }}>{r.exception_count}</td>
                    <td data-label="Status">{AUDIT_STATUS_LABELS[r.status] || r.status}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-audits/${r.id}`)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {showNew && meta && (
        <NewAuditModal meta={meta} onClose={() => setShowNew(false)} onCreated={(d) => navigate(`/asset-audits/${d.id}`)} />
      )}
    </div>
  );
}
