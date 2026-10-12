import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import useAutoSearch from '../utils/useAutoSearch';

const ROUTE = '/unit-of-measures';
const num = (v, d = 2) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yn = (v) => (Number(v) ? 'YES' : 'NO');

const BLANK_PU = { code: '', purchase_unit: '', base_unit: '', is_length: false, is_width: false };
const BLANK_UT = { title: '', purchase_unit: '', stock_unit: '', sale_unit: '', base_unit: '', length: '', width: '', conversion: '', is_length: false, is_width: false, is_pieces: false, pieces: '' };

// Master Lists > Unit of Measures (2026-10-12): the source's two tabs -- Purchase Units and Unit
// Title -- with search, Add and Update (routes/unitOfMeasures.js).
export default function UnitOfMeasures() {
  const { can } = useAuth();
  const [tab, setTab] = useState('purchase');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // { kind, id|null, form }
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get(`/unit-of-measures/${tab === 'purchase' ? 'purchase-units' : 'unit-titles'}`, { params: search ? { search } : {} });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load.'); }
    setLoading(false);
  }, [tab, search]);

  useEffect(() => { load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useAutoSearch(search, load);
  useEffect(() => { api.get('/unit-of-measures/units').then(({ data }) => setUnits(data)).catch(() => {}); }, []);

  const open = (kind, row) => {
    const blank = kind === 'purchase' ? BLANK_PU : BLANK_UT;
    const form = { ...blank };
    if (row) for (const k of Object.keys(blank)) form[k] = typeof blank[k] === 'boolean' ? !!Number(row[k]) : (row[k] ?? '');
    setEditing({ kind, id: row?.id || null, form });
    setError('');
  };
  const setF = (patch) => setEditing((e) => ({ ...e, form: { ...e.form, ...patch } }));

  async function save() {
    setSaving(true); setError('');
    const path = editing.kind === 'purchase' ? 'purchase-units' : 'unit-titles';
    try {
      if (editing.id) await api.put(`/unit-of-measures/${path}/${editing.id}`, editing.form);
      else await api.post(`/unit-of-measures/${path}`, editing.form);
      setEditing(null);
      await load();
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); }
    setSaving(false);
  }

  const unitSelect = (key, label, required) => (
    <div className="field">
      <label>{label}{required ? ' *' : ''}</label>
      <select value={editing.form[key] || ''} onChange={(e) => setF({ [key]: e.target.value })}>
        <option value="">--Select--</option>
        {units.map((u) => <option key={u.id} value={u.code}>{u.code}</option>)}
      </select>
    </div>
  );
  const check = (key, label) => (
    <div className="field field-checkbox">
      <input type="checkbox" id={`uom-${key}`} checked={!!editing.form[key]} onChange={(e) => setF({ [key]: e.target.checked })} />
      <label htmlFor={`uom-${key}`}>{label}</label>
    </div>
  );

  const isPu = tab === 'purchase';
  return (
    <div>
      <div className="page-header"><h1>Unit of Measures</h1></div>
      {error && !editing && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 12 }}>
          <button type="button" className={`status-tab ${isPu ? 'active' : ''}`} onClick={() => { setTab('purchase'); setSearch(''); }}>Purchase Units</button>
          <button type="button" className={`status-tab ${!isPu ? 'active' : ''}`} onClick={() => { setTab('title'); setSearch(''); }}>Unit Title</button>
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
          <input style={{ maxWidth: 420 }} value={search} placeholder="Search..." onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
          {can(ROUTE, 'can_add') && (
            <button className="btn btn-primary" onClick={() => open(tab)}>{isPu ? 'Add Purchase Unit' : 'Add Unit of Measure'}</button>
          )}
        </div>

        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                {isPu ? (
                  <tr><th>Unit Code</th><th>Purchase Unit</th><th>Base Unit</th><th>Length</th><th>Width</th><th></th></tr>
                ) : (
                  <tr><th>Unit Title</th><th>Purchase Unit</th><th>Stock Unit</th><th>Sale Unit</th><th>Base Unit</th>
                    <th style={{ textAlign: 'right' }}>Length</th><th style={{ textAlign: 'right' }}>Width</th><th style={{ textAlign: 'right' }}>Conversion</th><th></th></tr>
                )}
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing here yet{search ? ' for that search' : ''}.
                  </td></tr>
                )}
                {rows.map((r) => (isPu ? (
                  <tr key={r.id}>
                    <td data-label="Unit Code">{r.code}</td>
                    <td data-label="Purchase Unit">{r.purchase_unit}</td>
                    <td data-label="Base Unit">{r.base_unit}</td>
                    <td data-label="Length">{yn(r.is_length)}</td>
                    <td data-label="Width">{yn(r.is_width)}</td>
                    <td>{can(ROUTE, 'can_edit') && <button className="btn btn-sm btn-primary" onClick={() => open('purchase', r)}>Update</button>}</td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td data-label="Unit Title">{r.title}</td>
                    <td data-label="Purchase Unit">{r.purchase_unit}</td>
                    <td data-label="Stock Unit">{r.stock_unit}</td>
                    <td data-label="Sale Unit">{r.sale_unit}</td>
                    <td data-label="Base Unit">{r.base_unit}</td>
                    <td data-label="Length" style={{ textAlign: 'right' }}>{num(r.length)}</td>
                    <td data-label="Width" style={{ textAlign: 'right' }}>{num(r.width)}</td>
                    <td data-label="Conversion" style={{ textAlign: 'right' }}>{num(r.conversion, 4)}</td>
                    <td>{can(ROUTE, 'can_edit') && <button className="btn btn-sm btn-primary" onClick={() => open('title', r)}>Update</button>}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Modal title={`${editing.id ? 'Update' : 'Add'} ${editing.kind === 'purchase' ? 'Purchase Unit' : 'Unit of Measure'}`} onClose={() => setEditing(null)} large>
          {error && <div className="error-banner">{error}</div>}
          {editing.kind === 'purchase' ? (
            <div className="filter-grid">
              <div className="field"><label>Unit Code *</label><input value={editing.form.code} onChange={(e) => setF({ code: e.target.value })} /></div>
              {unitSelect('purchase_unit', 'Purchase Unit', true)}
              {unitSelect('base_unit', 'Base Unit', true)}
              {check('is_length', 'Length')}
              {check('is_width', 'Width')}
            </div>
          ) : (
            <div className="filter-grid">
              <div className="field"><label>Unit Title *</label><input value={editing.form.title} onChange={(e) => setF({ title: e.target.value })} /></div>
              {unitSelect('purchase_unit', 'Purchase Unit', true)}
              {unitSelect('stock_unit', 'Stock Unit')}
              {unitSelect('sale_unit', 'Sale Unit')}
              {unitSelect('base_unit', 'Base Unit', true)}
              <div className="field"><label>Length</label><input type="number" step="any" value={editing.form.length} onChange={(e) => setF({ length: e.target.value })} /></div>
              <div className="field"><label>Width</label><input type="number" step="any" value={editing.form.width} onChange={(e) => setF({ width: e.target.value })} /></div>
              <div className="field">
                <label>Conversion</label>
                <input type="number" step="any" value={editing.form.conversion} placeholder="Length x Width, or 1"
                  title="Purchase Unit -> Base Unit. Left blank, it is the length (x width), or 1."
                  onChange={(e) => setF({ conversion: e.target.value })} />
              </div>
              {check('is_length', 'Length-based')}
              {check('is_width', 'Width-based')}
              {check('is_pieces', 'Pieces')}
              {editing.form.is_pieces && (
                <div className="field"><label>Pieces</label><input type="number" step="any" value={editing.form.pieces} onChange={(e) => setF({ pieces: e.target.value })} /></div>
              )}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
