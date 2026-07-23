import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Every figure is recomputed from the four editable inputs rather than trusted from the
// prefill -- this mirrors computeLineAmounts in routes/deliveryTickets.js exactly, so the
// preview here and the record the server writes can never disagree.
function lineAmounts(l) {
  const qty = Number(l.quantity || 0);
  const price = Number(l.price_per_unit || 0);
  const pct = Number(l.disc_percent || 0);
  const subtotal = price * qty;
  const discAmount = subtotal * (pct / 100);
  const netOfTax = subtotal - discAmount;
  const taxAmount = netOfTax * (Number(l.tax_rate || 0) / 100);
  return { subtotal, discAmount, netOfTax, taxAmount, grossAmount: netOfTax + taxAmount };
}

// Mirrors the real "Delivery Ticket" popup, reached from a Sales Order's Bill dropdown
// via DT. Unlike Create SI -- which only lets you delete a line, never edit one -- this
// form is genuinely editable per row (Description/Location/Qty/Price/Unit/Disc.%) and has
// an Add Item button for charges that aren't on the order at all, like a delivery fee.
export default function DeliveryTicketModal({ salesOrderId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [dateDue, setDateDue] = useState('');
  const [term, setTerm] = useState('');
  const [poNo, setPoNo] = useState('');
  const [salesRep, setSalesRep] = useState(null);
  const [officeLocation, setOfficeLocation] = useState(null);
  const [department, setDepartment] = useState(null);
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/delivery-tickets/for-sales-order/${salesOrderId}`),
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/inventory'),
    ]).then(([soRes, empRes, locRes, deptRes, itemRes]) => {
      const d = soRes.data;
      setData(d);
      setEmployees(empRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      setItems(Array.isArray(itemRes.data) ? itemRes.data : (itemRes.data?.rows || []));
      setTerm(d.credit_term || '');
      if (d.sales_rep_id) {
        setSalesRep({
          id: d.sales_rep_id,
          first_name: d.sales_rep_name?.split(' ')[0],
          last_name: d.sales_rep_name?.split(' ').slice(1).join(' '),
        });
      }
      if (d.office_location_id) setOfficeLocation({ id: d.office_location_id, location_name: d.office_location_name });
      setDateDue(addDays(new Date().toISOString().slice(0, 10), 30));
      setRows(d.lines.map((l, idx) => ({ ...l, key: `so-${l.sales_order_line_id ?? idx}` })));
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error || 'Could not load this Sales Order.');
      setLoading(false);
    });
  }, [salesOrderId]);

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    // An ad-hoc charge: no SO line behind it, so it starts blank and inherits only the
    // order's tax code, which is the one thing a new line can't sensibly invent.
    const taxCode = data.lines[0]?.tax_code || null;
    const taxRate = data.lines[0]?.tax_rate || 0;
    setRows((prev) => [...prev, {
      key: `new-${prev.length}-${prev.reduce((s, r) => s + r.key.length, 0)}`,
      sales_order_line_id: null, job_order_no: null, item_id: null, item_name: '',
      description: '', location_id: null, location_name: '', quantity: 1, units: '',
      unit_title: '', price_per_unit: 0, disc_percent: 0, tax_code: taxCode, tax_rate: taxRate,
    }]);
  }

  if (loading) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  const totals = rows.reduce((acc, r) => {
    const a = lineAmounts(r);
    return {
      subtotal: acc.subtotal + a.subtotal,
      discountAmount: acc.discountAmount + a.discAmount,
      netOfTax: acc.netOfTax + a.netOfTax,
      taxAmount: acc.taxAmount + a.taxAmount,
      grossAmount: acc.grossAmount + a.grossAmount,
    };
  }, { subtotal: 0, discountAmount: 0, netOfTax: 0, taxAmount: 0, grossAmount: 0 });

  async function handleSave() {
    setError('');
    const payload = rows.filter((r) => Number(r.quantity) > 0);
    if (!payload.length) { setError('Include at least one item with a quantity.'); return; }
    setSaving(true);
    try {
      const { data: dt } = await api.post('/delivery-tickets', {
        sales_order_id: salesOrderId,
        date_created: dateCreated,
        date_due: dateDue,
        term,
        po_no: poNo,
        sales_rep_id: salesRep?.id || null,
        office_location_id: officeLocation?.id || null,
        department_id: department?.id || null,
        memo,
        lines: payload.map((r) => ({
          sales_order_line_id: r.sales_order_line_id,
          item_id: r.item_id,
          item_name: r.item_name,
          description: r.description,
          location_id: r.location_id,
          quantity: r.quantity,
          units: r.units,
          unit_title: r.unit_title,
          price_per_unit: r.price_per_unit,
          disc_percent: r.disc_percent,
          tax_code: r.tax_code,
        })),
      });
      onSaved(dt);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Delivery Ticket</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div>Customer : <span className="hi">{data?.customer_name}</span></div>
              <div>Created From : <span className="hi">{data?.sales_order_no}</span></div>
              <div className="field">
                <label>Sales Rep</label>
                <EntityPicker
                  label="Sales Rep" items={employees} value={salesRep?.id || ''}
                  getLabel={(e) => `${e.first_name} ${e.last_name}`}
                  columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }]}
                  searchKeys={['first_name', 'last_name']}
                  onSelect={setSalesRep}
                />
              </div>
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setOfficeLocation}
                />
              </div>
              <div className="field">
                <label>Department</label>
                <EntityPicker
                  label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d.name}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                  onSelect={setDepartment}
                />
              </div>
            </div>
            <div>
              <div className="field"><label>Date Due</label><input type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)} /></div>
              <div className="field"><label>Term</label><input value={term} onChange={(e) => setTerm(e.target.value)} /></div>
              <div className="field"><label>PO #</label><input value={poNo} onChange={(e) => setPoNo(e.target.value)} /></div>
              <div className="field"><label>Memo</label><textarea rows={5} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Sub Total</span><span className="hi">{money(totals.subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount Amount</span><span className="hi">{money(totals.discountAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax</span><span className="hi">{money(totals.netOfTax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount</span><span className="hi">{money(totals.taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount</span><span className="hi">{money(totals.grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due</span><span>{money(totals.grossAmount)}</span></div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Location</th><th>Qty</th>
                  <th>Unit</th><th>Unit Title</th><th>Price/Unit</th><th>Subtotal</th><th>Disc.%</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing to deliver. Use Add Item to bill a charge that isn&apos;t on the order.</td></tr>
                )}
                {rows.map((r, idx) => {
                  const a = lineAmounts(r);
                  const selectedLocation = locations.find((l) => String(l.id) === String(r.location_id));
                  return (
                    <tr key={r.key}>
                      <td>{idx + 1}</td>
                      <td>{r.job_order_no || '—'}</td>
                      <td style={{ minWidth: 160 }}>
                        {r.sales_order_line_id ? r.item_name : (
                          <EntityPicker
                            label="Item" items={items} value={r.item_id || ''}
                            getLabel={(i) => i.display_name}
                            columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
                            searchKeys={['item_code', 'display_name']}
                            triggerLabel={r.item_name || 'Select item'}
                            triggerClassName="btn btn-sm"
                            onSelect={(i) => updateRow(r.key, { item_id: i.id, item_name: i.display_name })}
                          />
                        )}
                      </td>
                      <td><input style={{ width: 180 }} value={r.description ?? ''} onChange={(e) => updateRow(r.key, { description: e.target.value })} /></td>
                      <td>
                        <select value={r.location_id || ''} onChange={(e) => updateRow(r.key, { location_id: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">{selectedLocation ? selectedLocation.location_name : '—'}</option>
                          {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
                        </select>
                      </td>
                      <td><input type="number" step="0.0001" style={{ width: 80 }} value={r.quantity ?? ''} onChange={(e) => updateRow(r.key, { quantity: e.target.value })} /></td>
                      <td>{r.units || ''}</td>
                      <td><input style={{ width: 80 }} value={r.unit_title ?? ''} onChange={(e) => updateRow(r.key, { unit_title: e.target.value })} /></td>
                      <td><input type="number" step="0.0001" style={{ width: 100 }} value={r.price_per_unit ?? ''} onChange={(e) => updateRow(r.key, { price_per_unit: e.target.value })} /></td>
                      <td>{money(a.subtotal)}</td>
                      <td><input type="number" step="0.01" style={{ width: 70 }} value={r.disc_percent ?? ''} onChange={(e) => updateRow(r.key, { disc_percent: e.target.value })} /></td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="btn btn-primary" onClick={addRow}>Add Item</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={saving || rows.length === 0} onClick={handleSave}>
                {saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
