import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';

// Credit Memos > Add: a credit memo on its own, for a customer, with no source invoice -- the old
// system's "CREDIT MEMO / Create" screen. Header (Date Created, Customer, Office Location, Memo,
// Applied / Unapplied), the totals panel, and two tabs: ITEMS (Add Item opens the Materials list)
// and APPLY (the customer's open invoices). The same server route as the invoice's Credit Memo
// button saves it; the line arithmetic mirrors computeLineAmounts there.
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('en-CA');

function lineAmounts(l) {
  const qty = Number(l.quantity || 0);
  const price = Number(l.price_per_unit || 0);
  const pct = Number(l.disc_percent || 0);
  const subtotal = price * qty;
  const discAmount = subtotal * (pct / 100);
  const discPerUnit = price * (pct / 100);
  const netOfTax = subtotal - discAmount;
  const taxAmount = netOfTax * (Number(l.tax_rate || 0) / 100);
  return { subtotal, discAmount, discPerUnit, discPricePerUnit: price - discPerUnit, netOfTax, taxAmount, grossAmount: netOfTax + taxAmount };
}

export default function CreditMemoForm() {
  const navigate = useNavigate();
  const [lookups, setLookups] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [source, setSource] = useState(null); // for-customer: open invoices, A/R account
  const [location, setLocation] = useState(null);
  const [dateCreated, setDateCreated] = useState(today());
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState([]);
  const [applyAmounts, setApplyAmounts] = useState({});
  const [tab, setTab] = useState('items');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/customers'), api.get('/lookups/locations'), api.get('/lookups/departments'),
      api.get('/inventory'), api.get('/lookups/taxes'),
    ]).then(([c, l, d, i, t]) => {
      const locations = l.data;
      setLookups({
        customers: Array.isArray(c.data) ? c.data : (c.data?.rows || []), locations, departments: d.data,
        items: Array.isArray(i.data) ? i.data : (i.data?.rows || []), taxes: t.data,
      });
      setLocation(locations.find((x) => /head office/i.test(x.location_name)) || null);
    }).catch((e) => setError(e.response?.data?.error || 'Could not load the form.'));
  }, []);

  useEffect(() => {
    if (!customer) { setSource(null); return; }
    setApplyAmounts({});
    api.get(`/credit-memos/for-customer/${customer.id}`).then((r) => setSource(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the customer’s invoices.'));
  }, [customer]);

  const totals = useMemo(() => rows.reduce((acc, r) => {
    const a = lineAmounts(r);
    return {
      subtotal: acc.subtotal + a.subtotal, discountAmount: acc.discountAmount + a.discAmount, netOfTax: acc.netOfTax + a.netOfTax,
      taxAmount: acc.taxAmount + a.taxAmount, grossAmount: acc.grossAmount + a.grossAmount,
    };
  }, { subtotal: 0, discountAmount: 0, netOfTax: 0, taxAmount: 0, grossAmount: 0 }), [rows]);
  const applied = Object.values(applyAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const unapplied = totals.grossAmount - applied;

  if (!lookups) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const defaultTax = lookups.taxes.find((t) => /VAT/i.test(t.code)) || lookups.taxes[0];

  const updateRow = (key, patch) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  function addItem(item) {
    setRows((prev) => [...prev, {
      key: `r${Date.now()}${prev.length}`, item_id: item.id, item_name: item.display_name, item_code: item.item_code,
      description: item.sales_description || item.display_name, department_id: null, quantity: 1, units: '',
      price_per_unit: Number(item.selling_price) || 0, disc_percent: 0,
      tax_code: defaultTax?.code || null, tax_rate: Number(defaultTax?.rate) || 0,
    }]);
  }

  async function save() {
    setError('');
    if (!customer) { setError('Choose the Customer.'); return; }
    const lines = rows.filter((r) => Number(r.quantity) > 0);
    if (!lines.length) { setError('Add at least one item to credit.'); return; }
    if (applied > totals.grossAmount + 0.005) { setError(`Applied (${money(applied)}) exceeds this Credit Memo's total (${money(totals.grossAmount)}).`); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/credit-memos', {
        customer_id: customer.id, date_created: dateCreated, office_location_id: location?.id || null,
        ar_account_id: source?.ar_account_id || null, memo,
        lines: lines.map((r) => ({
          item_id: r.item_id, item_name: r.item_name, description: r.description, department_id: r.department_id,
          quantity: r.quantity, units: r.units, price_per_unit: r.price_per_unit, disc_percent: r.disc_percent, tax_code: r.tax_code,
        })),
        apply_lines: Object.entries(applyAmounts).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ sales_invoice_id: Number(id), applied_amount: Number(v) })),
      });
      navigate(`/credit-memos/${data.id}`);
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed.');
      setSaving(false);
    }
  }

  const Total = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px dashed var(--border)' }}>
      <span>{label}</span><span>{money(value)}</span>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>CREDIT MEMO <span className="muted">/ Create</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/credit-memos')}>Back to Lists</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'SAVE'}</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1.3fr) minmax(160px, 1fr) minmax(260px, 1.3fr)', gap: 20, alignItems: 'start' }}>
          <div>
            <div className="field"><label>Date Created</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
            <div className="field">
              <label>Customer :</label>
              <EntityPicker label="Customer" items={lookups.customers} value={customer?.id || ''} getLabel={(c) => c?.name}
                columns={[{ key: 'name', label: 'Name' }, { key: 'customer_code', label: 'Code' }]} searchKeys={['name', 'customer_code']}
                placeholder="--Select--" onSelect={setCustomer} />
            </div>
            <div className="field">
              <label>Office Location :</label>
              <EntityPicker label="Office Location" items={lookups.locations} value={location?.id || ''} getLabel={(l) => l?.location_name}
                columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="--Select--" onSelect={setLocation} />
            </div>
            <div className="field"><label>Memo</label><textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field"><label>Applied</label><input readOnly value={money(applied)} /></div>
            <div className="field"><label>Unapplied</label><input readOnly value={money(unapplied)} /></div>
          </div>
          <div style={{ background: 'var(--surface-2, #f3f4f6)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 18px' }}>
            <Total label="Sub Total" value={totals.subtotal} />
            <Total label="Discount Amount" value={totals.discountAmount} />
            <Total label="Net of Tax" value={totals.netOfTax} />
            <Total label="Tax Amount" value={totals.taxAmount} />
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 700 }}><span>Gross Amount</span><span>{money(totals.grossAmount)}</span></div>
          </div>
        </div>

        <div className="status-tabs" style={{ marginTop: 20 }}>
          <button type="button" className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>ITEMS</button>
          <button type="button" className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>APPLY <span style={{ color: '#2563eb', fontWeight: 700 }}>{money(applied)}</span></button>
        </div>

        {tab === 'items' && (
          <>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Department</th><th>Qty</th><th>Unit</th><th>Price/Unit</th>
                    <th>Subtotal</th><th>Disc.%</th><th>Disc. / Unit</th><th>Disc. Amt</th><th>Disc. Price/Unit</th><th>Net of Tax</th>
                    <th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={18} className="muted" style={{ textAlign: 'center', padding: 16 }}>No items yet — use Add Item.</td></tr>}
                  {rows.map((r, idx) => {
                    const a = lineAmounts(r);
                    return (
                      <tr key={r.key}>
                        <td>{idx + 1}</td>
                        <td>—</td>
                        <td style={{ whiteSpace: 'nowrap' }} title={r.item_code}>{r.item_name}</td>
                        <td><input style={{ width: 170 }} value={r.description ?? ''} onChange={(e) => updateRow(r.key, { description: e.target.value })} /></td>
                        <td>
                          <select value={r.department_id || ''} onChange={(e) => updateRow(r.key, { department_id: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">—</option>
                            {lookups.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                        </td>
                        <td><input type="number" step="0.0001" style={{ width: 80 }} value={r.quantity} onChange={(e) => updateRow(r.key, { quantity: e.target.value })} /></td>
                        <td><input style={{ width: 70 }} value={r.units} onChange={(e) => updateRow(r.key, { units: e.target.value })} /></td>
                        <td><input type="number" step="0.0001" style={{ width: 100 }} value={r.price_per_unit} onChange={(e) => updateRow(r.key, { price_per_unit: e.target.value })} /></td>
                        <td>{money(a.subtotal)}</td>
                        <td><input type="number" step="0.01" style={{ width: 70 }} value={r.disc_percent} onChange={(e) => updateRow(r.key, { disc_percent: e.target.value })} /></td>
                        <td>{money(a.discPerUnit)}</td>
                        <td>{money(a.discAmount)}</td>
                        <td>{money(a.discPricePerUnit)}</td>
                        <td>{money(a.netOfTax)}</td>
                        <td>
                          <select value={r.tax_code || ''} onChange={(e) => { const t = lookups.taxes.find((x) => x.code === e.target.value); updateRow(r.key, { tax_code: e.target.value || null, tax_rate: Number(t?.rate) || 0 }); }}>
                            <option value="">—</option>
                            {lookups.taxes.map((t) => <option key={t.id} value={t.code}>{t.code}</option>)}
                          </select>
                        </td>
                        <td>{money(a.taxAmount)}</td>
                        <td>{money(a.grossAmount)}</td>
                        <td><button type="button" className="btn btn-sm btn-danger" onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12 }}>
              <EntityPicker label="Materials" items={lookups.items} value="" getLabel={(i) => i?.display_name}
                columns={[{ key: 'item_code', label: 'Item Code' }, { key: 'display_name', label: 'Display Name' }, { key: 'sales_description', label: 'Sales Desc.' }]}
                searchKeys={['item_code', 'display_name', 'sales_description']}
                triggerLabel="Add Item" triggerClassName="btn btn-primary" onSelect={addItem} />
            </div>
          </>
        )}

        {tab === 'apply' && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            {!customer ? <p className="muted">Choose the Customer first — their open invoices show here.</p> : !source ? <LoadingSpinner /> : (
              <table>
                <thead><tr><th /><th>Invoice #</th><th>BS/SI #</th><th>Date Created</th><th>Original Amount</th><th>Amount Due</th><th>Applied Amount</th></tr></thead>
                <tbody>
                  {source.apply_lines.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>This customer has no open invoices.</td></tr>}
                  {source.apply_lines.map((l) => {
                    const checked = applyAmounts[l.sales_invoice_id] !== undefined;
                    return (
                      <tr key={l.sales_invoice_id}>
                        <td>
                          <input type="checkbox" checked={checked} onChange={() => setApplyAmounts((prev) => {
                            const next = { ...prev };
                            if (checked) delete next[l.sales_invoice_id];
                            else next[l.sales_invoice_id] = String(Math.max(Math.min(Number(l.amount_due), unapplied), 0).toFixed(2));
                            return next;
                          })} />
                        </td>
                        <td>{l.invoice_no}</td><td>{l.bs_si_no || ''}</td><td>{displayDate(l.date_created)}</td>
                        <td>{money(l.gross_amount)}</td><td>{money(l.amount_due)}</td>
                        <td><input type="number" step="0.01" style={{ width: 120 }} disabled={!checked} value={applyAmounts[l.sales_invoice_id] ?? ''}
                          onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [l.sales_invoice_id]: e.target.value }))} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
