import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Mirrors the real "Create SI" popup, reached from a Sales Order's Bill dropdown. Every
// line is a straight copy of that sales_order_line's own already-computed billing
// figures -- there's no per-line "amount to invoice" input on the real screen, just
// Delete to exclude a line entirely, so this only ever bills a line's full remaining
// (Delivered minus already-Invoiced) gap in one shot.
export default function SalesInvoiceModal({ salesOrderId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [dateDue, setDateDue] = useState('');
  const [term, setTerm] = useState('');
  const [bsSiNo, setBsSiNo] = useState('');
  const [poNo, setPoNo] = useState('');
  const [salesRep, setSalesRep] = useState(null);
  const [officeLocation, setOfficeLocation] = useState(null);
  const [department, setDepartment] = useState(null);
  const [billToAddress, setBillToAddress] = useState('');
  const [memo, setMemo] = useState('');
  const [withholdingPct, setWithholdingPct] = useState(0);
  const [excludedIds, setExcludedIds] = useState(new Set());
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/sales-invoices/for-sales-order/${salesOrderId}`),
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
    ]).then(([soRes, empRes, locRes, deptRes]) => {
      const d = soRes.data;
      setData(d);
      setEmployees(empRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      setBillToAddress(d.shipping_address || '');
      setTerm(d.credit_term || '');
      if (d.sales_rep_id) setSalesRep({ id: d.sales_rep_id, first_name: d.sales_rep_name?.split(' ')[0], last_name: d.sales_rep_name?.split(' ').slice(1).join(' ') });
      if (d.office_location_id) setOfficeLocation({ id: d.office_location_id, location_name: d.office_location_name });
      setDateDue(addDays(new Date().toISOString().slice(0, 10), 30));
      setLoading(false);
    });
  }, [salesOrderId]);

  if (loading || !data) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  const includedLines = data.lines.filter((l) => !excludedIds.has(l.sales_order_line_id));
  const subtotal = includedLines.reduce((s, l) => s + Number(l.subtotal || 0), 0);
  const discountAmount = includedLines.reduce((s, l) => s + Number(l.disc_amount || 0), 0);
  const netOfTax = includedLines.reduce((s, l) => s + Number(l.net_of_tax || 0), 0);
  const taxAmount = includedLines.reduce((s, l) => s + Number(l.tax_amount || 0), 0);
  const grossAmount = includedLines.reduce((s, l) => s + Number(l.gross_amount || 0), 0);
  const ewtAmount = netOfTax * (withholdingPct / 100);
  const amountDue = grossAmount - ewtAmount;

  async function handleSave() {
    setError('');
    if (!includedLines.length) { setError('Include at least one item.'); return; }
    setSaving(true);
    try {
      const { data: si } = await api.post('/sales-invoices', {
        sales_order_id: salesOrderId,
        date_created: dateCreated,
        date_due: dateDue,
        term,
        bs_si_no: bsSiNo,
        po_no: poNo,
        sales_rep_id: salesRep?.id || null,
        office_location_id: officeLocation?.id || null,
        department_id: department?.id || null,
        bill_to_address: billToAddress,
        memo,
        withholding_tax_pct: withholdingPct,
        sales_order_line_ids: includedLines.map((l) => l.sales_order_line_id),
      });
      onSaved(si);
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
          <h2 style={{ margin: 0, color: '#fff' }}>Create SI</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div className="field"><label>Date Due</label><input type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)} /></div>
              <div>Customer : <span className="hi">{data.customer_name}</span></div>
              <div>Created Form : <span className="hi">{data.sales_order_no}</span></div>
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
              <div className="field-checkbox" style={{ marginTop: 8 }}>
                <label style={{ marginRight: 12 }}>Withholding Tax</label>
                {[1, 2, 5].map((pct) => (
                  <label key={pct} style={{ marginRight: 12, fontWeight: 400 }}>
                    <input
                      type="checkbox" checked={withholdingPct === pct}
                      onChange={() => setWithholdingPct(withholdingPct === pct ? 0 : pct)}
                    /> {pct}%
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="field"><label>Term</label><input value={term} onChange={(e) => setTerm(e.target.value)} /></div>
              <div className="field"><label>BS/SI #</label><input value={bsSiNo} onChange={(e) => setBsSiNo(e.target.value)} /></div>
              <div className="field"><label>PO #</label><input value={poNo} onChange={(e) => setPoNo(e.target.value)} /></div>
              <div className="field"><label>Bill to Address</label><input value={billToAddress} onChange={(e) => setBillToAddress(e.target.value)} /></div>
              <div className="field"><label>Memo</label><textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Sub Total</span><span className="hi">{money(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount Amount</span><span className="hi">{money(discountAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax</span><span className="hi">{money(netOfTax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Expanded Withholding Tax</span><span className="hi">{money(ewtAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount</span><span className="hi">{money(taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount</span><span className="hi">{money(grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due</span><span>{money(amountDue)}</span></div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Location</th><th>Qty</th><th>Unit</th>
                  <th>Price/Unit</th><th>Subtotal</th><th>Disc.%</th><th>Disc. Amt</th><th>Disc. Price/Unit</th>
                  <th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr><td colSpan={17} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing left to invoice.</td></tr>
                )}
                {data.lines.map((l, idx) => {
                  const excluded = excludedIds.has(l.sales_order_line_id);
                  return (
                    <tr key={l.sales_order_line_id} style={excluded ? { opacity: 0.4, textDecoration: 'line-through' } : undefined}>
                      <td>{idx + 1}</td>
                      <td>{l.job_order_no}</td>
                      <td>{l.item_name}</td>
                      <td>{l.description}</td>
                      <td>{l.job_location_name}</td>
                      <td>{qty(l.quantity)}</td>
                      <td>{l.units}</td>
                      <td>{money(l.price_per_unit)}</td>
                      <td>{money(l.subtotal)}</td>
                      <td>{l.disc_percent}</td>
                      <td>{money(l.disc_amount)}</td>
                      <td>{money(l.disc_price_per_unit)}</td>
                      <td>{money(l.net_of_tax)}</td>
                      <td>{l.tax_code}</td>
                      <td>{money(l.tax_amount)}</td>
                      <td>{money(l.gross_amount)}</td>
                      <td>
                        <button
                          type="button" className="btn btn-sm"
                          onClick={() => setExcludedIds((prev) => {
                            const next = new Set(prev);
                            if (excluded) next.delete(l.sales_order_line_id); else next.add(l.sales_order_line_id);
                            return next;
                          })}
                        >
                          {excluded ? 'Undo' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || includedLines.length === 0} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
