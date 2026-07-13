import { useEffect, useMemo, useState } from 'react';
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
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function wtaxLabel(w) { return w ? `${w.code} — ${w.name} (${w.rate}%)` : ''; }

// price_per_unit/disc_percent/tax rate are fixed per-unit rates -- Total Disc/Net of
// Tax/Tax Amt/Ext Price are recomputed live off qty x unit_price, mirroring the real
// Create Vendor Bill modal's instant recalculation. This is display-only: the backend
// recomputes everything again from scratch on Save and never trusts these numbers.
function computeLine(l, wtaxRate) {
  const q = Number(l.qty) || 0;
  const unitPrice = Number(l.unit_price) || 0;
  const discPercent = Number(l.disc_percent) || 0;
  const taxRate = Number(l.tax_rate) || 0;
  const subtotal = q * unitPrice;
  const discAmount = subtotal * (discPercent / 100);
  const netOfTax = subtotal - discAmount;
  const taxAmount = netOfTax * (taxRate / 100);
  const extPrice = netOfTax + taxAmount;
  const wtaxAmount = l.is_withhold ? netOfTax * (Number(wtaxRate || 0) / 100) : 0;
  return { disc_amount: discAmount, net_of_tax: netOfTax, tax_amount: taxAmount, ext_price: extPrice, wtax_amount: wtaxAmount, amount_due: extPrice - wtaxAmount };
}

