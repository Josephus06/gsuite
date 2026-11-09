import { useEffect, useState } from 'react';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { useAuth } from '../context/useAuth';
import { Check, errorOf } from './installation/common';

// Production > Installation Categories -- PLANNER's Project Categories with their quality checklists.
// A project takes its checklist from its category; each project ticks its own copy.
const ROUTE = '/installation-categories';
const API = '/installation-planner';

export default function InstallationCategories() {
  const { can } = useAuth();
  const canAdd = can(ROUTE, 'can_add');
  const canEdit = can(ROUTE, 'can_edit');
  const canDelete = can(ROUTE, 'can_delete');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // { kind: 'category', row } | { kind: 'item', category, row }
  const [openId, setOpenId] = useState(null);

  const load = () => api.get(`${API}/categories`).then(({ data }) => { setRows(data); setError(''); }).catch((err) => setError(errorOf(err)));
  useEffect(() => { load(); }, []);

  async function del(path, what) {
    if (!window.confirm(`Delete ${what}?`)) return;
    try { await api.delete(path); load(); } catch (err) { setError(errorOf(err)); }
  }

  return (
    <div className="page">
      <div className="page-header" style={{ justifyContent: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Installation Categories</h1>
          <div className="muted">Each category's quality checklist appears on its projects.</div>
        </div>
        {canAdd && <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'category', row: null })}>+ New Category</button>}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!rows ? <LoadingSpinner /> : rows.length === 0 ? <div className="card empty-state">No categories yet.</div> : (
        <div style={{ display: 'grid', gap: 12 }}>
          {rows.map((c) => (
            <div key={c.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setOpenId(openId === c.id ? null : c.id)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit' }}>
                  <strong style={{ fontSize: 16 }}>{openId === c.id ? '▾' : '▸'} {c.name}</strong>
                  {!c.is_active && <span className="badge badge-muted" style={{ marginLeft: 6 }}>Inactive</span>}
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{c.items.length} checklist item(s) · {c.project_count} project(s)</span>
                  {c.description && <div className="muted" style={{ fontSize: 13 }}>{c.description}</div>}
                </button>
                <div style={{ display: 'flex', gap: 6 }}>
                  {canEdit && <button type="button" className="btn btn-sm" onClick={() => setModal({ kind: 'item', category: c, row: null })}>+ Checklist Item</button>}
                  {canEdit && <button type="button" className="btn btn-sm" onClick={() => setModal({ kind: 'category', row: c })}>Edit</button>}
                  {canDelete && <button type="button" className="btn btn-sm btn-danger" onClick={() => del(`${API}/categories/${c.id}`, `category "${c.name}" and its checklist`)}>Delete</button>}
                </div>
              </div>
              {openId === c.id && (
                c.items.length === 0 ? <p className="muted">No checklist items yet.</p> : (
                  <div className="table-wrap" style={{ marginTop: 10 }}>
                    <table>
                      <thead><tr><th style={{ width: 60 }}>Order</th><th>Checklist Item</th><th>Required</th><th>Active</th>{(canEdit || canDelete) && <th style={{ width: 130 }} />}</tr></thead>
                      <tbody>
                        {c.items.map((i) => (
                          <tr key={i.id}>
                            <td>{i.sort_order}</td>
                            <td>{i.item}</td>
                            <td>{i.is_required ? <span className="badge badge-danger">Required</span> : '—'}</td>
                            <td>{i.is_active ? 'Yes' : <span className="muted">No</span>}</td>
                            {(canEdit || canDelete) && (
                              <td style={{ whiteSpace: 'nowrap' }}>
                                {canEdit && <button type="button" className="btn btn-sm" onClick={() => setModal({ kind: 'item', category: c, row: i })}>Edit</button>}{' '}
                                {canDelete && <button type="button" className="btn btn-sm btn-danger" onClick={() => del(`${API}/checklist-items/${i.id}`, `"${i.item}"`)}>Delete</button>}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {modal?.kind === 'category' && <CategoryModal row={modal.row} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal?.kind === 'item' && (
        <ItemModal category={modal.category} row={modal.row} onClose={() => setModal(null)}
          onSaved={() => { setOpenId(modal.category.id); setModal(null); load(); }} />
      )}
    </div>
  );
}

function CategoryModal({ row, onClose, onSaved }) {
  const [form, setForm] = useState({ name: row?.name || '', description: row?.description || '', is_active: row ? !!row.is_active : true });
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    try {
      if (row) await api.put(`${API}/categories/${row.id}`, form); else await api.post(`${API}/categories`, form);
      onSaved();
    } catch (err) { setError(errorOf(err)); }
  }
  return (
    <Modal title={row ? 'Edit Category' : 'New Category'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <form onSubmit={save}>
        <div className="field"><label>Name *</label><input required maxLength={150} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="field"><label>Description</label><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        <Check checked={form.is_active} onChange={(v) => setForm({ ...form, is_active: v })}>Active (offered on new projects)</Check>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" className="btn btn-primary">Save</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function ItemModal({ category, row, onClose, onSaved }) {
  const nextOrder = category.items.reduce((m, i) => Math.max(m, Number(i.sort_order) || 0), 0) + 1;
  const [form, setForm] = useState({
    item: row?.item || '', sort_order: row ? row.sort_order : nextOrder, is_required: !!row?.is_required, is_active: row ? !!row.is_active : true,
  });
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    try {
      if (row) await api.put(`${API}/checklist-items/${row.id}`, form); else await api.post(`${API}/categories/${category.id}/items`, form);
      onSaved();
    } catch (err) { setError(errorOf(err)); }
  }
  return (
    <Modal title={`${row ? 'Edit' : 'Add'} Checklist Item · ${category.name}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <form onSubmit={save}>
        <div className="field"><label>Checklist Item *</label><input required maxLength={255} value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} /></div>
        <div className="field"><label>Order</label><input type="number" min={0} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} /></div>
        <Check checked={form.is_required} onChange={(v) => setForm({ ...form, is_required: v })} style={{ display: 'flex', marginBottom: 6 }}>Required</Check>
        <Check checked={form.is_active} onChange={(v) => setForm({ ...form, is_active: v })} style={{ display: 'flex' }}>Active</Check>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" className="btn btn-primary">Save</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
