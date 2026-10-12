import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import useAutoSearch from '../utils/useAutoSearch';

const ROUTE = '/unit-of-measures';
const num = (v, d = 2) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yn = (v) => (Number(v) ? 'YES' : 'NO');

const BLANK_PU = { code: '', purchase_unit: '', base_unit: '', is_length: false, is_width: false, sales_units: [] };
const BLANK_UT = { name: '', title: '', purchase_unit: '', stock_unit: '', sale_unit: '', base_unit: '', length: '', width: '', conversion: '', is_length: false, is_width: false, is_pieces: false, pieces: '', sales_units: [] };

// A Unit Title's conversion from its measurements: length x width when both count, else whichever
// one does, else 1 -- as the source fills it (ROLL-LINCH-1968: a 1,968-inch roll converts at 1,968).
function conversionOf(f) {
  const l = f.is_length ? Number(f.length) || 0 : 0;
  const w = f.is_width ? Number(f.width) || 0 : 0;
  if (l && w) return l * w;
  return l || w || 1;
}
// The source names a title Unit Code - conversion: ROLL-LINCH-1968, SHT-SQFT-32, CAN-LTR-3.7.
const titleOf = (code, conv) => (code ? `${code}-${Number(conv) || 1}` : '');
const splitUnits = (v) => String(v || '').split('|').map((x) => x.trim()).filter(Boolean);

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
  // The Purchase Units a Unit Title is built from (its Unit Code picker).
  const [purchaseUnits, setPurchaseUnits] = useState([]);

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
    if (row) {
      for (const k of Object.keys(blank)) {
        if (k === 'sales_units') form[k] = splitUnits(row[k]);
        else form[k] = typeof blank[k] === 'boolean' ? !!Number(row[k]) : (row[k] ?? '');
      }
    }
    // An existing title whose title or conversion was typed is kept as typed until changed.
    form.titleTyped = !!row;
    form.conversionTyped = !!row;
    setEditing({ kind, id: row?.id || null, form });
    setError('');
    if (kind === 'title') api.get('/unit-of-measures/purchase-units').then(({ data }) => setPurchaseUnits(data || [])).catch(() => {});
  };
  // Every change re-derives what is derived: Conversion from Length / Width (unless typed), and the
  // Unit Title from Unit Code + Conversion (unless typed).
  const setF = (patch) => setEditing((e) => {
    let f = { ...e.form, ...patch };
    if (e.kind === 'title') {
      if (!f.conversionTyped) f = { ...f, conversion: conversionOf(f) };
      if (!f.titleTyped) f = { ...f, title: titleOf(f.name, f.conversion) };
    }
    return { ...e, form: f };
  });

  // Picking the Unit Code (a Purchase Unit) fills the rest from it.
  function pickPurchaseUnit(pu) {
    if (!pu) return;
    setF({
      name: pu.code, purchase_unit: pu.purchase_unit || '', stock_unit: pu.purchase_unit || '',
      base_unit: pu.base_unit || '', sale_unit: pu.base_unit || '',
      is_length: !!Number(pu.is_length), is_width: !!Number(pu.is_width),
      length: Number(pu.is_length) ? editing.form.length : '', width: Number(pu.is_width) ? editing.form.width : '',
      sales_units: splitUnits(pu.sales_units),
    });
  }

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
            // Laid out as the source's Add New Purchase Unit: Unit Code, a typed Purchase Unit, a
            // Base Unit picked from the units, Length / Width, and its Sales Units added one by one.
            <div>
              <div className="field"><label>Unit Code *</label><input value={editing.form.code} onChange={(e) => setF({ code: e.target.value.toUpperCase() })} /></div>
              <div className="field">
                <label>Purchase Unit *</label>
                <input list="uom-unit-codes" value={editing.form.purchase_unit} onChange={(e) => setF({ purchase_unit: e.target.value.toUpperCase() })} />
                <datalist id="uom-unit-codes">{units.map((u) => <option key={u.id} value={u.code} />)}</datalist>
              </div>
              {unitSelect('base_unit', 'Base Unit', true)}
              <div style={{ display: 'flex', gap: 24 }}>
                {check('is_length', 'Length')}
                {check('is_width', 'Width')}
              </div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table>
                  <thead><tr><th>Sales Units</th><th style={{ width: 60 }}></th></tr></thead>
                  <tbody>
                    {editing.form.sales_units.length === 0 && (
                      <tr><td colSpan={2} className="muted" style={{ padding: 10 }}>None yet.</td></tr>
                    )}
                    {editing.form.sales_units.map((su, i) => (
                      <tr key={i}>
                        <td>
                          <select value={su} onChange={(e) => setF({ sales_units: editing.form.sales_units.map((x, j) => (j === i ? e.target.value : x)) })}>
                            <option value="">--Select--</option>
                            {/* A unit the source listed that is not a unit here still shows, so saving keeps it. */}
                            {su && !units.some((u) => u.code === su) && <option value={su}>{su}</option>}
                            {units.map((u) => <option key={u.id} value={u.code}>{u.code}</option>)}
                          </select>
                        </td>
                        <td>
                          <button type="button" className="btn btn-sm btn-danger"
                            onClick={() => setF({ sales_units: editing.form.sales_units.filter((_, j) => j !== i) })}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 8 }}
                onClick={() => setF({ sales_units: [...editing.form.sales_units, ''] })}>Add</button>
            </div>
          ) : (
            // Laid out as the source's Add New Unit Of Measure: pick the Unit Code (a Purchase Unit),
            // which fills Purchase / Stock / Base Unit; Length and Width open only where that unit is
            // measured by them; Conversion and the Unit Title follow (both can be typed over).
            <div>
              <div className="field">
                <label>Unit Code *</label>
                <EntityPicker
                  label="Select Purchase Unit" items={purchaseUnits} value={(purchaseUnits.find((p) => p.code === editing.form.name) || {}).id || ''}
                  getLabel={(p) => p?.code} placeholder={editing.form.name || 'Select Purchase Unit...'}
                  columns={[
                    { key: 'code', label: 'Unit Code' }, { key: 'purchase_unit', label: 'Purchase Unit' }, { key: 'base_unit', label: 'Base Unit' },
                    { key: 'is_length', label: 'Length', render: (p) => yn(p.is_length) }, { key: 'is_width', label: 'Width', render: (p) => yn(p.is_width) },
                  ]}
                  searchKeys={['code', 'purchase_unit', 'base_unit']}
                  onSelect={pickPurchaseUnit}
                />
              </div>
              <div className="field"><label>Purchase Unit</label><input value={editing.form.purchase_unit} disabled /></div>
              <div className="field"><label>Stock Unit</label><input value={editing.form.stock_unit} disabled /></div>
              <div className="field"><label>Base Unit</label><input value={editing.form.base_unit} disabled /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field">
                  <label>Length</label>
                  <input type="number" step="any" value={editing.form.length} disabled={!editing.form.is_length}
                    title={editing.form.is_length ? undefined : 'This Purchase Unit is not measured by length'}
                    onChange={(e) => setF({ length: e.target.value })} />
                </div>
                <div className="field">
                  <label>Width</label>
                  <input type="number" step="any" value={editing.form.width} disabled={!editing.form.is_width}
                    title={editing.form.is_width ? undefined : 'This Purchase Unit is not measured by width'}
                    onChange={(e) => setF({ width: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>Conversion</label>
                <input type="number" step="any" value={editing.form.conversion}
                  title="Purchase Unit -> Base Unit: Length x Width, or 1. Type to set it yourself."
                  onChange={(e) => setF({ conversion: e.target.value, conversionTyped: e.target.value !== '' })} />
              </div>
              <div className="field">
                <label>Unit Title *</label>
                <input value={editing.form.title}
                  title="Unit Code - Conversion (e.g. ROLL-LINCH-1968). Type to set it yourself."
                  onChange={(e) => setF({ title: e.target.value, titleTyped: e.target.value !== '' })} />
              </div>
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
