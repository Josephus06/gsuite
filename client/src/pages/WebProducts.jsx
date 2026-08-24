import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

// Master Lists > Website Products: the catalogue the customer-facing quote site offers.
//
// A product here is a pointer at what the ERP already owns -- a job type, and process/material
// lines with default sizes -- never a second pricing model. The Preview column runs the same
// pricing code the public API does, so what you see is what a customer would be quoted.
//
// Publishing is what makes a product visible to the site, and it is gated on can_approve rather
// than can_edit: correcting a default size and deciding the catalogue is ready to quote from are
// different calls.
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
};

const BLANK = {
  slug: '', name: '', tagline: '', description: '', image_url: '', job_type_id: '',
  sales_division_id: '', default_qty: 1, min_qty: 1, max_qty: '', lead_time_days: '', sort_order: 0,
};

export default function WebProducts() {
  const { can } = useAuth();
  const canEdit = can('/web-products', 'can_edit');
  const canPublish = can('/web-products', 'can_approve');

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [previews, setPreviews] = useState({});
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(null);

  const [jobTypes, setJobTypes] = useState([]);
  const [processes, setProcesses] = useState([]);
  const [items, setItems] = useState([]);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/web-products');
      setRows(data);
      // Price every product's defaults up front -- a catalogue where you have to click each row to
      // find out which ones are broken is a catalogue nobody checks.
      const priced = await Promise.all(data.map((p) =>
        api.get(`/web-products/${p.id}/preview-price`).then((r) => [p.id, r.data]).catch(() => [p.id, null])));
      setPreviews(Object.fromEntries(priced));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the catalogue.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    api.get('/job-types').then((r) => setJobTypes(r.data)).catch(() => {});
    api.get('/lookups/processes').then((r) => setProcesses(r.data)).catch(() => {});
    api.get('/inventory').then((r) => setItems(r.data)).catch(() => {});
  }, []);

  async function togglePublish(row) {
    setBusy(row.id); setError('');
    try {
      await api.put(`/web-products/${row.id}/publish`, { is_published: !row.is_published });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change the published state.');
    } finally { setBusy(null); }
  }

  async function openEdit(row) {
    setError('');
    if (!row) { setEditing(BLANK); setDetail(null); return; }
    const { data } = await api.get(`/web-products/${row.id}`);
    setEditing({ ...BLANK, ...data });
    setDetail(data);
  }

  async function saveProduct(e) {
    e.preventDefault();
    setBusy('save'); setError('');
    try {
      if (editing.id) await api.put(`/web-products/${editing.id}`, editing);
      else await api.post('/web-products', editing);
      setEditing(null); setDetail(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
    } finally { setBusy(null); }
  }

  async function saveLine(line) {
    setBusy(`line-${line.id}`); setError('');
    try {
      if (line.id) await api.put(`/web-products/lines/${line.id}`, line);
      else await api.post(`/web-products/${editing.id}/lines`, line);
      await openEdit({ id: editing.id });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that line.');
    } finally { setBusy(null); }
  }

  async function removeLine(lineId) {
    if (!confirm('Remove this line from the product?')) return;
    await api.delete(`/web-products/lines/${lineId}`).catch(() => {});
    await openEdit({ id: editing.id });
    await load();
  }

  return (
    <div>
      <div className="page-header">
        <h1>Website Products</h1>
        {can('/web-products', 'can_add') && (
          <button className="btn btn-primary" onClick={() => openEdit(null)}>Add Product</button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <p className="muted" style={{ margin: 0 }}>
          These are the products customers can price themselves on the website. Prices come from the
          same costing the estimate wizard uses. A product is only visible online once published.
        </p>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Slug</th>
                  <th>Job Type</th>
                  <th>Lines</th>
                  <th style={{ textAlign: 'right' }}>Preview Price</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No website products yet.
                  </td></tr>
                )}
                {rows.map((r) => {
                  const pv = previews[r.id];
                  const problems = (pv?.lines || []).filter((l) => l.problem);
                  return (
                    <tr key={r.id}>
                      <td data-label="Product"><strong>{r.name}</strong><div className="muted" style={{ fontSize: '0.85em' }}>{r.tagline}</div></td>
                      <td data-label="Slug">{r.slug}</td>
                      <td data-label="Job Type">{r.job_type_name || <span className="muted">— not set —</span>}</td>
                      <td data-label="Lines">{r.line_count}</td>
                      <td data-label="Preview Price" style={{ textAlign: 'right' }}>
                        {pv ? money(pv.total) : '—'}
                        {/* What stops a broken product being published, so it is said here rather
                            than only in the error when publishing is refused. */}
                        {problems.length > 0 && (
                          <div style={{ color: '#b45309', fontSize: '0.8em' }}>{problems[0].problem}</div>
                        )}
                      </td>
                      <td data-label="Status">
                        <span className={`badge ${r.is_published ? 'badge-success' : 'badge-muted'}`}>
                          {r.is_published ? 'Published' : 'Draft'}
                        </span>
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        {canEdit && <button className="btn btn-sm" onClick={() => openEdit(r)}>Edit</button>}
                        {canPublish && (
                          <button
                            className={`btn btn-sm ${r.is_published ? '' : 'btn-primary'}`}
                            disabled={busy === r.id}
                            onClick={() => togglePublish(r)}
                          >
                            {busy === r.id ? '…' : r.is_published ? 'Unpublish' : 'Publish'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" style={{ maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>
            <h2>{editing.id ? `Edit ${editing.name}` : 'New Website Product'}</h2>

            <form onSubmit={saveProduct}>
              <div className="filter-grid">
                <div className="field">
                  <label>Name *</label>
                  <input required value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </div>
                <div className="field">
                  <label>Slug * <span className="muted">(the web address)</span></label>
                  <input required value={editing.slug || ''} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} />
                </div>
                <div className="field">
                  <label>Job Type</label>
                  <select value={editing.job_type_id || ''} onChange={(e) => setEditing({ ...editing, job_type_id: e.target.value })}>
                    <option value="">— none —</option>
                    {jobTypes.map((j) => <option key={j.id} value={j.id}>{j.display_name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Lead time (days)</label>
                  <input type="number" value={editing.lead_time_days || ''} onChange={(e) => setEditing({ ...editing, lead_time_days: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>Tagline</label>
                <input value={editing.tagline || ''} onChange={(e) => setEditing({ ...editing, tagline: e.target.value })} />
              </div>
              <div className="field">
                <label>Description</label>
                <textarea rows={2} value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-primary" disabled={busy === 'save'}>
                  {busy === 'save' ? 'Saving…' : 'Save Product'}
                </button>
                <button type="button" className="btn" onClick={() => setEditing(null)}>Close</button>
              </div>
            </form>

            {detail && (
              <>
                <h3 style={{ marginTop: 22 }}>Lines</h3>
                <p className="muted" style={{ fontSize: '0.88em' }}>
                  Each line is one process and its material. The customer may change the size and
                  quantity; they can never change which process or material is used.
                </p>
                {detail.lines.map((l) => (
                  <LineEditor
                    key={l.id} line={l} processes={processes} items={items}
                    busy={busy === `line-${l.id}`} onSave={saveLine} onRemove={() => removeLine(l.id)}
                  />
                ))}
                <LineEditor
                  key="new" line={{ line_no: (detail.lines.length || 0) + 1, allow_qty: 1, allow_size: 1 }}
                  processes={processes} items={items} busy={busy === 'line-undefined'} onSave={saveLine}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LineEditor({ line, processes, items, busy, onSave, onRemove }) {
  const [draft, setDraft] = useState(line);
  useEffect(() => { setDraft(line); }, [line]);
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="filter-grid">
        <div className="field">
          <label>Label</label>
          <input value={draft.label || ''} onChange={(e) => set('label', e.target.value)} placeholder="Printing" />
        </div>
        <div className="field">
          <label>Process</label>
          <select value={draft.process_id || ''} onChange={(e) => set('process_id', e.target.value)}>
            <option value="">— none —</option>
            {processes
              .filter((p) => p.is_active || String(p.id) === String(draft.process_id))
              .map((p) => <option key={p.id} value={p.id}>{p.process_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Material</label>
          <select value={draft.item_id || ''} onChange={(e) => set('item_id', e.target.value)}>
            <option value="">— none —</option>
            {items.slice(0, 400).map((i) => <option key={i.id} value={i.id}>{i.display_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Unit</label>
          <input value={draft.uom || ''} onChange={(e) => set('uom', e.target.value)} placeholder="IN" />
        </div>
      </div>
      <div className="filter-grid">
        <div className="field"><label>Default qty</label>
          <input type="number" value={draft.default_qty ?? ''} onChange={(e) => set('default_qty', e.target.value)} /></div>
        <div className="field"><label>Default length</label>
          <input type="number" step="0.25" value={draft.default_length ?? ''} onChange={(e) => set('default_length', e.target.value)} /></div>
        <div className="field"><label>Default width</label>
          <input type="number" step="0.25" value={draft.default_width ?? ''} onChange={(e) => set('default_width', e.target.value)} /></div>
      </div>
      <div className="filter-grid">
        <div className="field"><label>Min / Max length</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" step="0.25" value={draft.min_length ?? ''} onChange={(e) => set('min_length', e.target.value)} />
            <input type="number" step="0.25" value={draft.max_length ?? ''} onChange={(e) => set('max_length', e.target.value)} />
          </div></div>
        <div className="field"><label>Min / Max width</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" step="0.25" value={draft.min_width ?? ''} onChange={(e) => set('min_width', e.target.value)} />
            <input type="number" step="0.25" value={draft.max_width ?? ''} onChange={(e) => set('max_width', e.target.value)} />
          </div></div>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!Number(draft.allow_qty)}
            onChange={(e) => set('allow_qty', e.target.checked ? 1 : 0)} /> Customer may change quantity
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!Number(draft.allow_size)}
            onChange={(e) => set('allow_size', e.target.checked ? 1 : 0)} /> Customer may change size
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onSave(draft)}>
            {busy ? '…' : line.id ? 'Save line' : 'Add line'}
          </button>
          {onRemove && <button className="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>}
        </div>
      </div>
    </div>
  );
}
