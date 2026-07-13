import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Mirrors the real standalone "Purchase Order > Create" form (reached without going
// through a Purchase Requisition) -- the PO Category choice decides whether lines can
// carry a Job Order (PO-3) or not (PO-4).
export default function PurchaseOrderCreate() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState([]);
  const [terms, setTerms] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [jobOrders, setJobOrders] = useState([]);
  const [serviceItems, setServiceItems] = useState([]);

  const [poCategory, setPoCategory] = useState('');
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [needByDate, setNeedByDate] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [termId, setTermId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/suppliers'),
      api.get('/lookups/payment-terms'),
      api.get('/lookups/taxes'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/job-orders', { params: { limit: 1000 } }),
      api.get('/inventory', { params: { item_type: 'Service' } }),
    ]).then(([supRes, termRes, taxRes, locRes, deptRes, joRes, svcRes]) => {
      setSuppliers(supRes.data);
      setTerms(termRes.data);
      setTaxes(taxRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      setJobOrders(joRes.data.rows || []);
      setServiceItems(svcRes.data);
    });
  }, []);

  function addLine(item) {
    setLines((prev) => [...prev, {
      _key: `new-${Date.now()}`,
      item_id: item.id, item_code: item.item_code, item_name: item.display_name,
      purchase_description: item.display_name, location_id: '', department_id: '', job_order_id: '',
      qty: 1, purchase_unit: item.base_unit_title || '', unit_title: item.base_unit_title || '',
      rate: 0, disc_percent: 0, tax_code_id: '', memo: '',
    }]);
  }

  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key) {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }

  function lineCalc(l) {
    const qty = Number(l.qty || 0);
    const rate = Number(l.rate || 0);
    const subtotal = qty * rate;
    const discAmount = subtotal * (Number(l.disc_percent || 0) / 100);
    const netOfTax = subtotal - discAmount;
    const tax = taxes.find((t) => t.id === l.tax_code_id);
    const taxAmount = netOfTax * (Number(tax?.rate || 0) / 100);
    return { extPrice: netOfTax + taxAmount };
  }

  const grandTotal = lines.reduce((s, l) => s + lineCalc(l).extPrice, 0);

  async function handleSave() {
    setError('');
    if (!poCategory) { setError('Select a PO Category.'); return; }
    if (!supplierId) { setError('Select a Supplier.'); return; }
    if (!lines.length) { setError('Add at least one Material.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/purchase-orders/direct', {
        po_category: poCategory,
        date_created: dateCreated,
        need_by_date: needByDate || null,
        supplier_id: supplierId,
        term_id: termId || null,
        ref_no: refNo || null,
        memo,
        lines: lines.map((l) => ({
          item_id: l.item_id, purchase_description: l.purchase_description,
          location_id: l.location_id || null, department_id: l.department_id || null,
          job_order_id: poCategory === 'PO3' ? (l.job_order_id || null) : null,
          memo: l.memo || null, qty: l.qty, purchase_unit: l.purchase_unit, unit_title: l.unit_title,
          rate: l.rate, disc_percent: l.disc_percent, tax_code_id: l.tax_code_id || null,
        })),
      });
      navigate(`/purchase-orders/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Purchase Order — Create</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate('/purchase-orders')}>Back to Lists</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
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
            <label>Need by Date</label>
            <input type="date" value={needByDate} onChange={(e) => setNeedByDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Supplier</label>
            <EntityPicker
              label="Supplier" items={suppliers} value={supplierId} getLabel={(s) => s?.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
              onSelect={(s) => setSupplierId(s.id)}
            />
          </div>
          <div className="field">
            <label>Reference #</label>
            <input value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          </div>
          <div className="field">
            <label>Memo</label>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
          <div className="field">
            <label>Term</label>
            <EntityPicker
              label="Term" items={terms} value={termId} getLabel={(t) => t?.term_name}
              columns={[{ key: 'term_name', label: 'Term' }]} searchKeys={['term_name']}
              onSelect={(t) => setTermId(t.id)}
            />
          </div>
          <div className="field">
            <label>PO Category</label>
            <select value={poCategory} onChange={(e) => setPoCategory(e.target.value)}>
              <option value="">--Select--</option>
              <option value="PO3">Services with JO</option>
              <option value="PO4">Services/Non-Inventory without JO</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item Code</th><th>Purchase Desc.</th><th>Location</th>
                {poCategory === 'PO3' && <th>JO #</th>}
                <th>PO Qty</th><th>Purchase Unit</th><th>Rate</th><th>Discount %</th>
                <th>Tax Code</th><th>Department</th><th>Memo</th><th>Ext. Price</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={poCategory === 'PO3' ? 13 : 12} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  {poCategory ? 'No materials yet.' : 'Select a PO Category first.'}
                </td></tr>
              )}
              {lines.map((l) => {
                const calc = lineCalc(l);
                return (
                  <tr key={l._key}>
                    <td>{l.item_code} — {l.item_name}</td>
                    <td><input style={{ width: 150 }} value={l.purchase_description} onChange={(e) => updateLine(l._key, { purchase_description: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Location" items={locations} value={l.location_id} getLabel={(loc) => loc?.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                        onSelect={(loc) => updateLine(l._key, { location_id: loc.id })}
                      />
                    </td>
                    {poCategory === 'PO3' && (
                      <td>
                        <EntityPicker
                          label="Job Order" items={jobOrders} value={l.job_order_id} getLabel={(jo) => jo?.job_order_no}
                          columns={[{ key: 'job_order_no', label: 'JO #' }]} searchKeys={['job_order_no']}
                          onSelect={(jo) => updateLine(l._key, { job_order_id: jo.id })}
                        />
                      </td>
                    )}
                    <td><input type="number" step="0.0001" style={{ width: 80 }} value={l.qty} onChange={(e) => updateLine(l._key, { qty: e.target.value })} /></td>
                    <td><input style={{ width: 90 }} value={l.purchase_unit} onChange={(e) => updateLine(l._key, { purchase_unit: e.target.value })} /></td>
                    <td><input type="number" step="0.01" style={{ width: 90 }} value={l.rate} onChange={(e) => updateLine(l._key, { rate: e.target.value })} /></td>
                    <td><input type="number" step="0.01" style={{ width: 70 }} value={l.disc_percent} onChange={(e) => updateLine(l._key, { disc_percent: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Tax Code" items={taxes} value={l.tax_code_id} getLabel={(t) => t?.code}
                        columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate' }]} searchKeys={['code']}
                        onSelect={(t) => updateLine(l._key, { tax_code_id: t.id })}
                      />
                    </td>
                    <td>
                      <EntityPicker
                        label="Department" items={departments} value={l.department_id} getLabel={(d) => d?.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                        onSelect={(d) => updateLine(l._key, { department_id: d.id })}
                      />
                    </td>
                    <td><input style={{ width: 120 }} value={l.memo} onChange={(e) => updateLine(l._key, { memo: e.target.value })} /></td>
                    <td>{money(calc.extPrice)}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => removeLine(l._key)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10 }}>
          <EntityPicker
            label="Service Item" items={serviceItems} value="" getLabel={(i) => i.display_name}
            columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
            searchKeys={['item_code', 'display_name']}
            onSelect={addLine}
            triggerLabel="Add Service Item"
            triggerClassName="btn btn-primary"
            disabled={!poCategory}
          />
        </div>

        {lines.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <div className="hi-lg">Total: {money(grandTotal)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