// Mirrors the real "Create Vendor Bill" popup, reached from a Received Purchase Order's
// "Bill" button -- confirmed field-for-field against the live system. Every line is
// pre-populated from its PO line's still-billable qty (RR Qty - Billed Qty); Rate is a
// read-only snapshot of the PO's own rate, Unit Price is independently editable (defaults
// to the same value) since the actual vendor price at billing time can differ.
export default function VendorBillModal({ purchaseOrderId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [referenceNo, setReferenceNo] = useState('');
  const [account, setAccount] = useState(null);
  const [officeLocation, setOfficeLocation] = useState(null);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  const [tab, setTab] = useState('items');
  const [wtax, setWtax] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [withholdingTaxes, setWithholdingTaxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/vendor-bills/for-purchase-order/${purchaseOrderId}`),
      api.get('/lookups/chart-of-accounts'),
      api.get('/lookups/locations'),
      api.get('/lookups/withholding-taxes'),
    ]).then(([poRes, acctRes, locRes, wtaxRes]) => {
      const d = poRes.data;
      setData(d);
      setAccounts(acctRes.data);
      setLocations(locRes.data);
      setWithholdingTaxes(wtaxRes.data);
      setMemo(d.memo || '');
      if (d.default_account) setAccount(d.default_account);
      setLines(d.lines.map((l) => ({ ...l, is_withhold: false })));
      setLoading(false);
    });
  }, [purchaseOrderId]);

  const wtaxRate = wtax ? Number(wtax.rate) : 0;
  const dateDue = data ? addDays(dateCreated, data.no_of_days) : '';

  const computedLines = useMemo(() => lines.map((l) => ({ ...l, ...computeLine(l, wtaxRate) })), [lines, wtaxRate]);

  if (loading || !data) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  const subtotal = computedLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const discountAmount = computedLines.reduce((s, l) => s + l.disc_amount, 0);
  const netOfTax = computedLines.reduce((s, l) => s + l.net_of_tax, 0);
  const taxAmount = computedLines.reduce((s, l) => s + l.tax_amount, 0);
  const grossAmount = computedLines.reduce((s, l) => s + l.ext_price, 0);
  const wtaxAmount = computedLines.reduce((s, l) => s + l.wtax_amount, 0);
  const amountDue = grossAmount - wtaxAmount;

  function updateLine(purchaseOrderLineId, patch) {
    setLines((prev) => prev.map((l) => (l.purchase_order_line_id === purchaseOrderLineId ? { ...l, ...patch } : l)));
  }

  async function handleSave() {
    setError('');
    if (!lines.length) { setError('Nothing to bill.'); return; }
    setSaving(true);
    try {
      const { data: vb } = await api.post('/vendor-bills', {
        purchase_order_id: purchaseOrderId,
        date_created: dateCreated,
        date_due: dateDue,
        term: data.term_name,
        reference_no: referenceNo,
        account_id: account?.id || null,
        office_location_id: officeLocation?.id || null,
        memo,
        wtax_id: wtax?.id || null,
        lines: lines.map((l) => ({
          purchase_order_line_id: l.purchase_order_line_id,
          qty: l.qty,
          unit_price: l.unit_price,
          disc_percent: l.disc_percent,
          is_withhold: l.is_withhold,
        })),
      });
      onSaved(vb);
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
          <h2 style={{ margin: 0, color: '#fff' }}>Create Vendor Bill</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div className="field"><label>Date Due</label><input readOnly tabIndex={-1} value={dateDue} /></div>
              <div>Vendor : <span className="hi">{data.supplier_name}</span></div>
              <div>Created Form : <span className="hi">{data.po_no}</span></div>
              <div className="field">
                <label>Reference #</label>
                <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
              </div>
            </div>
            <div>
              <div className="field">
                <label>Account</label>
                <EntityPicker
                  label="Account" items={accounts} value={account?.id || ''} getLabel={accountLabel}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
                  searchKeys={['account_code', 'account_name']}
                  onSelect={setAccount}
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
              <div className="field"><label>Term</label><input readOnly tabIndex={-1} value={data.term_name || ''} /></div>
              <div className="field"><label>Memo</label><textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Sub Total</span><span className="hi">{money(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount Amount</span><span className="hi">{money(discountAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax</span><span className="hi">{money(netOfTax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount</span><span className="hi">{money(taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount</span><span className="hi">{money(grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Withholding Tax Amount</span><span className="hi">{money(wtaxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Amount</span><span className="hi">{money(grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due</span><span>{money(amountDue)}</span></div>
            </div>
          </div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
            <button className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax {money(wtaxAmount)}</button>
          </div>

          {tab === 'items' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item Code</th><th>Purchase Desc.</th><th>Location</th><th>Department</th>
                    <th>RR Qty</th><th>Billed Qty</th><th>Qty to Bill</th><th>Purchase Unit</th>
                    <th>Rate</th><th>Unit Price</th><th>Discount %</th><th>Total Disc. Amt.</th>
                    <th>Total Amt. (Net of Tax)</th><th>Tax Code</th><th>Tax Amt.</th><th>Ext. Price</th>
                    <th>Apply Withholding Tax</th><th>Withholding Tax Amount</th><th>Amount Due</th>
                  </tr>
                </thead>
                <tbody>
                  {computedLines.length === 0 && (
                    <tr><td colSpan={19} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing left to bill.</td></tr>
                  )}
                  {computedLines.map((l) => (
                    <tr key={l.purchase_order_line_id}>
                      <td>{l.item_code} {l.item_name ? `— ${l.item_name}` : ''}</td>
                      <td>{l.purchase_description}</td>
                      <td>{l.location_name}</td>
                      <td>{l.department_name}</td>
                      <td>{qty(l.rr_qty)}</td>
                      <td>{qty(l.billed_qty)}</td>
                      <td>
                        <input
                          type="number" step="0.0001" style={{ width: 90 }}
                          value={l.qty}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { qty: e.target.value })}
                        />
                      </td>
                      <td>{l.unit_title}</td>
                      <td>{money(l.rate)}</td>
                      <td>
                        <input
                          type="number" step="0.00001" style={{ width: 100 }}
                          value={l.unit_price}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { unit_price: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="number" step="0.01" style={{ width: 70 }}
                          value={l.disc_percent}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { disc_percent: e.target.value })}
                        />
                      </td>
                      <td>{money(l.disc_amount)}</td>
                      <td>{money(l.net_of_tax)}</td>
                      <td>{l.tax_code}</td>
                      <td>{money(l.tax_amount)}</td>
                      <td>{money(l.ext_price)}</td>
                      <td>
                        <input
                          type="checkbox" checked={!!l.is_withhold}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { is_withhold: e.target.checked })}
                        />
                      </td>
                      <td>{money(l.wtax_amount)}</td>
                      <td>{money(l.amount_due)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'wtax' && (
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
              <div className="field">
                <label>Withholding Tax</label>
                <EntityPicker
                  label="Withholding Tax" items={withholdingTaxes} value={wtax?.id || ''} getLabel={wtaxLabel}
                  columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate %' }]}
                  searchKeys={['code', 'name']}
                  onSelect={setWtax}
                />
              </div>
              <div className="field"><label>Withholding Tax Description</label><input readOnly tabIndex={-1} value={wtax?.name || ''} /></div>
              <div className="field"><label>Withholding Tax Amount</label><input readOnly tabIndex={-1} value={money(wtaxAmount)} /></div>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || computedLines.length === 0} onClick={handleSave}>
              {saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
