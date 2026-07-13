import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Mirrors the real "Placing Order Form" -- reached from Purchasing > Place Order Form.
// Simplified version of the real Canvass step: no Supplier Price history comparison or
// "not the lowest price, pick a reason" justification yet (see schema.sql note on
// purchase_orders for why), just a straightforward per-line Supplier/Rate/Discount/Tax
// entry. Saving splits the grid into one PO per distinct Supplier, same as the real form.
export default function PlaceOrderForm() {
  const navigate = useNavigate();
  const [showPicker, setShowPicker] = useState(false);
  const [openPRs, setOpenPRs] = useState([]);
  const [pickerSearch, setPickerSearch] = useState('');
  const [selectedPrIds, setSelectedPrIds] = useState(new Set());
  const [rows, setRows] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/suppliers').then(({ data }) => setSuppliers(data)).catch(() => {});
    api.get('/lookups/taxes').then(({ data }) => setTaxes(data)).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
    api.get('/lookups/departments').then(({ data }) => setDepartments(data)).catch(() => {});
  }, []);

  async function openPicker() {
    setShowPicker(true);
    const { data } = await api.get('/purchase-requisitions', { params: {} });
    setOpenPRs(data.filter((pr) => pr.item_status !== 'FULLY ORDERED' && pr.status !== 'cancelled'));
  }

  function togglePr(id) {
    setSelectedPrIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleDone() {
    setShowPicker(false);
    if (!selectedPrIds.size) return;
    const { data } = await api.get('/purchase-orders/canvass-lines', { params: { pr_ids: [...selectedPrIds].join(',') } });
    setRows((prev) => [
      ...prev,
      ...data
        .filter((l) => !prev.some((p) => p.purchase_requisition_line_id === l.purchase_requisition_line_id))
        .map((l) => ({ ...l, po_qty_input: l.remaining, supplier_id: '', supplier_name: '', rate: 0, disc_percent: 0, tax_code_id: '', tax_code: '', location_id: '', department_id: '' })),
    ]);
  }

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.purchase_requisition_line_id === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key) {
    setRows((prev) => prev.filter((r) => r.purchase_requisition_line_id !== key));
  }

  function lineCalc(r) {
    const q = Number(r.po_qty_input || 0);
    const rate = Number(r.rate || 0);
    const subtotal = q * rate;
    const discAmount = subtotal * (Number(r.disc_percent || 0) / 100);
    const netOfTax = subtotal - discAmount;
    const tax = taxes.find((t) => t.id === r.tax_code_id);
    const taxAmount = netOfTax * (Number(tax?.rate || 0) / 100);
    return { subtotal, discAmount, netOfTax, taxAmount, extPrice: netOfTax + taxAmount };
  }

  const grandTotal = rows.reduce((s, r) => s + lineCalc(r).extPrice, 0);

  async function handleCreate() {
    setError('');
    const submitRows = rows.filter((r) => Number(r.po_qty_input) > 0 && r.supplier_id);
    if (!submitRows.length) { setError('Enter a Qty and pick a Supplier for at least one line.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/purchase-orders', {
        date_created: dateCreated,
        memo,
        lines: submitRows.map((r) => ({
          purchase_requisition_line_id: r.purchase_requisition_line_id,
          item_id: r.item_id,
          purchase_description: r.purchase_description,
          location_id: r.location_id || null,
          department_id: r.department_id || null,
          qty: r.po_qty_input,
          purchase_unit: r.purchase_unit,
          unit_title: r.unit_title,
          supplier_id: r.supplier_id,
          rate: r.rate,
          disc_percent: r.disc_percent,
          tax_code_id: r.tax_code_id || null,
        })),
      });
      if (data.length === 1) navigate(`/purchase-orders/${data[0].id}`);
      else navigate('/purchase-orders');
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Placing Order Form</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate('/purchase-orders')}>Purchase Orders</button>
          <button className="btn btn-primary" onClick={openPicker}>Select Purchase Requisitions</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
          </div>
          <div className="field">
            <label>Memo</label>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Canvass</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>PR #</th><th>Item</th><th>Location</th><th>Department</th><th>On Hand</th><th>PR Qty</th><th>POed Qty</th><th>PO Qty</th>
                <th>Unit</th><th>Supplier</th><th>Rate</th><th>Disc %</th><th>Tax Code</th><th>Ext. Price</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={15} className="muted" style={{ textAlign: 'center', padding: 20 }}>Select Purchase Requisitions to start canvassing.</td></tr>
              )}
              {rows.map((r) => {
                const calc = lineCalc(r);
                return (
                  <tr key={r.purchase_requisition_line_id}>
                    <td>{r.pr_no}</td>
                    <td>{r.item_code} — {r.item_name}</td>
                    <td>
                      <EntityPicker
                        label="Location" items={locations} value={r.location_id} getLabel={(loc) => loc?.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                        onSelect={(loc) => updateRow(r.purchase_requisition_line_id, { location_id: loc.id })}
                      />
                    </td>
                    <td>
                      <EntityPicker
                        label="Department" items={departments} value={r.department_id} getLabel={(d) => d?.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                        onSelect={(d) => updateRow(r.purchase_requisition_line_id, { department_id: d.id })}
                      />
                    </td>
                    <td>{qty(r.qty_on_hand)}</td>
                    <td>{qty(r.qty)}</td>
                    <td>{qty(r.po_qty)}</td>
                    <td>
                      <input
                        type="number" step="0.0001" max={r.remaining} style={{ width: 90 }}
                        value={r.po_qty_input} onChange={(e) => updateRow(r.purchase_requisition_line_id, { po_qty_input: e.target.value })}
                      />
                    </td>
                    <td>{r.purchase_unit}</td>
                    <td>
                      <EntityPicker
                        label="Supplier" items={suppliers} value={r.supplier_id} getLabel={(s) => s.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                        onSelect={(s) => updateRow(r.purchase_requisition_line_id, { supplier_id: s.id, supplier_name: s.name })}
                      />
                    </td>
                    <td>
                      <input type="number" step="0.01" style={{ width: 90 }} value={r.rate} onChange={(e) => updateRow(r.purchase_requisition_line_id, { rate: e.target.value })} />
                    </td>
                    <td>
                      <input type="number" step="0.01" style={{ width: 70 }} value={r.disc_percent} onChange={(e) => updateRow(r.purchase_requisition_line_id, { disc_percent: e.target.value })} />
                    </td>
                    <td>
                      <EntityPicker
                        label="Tax Code" items={taxes} value={r.tax_code_id} getLabel={(t) => t.code}
                        columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate' }]} searchKeys={['code']}
                        onSelect={(t) => updateRow(r.purchase_requisition_line_id, { tax_code_id: t.id, tax_code: t.code })}
                      />
                    </td>
                    <td>{money(calc.extPrice)}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => removeRow(r.purchase_requisition_line_id)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rows.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <div className="hi-lg">Total: {money(grandTotal)}</div>
            <button className="btn btn-primary" disabled={saving} onClick={handleCreate}>Create Purchase Order(s)</button>
          </div>
        )}
      </div>

      {showPicker && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setShowPicker(false)}>
          <div className="modal modal-lg" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, color: '#fff' }}>Purchase Requisitions</h2>
              <button type="button" onClick={() => setShowPicker(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ padding: 24 }}>
              <input placeholder="Search" value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} style={{ marginBottom: 16, maxWidth: 320 }} />
              <div className="table-wrap">
                <table>
                  <thead><tr><th></th><th>PR #</th><th>Date Created</th><th>Requested From</th><th>Requestor</th><th>Status</th><th>Item Status</th></tr></thead>
                  <tbody>
                    {openPRs
                      .filter((pr) => !pickerSearch || pr.pr_no.toLowerCase().includes(pickerSearch.toLowerCase()))
                      .map((pr) => (
                        <tr key={pr.id} className="picker-row" style={{ cursor: 'pointer' }} onClick={() => togglePr(pr.id)}>
                          <td><input type="checkbox" checked={selectedPrIds.has(pr.id)} readOnly /></td>
                          <td>{pr.pr_no}</td>
                          <td>{String(pr.date_created).slice(0, 10)}</td>
                          <td>{pr.department_name}</td>
                          <td>{pr.requestor_name}</td>
                          <td>{pr.status}</td>
                          <td>{pr.item_status}</td>
                        </tr>
                      ))}
                    {openPRs.length === 0 && (
                      <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No open Purchase Requisitions.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={handleDone}>Done</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
