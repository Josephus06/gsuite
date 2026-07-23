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

// Mirrors the real "Create SI" popup, reached two ways: from a Sales Order's Bill
// dropdown, or from a Delivery Ticket's own Bill > SI (pass deliveryTicketId). Every line
// is a straight copy of already-computed billing figures -- there's no per-line "amount
// to invoice" input on the real screen, just Delete to exclude a line entirely.
//
// From a Sales Order it bills each line's remaining (Delivered minus already-Invoiced)
// gap. From a Delivery Ticket it bills that ticket's own stored lines verbatim, ad-hoc
// "Add Item" charges included, and converts the ticket -- so the lines are fixed and
// Delete is hidden: you cannot half-convert a ticket.
export default function SalesInvoiceModal({ salesOrderId, deliveryTicketId, onClose, onSaved }) {
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

  const fromTicket = Boolean(deliveryTicketId);

  useEffect(() => {
    const source = fromTicket
      ? `/sales-invoices/for-delivery-ticket/${deliveryTicketId}`
      : `/sales-invoices/for-sales-order/${salesOrderId}`;
    Promise.all([
      api.get(source),
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
    ]).then(([srcRes, empRes, locRes, deptRes]) => {
      const d = srcRes.data;
      setData(d);
      setEmployees(empRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      setBillToAddress(d.shipping_address || '');
      // A ticket already carries its own Term/PO #/Memo, chosen when it was raised --
      // carry them onto the invoice rather than falling back to the customer's default.
      setTerm(d.term || d.credit_term || '');
      setPoNo(d.po_no || '');
      setMemo(d.memo || '');
      if (d.sales_rep_id) setSalesRep({ id: d.sales_rep_id, first_name: d.sales_rep_name?.split(' ')[0], last_name: d.sales_rep_name?.split(' ').slice(1).join(' ') });
      if (d.office_location_id) setOfficeLocation({ id: d.office_location_id, location_name: d.office_location_name });
      if (d.department_id) setDepartment({ id: d.department_id, name: d.department_name });
      setDateDue(addDays(new Date().toISOString().slice(0, 10), 30));
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error || 'Could not load this record.');
      setLoading(false);
    });
  }, [salesOrderId, deliveryTicketId, fromTicket]);

  if (loading || (!data && !error)) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-xl">
          <div className="error-banner">{error}</div>
          <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  // A ticket-sourced line may be an ad-hoc charge with no sales_order_line_id at all, so
  // it needs its own key; SO-sourced lines keep using theirs.
  const lineKey = (l, idx) => l.delivery_ticket_line_id ?? l.sales_order_line_id ?? idx;
  const includedLines = data.lines.filter((l, idx) => !excludedIds.has(lineKey(l, idx)));
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
        // Billing a ticket sends its id and nothing about lines -- the server bills the
        // ticket in full, which is what converting it means.
        ...(fromTicket
          ? { delivery_ticket_id: deliveryTicketId, sales_order_id: data.sales_order_id }
          : { sales_order_line_ids: includedLines.map((l) => l.sales_order_line_id) }),
        sales_order_id: fromTicket ? data.sales_order_id : salesOrderId,
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
          <h2 style={{ margin: 0, color: '#fff' }}>{fromTicket ? `Create SI from ${data.dt_no}` : 'Create SI'}</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div className="field"><label>Date Due</label><input type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)} /></div>
              <div>Customer : <span className="hi">{data.customer_name}</span></div>
              <div>Created Form : <span className="hi">{fromTicket ? `${data.dt_no} (${data.sales_order_no})` : data.sales_order_no}</span></div>
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
                  const key = lineKey(l, idx);
                  const excluded = excludedIds.has(key);
                  return (
                    <tr key={key} style={excluded ? { opacity: 0.4, textDecoration: 'line-through' } : undefined}>
                      <td>{idx + 1}</td>
                      <td>{l.job_order_no || '—'}</td>
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
                        {/* Converting a ticket bills it whole -- there is no partial
                            conversion, so excluding a line isn't offered here. */}
                        {!fromTicket && (
                          <button
                            type="button" className="btn btn-sm"
                            onClick={() => setExcludedIds((prev) => {
                              const next = new Set(prev);
                              if (excluded) next.delete(key); else next.add(key);
                              return next;
                            })}
                          >
                            {excluded ? 'Undo' : 'Delete'}
                          </button>
                        )}
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
