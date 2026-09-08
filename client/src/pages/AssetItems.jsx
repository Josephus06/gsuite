import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 15;
const EMPTY = { item_code: '', display_name: '', category: '', owning_department_id: '', brand: '', model: '', specification: '', description: '', is_active: true };

// Asset types -- the "UPS" / "RAM 8 GB" / "System Unit" level. The individual reference numbers
// registered under each type live on the Assets page; this one exists so the type is spelled once
// rather than re-typed against every unit.
function ItemModal({ item, categories, departments, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...EMPTY, ...(item || {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    if (!form.display_name.trim()) { setError('Asset type name is required.'); return; }
    setError(''); setSaving(true);
    try {
      if (item?.id) await api.put(`/asset-items/${item.id}`, form);
      else await api.post('/asset-items', form);
      onSaved();
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  return (
    <Modal title={item?.id ? `Edit ${item.display_name}` : 'New Asset Type'} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        <div className="field">
          <label>Code</label>
          <input value={form.item_code || ''} onChange={(e) => set({ item_code: e.target.value })} placeholder="Auto (AST-0001)" />
        </div>
        <div className="field">
          <label>Asset Type Name *</label>
          <input value={form.display_name} onChange={(e) => set({ display_name: e.target.value })} placeholder="UPS, RAM 8 GB, System Unit..." />
        </div>
        <div className="field">
          <label>Category</label>
          <input list="asset-item-categories" value={form.category || ''} onChange={(e) => set({ category: e.target.value })} placeholder="IT Equipment" />
          <datalist id="asset-item-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div className="field">
          <label>Owning Department *</label>
          <select value={form.owning_department_id || ''} onChange={(e) => set({ owning_department_id: e.target.value })}>
            <option value="">--Select--</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Every unit of this type belongs to this department. Only its people see them, and only its
            head can transfer or dispose of them.
          </div>
        </div>
        <div className="field">
          <label>Brand</label>
          <input value={form.brand || ''} onChange={(e) => set({ brand: e.target.value })} />
        </div>
        <div className="field">
          <label>Model</label>
          <input value={form.model || ''} onChange={(e) => set({ model: e.target.value })} />
        </div>
        <div className="field">
          <label>Specification</label>
          <input value={form.specification || ''} onChange={(e) => set({ specification: e.target.value })} placeholder="650VA, DDR4 2666MHz..." />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Description</label>
          <textarea rows={2} value={form.description || ''} onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.is_active !== false} onChange={(e) => set({ is_active: e.target.checked })} />
            Active
          </label>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

export default function AssetItems() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState({ search: '', category: '', active: '' });
  const [category, setCategory] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    if (applied.search) params.search = applied.search;
    if (applied.category) params.category = applied.category;
    if (applied.active) params.active = applied.active;
    const { data } = await api.get('/asset-items', { params });
    setRows(data.rows); setTotal(data.total); setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/asset-items/categories').then(({ data }) => setCategories(data)); }, []);
  useEffect(() => { api.get('/asset-items/meta').then(({ data }) => setDepartments(data.departments)).catch(() => {}); }, []);

  function runSearch() { setPage(1); setApplied({ search, category, active }); }

  async function remove(row) {
    if (!confirm(`Delete asset type "${row.display_name}"?`)) return;
    setError('');
    try { await api.delete(`/asset-items/${row.id}`); load(); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed.'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <h1>Asset Types</h1>
        {can('/asset-items', 'can_add') && <button className="btn btn-primary" onClick={() => setEditing({})}>Add New</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Name, code, brand or model..." />
          </div>
          <div className="field">
            <label>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">--ALL--</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="yes">Active</option>
              <option value="no">Inactive</option>
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
                <tr><th>Code</th><th>Asset Type</th><th>Owning Department</th><th>Category</th><th>Brand</th><th style={{ textAlign: 'right' }}>Units</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No asset types yet.</td></tr>}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Code">{row.item_code}</td>
                    <td data-label="Asset Type">{row.display_name}</td>
                    <td data-label="Owning Department">
                      {row.owning_department_name || <span style={{ color: '#b45309' }}>not set</span>}
                    </td>
                    <td data-label="Category">{row.category || '—'}</td>
                    <td data-label="Brand">{[row.brand, row.model].filter(Boolean).join(' ') || '—'}</td>
                    <td data-label="Units" style={{ textAlign: 'right' }}>{row.unit_count}</td>
                    <td data-label="Status">{row.is_active ? 'Active' : 'Inactive'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {can('/asset-items', 'can_edit') && <button className="btn btn-sm btn-primary" onClick={() => setEditing(row)}>Edit</button>}
                      {can('/asset-items', 'can_delete') && row.unit_count === 0 && <button className="btn btn-sm btn-warning" onClick={() => remove(row)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {editing && (
        <ItemModal
          item={editing.id ? editing : null}
          categories={categories}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); api.get('/asset-items/categories').then(({ data }) => setCategories(data)); }}
        />
      )}
    </div>
  );
}
