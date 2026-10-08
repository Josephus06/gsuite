import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';

// Edit a Sales Order -- System Admin only (PUT /sales-orders/:id). Header details and every line:
// description, qty, price, Disc Amt PER PIECE (Disc Price/Unit = Price/Unit - Disc Amt, Net of Tax =
// Qty x Disc Price/Unit -- the estimate's rule), tax code, sizes, delivery date/time, remarks.
// The server recomputes every amount; this only previews them. The customer can be changed until the
// SO has an invoice or delivery ticket (customer_locked); the contact follows the customer.
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v).slice(0, 10) : '');

export default function SalesOrderEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [so, setSo] = useState(null);
  const [head, setHead] = useState({});
  const [lines, setLines] = useState([]);
  const [lk, setLk] = useState({ contacts: [], reps: [], locations: [], taxes: [] });
  const [customers, setCustomers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/sales-orders/${id}`);
        const [cust, reps, locs, taxes] = await Promise.all([
          data.customer_id ? api.get(`/customers/${data.customer_id}`).catch(() => ({ data: {} })) : Promise.resolve({ data: {} }),
          api.get('/employees').catch(() => ({ data: [] })), api.get('/lookups/locations'), api.get('/lookups/taxes'),
        ]);
        setLk({ contacts: cust.data.contacts || [], reps: reps.data, locations: locs.data, taxes: taxes.data });
        if (!data.customer_locked) api.get('/customers').then((r) => setCustomers(r.data)).catch(() => {});
        setSo(data);
        setHead({ ...data, date_created: day(data.date_created) });
        setLines(data.lines.map((l) => ({
          ...l, delivery_date: day(l.delivery_date),
          disc_per_piece: Number(l.quantity) ? Number((Number(l.disc_amount || 0) / Number(l.quantity)).toFixed(4)) : 0,
        })));
      } catch (e) { setError(e.response?.data?.error || 'Could not load the Sales Order.'); }
    })();
  }, [id]);

  const rateOf = (taxId) => Number(lk.taxes.find((t) => String(t.id) === String(taxId))?.rate) || 0;
  const calc = (l) => {
    const qty = Number(l.quantity) || 0; const price = Number(l.price_per_unit) || 0;
    const subtotal = qty * price; const disc = (Number(l.disc_per_piece) || 0) * qty; const net = subtotal - disc;
    const tax = net * rateOf(l.tax_code_id) / 100;
    return { subtotal, disc, discPrice: qty ? net / qty : 0, net, tax, gross: net + tax };
  };
  const totals = useMemo(() => lines.reduce((t, l) => {
    const c = calc(l); return { sub: t.sub + c.subtotal, disc: t.disc + c.disc, net: t.net + c.net, tax: t.tax + c.tax, gross: t.gross + c.gross };
  }, { sub: 0, disc: 0, net: 0, tax: 0, gross: 0 }), [lines, lk.taxes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !so) return <div className="error-banner">{error}</div>;
  if (!so) return <LoadingSpinner />;

  const h = (k) => ({ value: head[k] ?? '', onChange: (e) => setHead((x) => ({ ...x, [k]: e.target.value })) });
  // Line 1's Tax Code is the order's: changing it re-taxes every line the same way (asked 2026-10-07);
  // any other line can still be set on its own.
  // Contact details come from the contact chosen; "—" clears them.
  const fillContact = (c) => ({
    contact_person_id: c?.id || '', contact_email: c?.email || '', contact_title: c?.title || '', contact_phone: c?.phone || '',
  });
  const pickContact = (cid) => setHead((x) => ({ ...x, ...fillContact(lk.contacts.find((c) => String(c.id) === String(cid))) }));
  // A new customer brings its own contacts: the old contact and its details are replaced by the new
  // customer's primary contact (or its only one), else left blank to choose.
  async function pickCustomer(c) {
    if (!c || String(c.id) === String(head.customer_id)) return;
    let contacts = [];
    try { contacts = (await api.get(`/customers/${c.id}`)).data.contacts || []; } catch { /* left blank */ }
    setLk((x) => ({ ...x, contacts }));
    const first = contacts.find((k) => k.is_primary) || (contacts.length === 1 ? contacts[0] : null);
    setHead((x) => ({ ...x, customer_id: c.id, customer_name: c.name, ...fillContact(first) }));
  }
  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => (j === i || (k === 'tax_code_id' && i === 0) ? { ...l, [k]: v } : l)));

  async function save() {
    setSaving(true); setError('');
    try {
      const body = { customer_id: head.customer_id, ...Object.fromEntries(['ref_no', 'date_created', 'contact_person_id', 'contact_email', 'contact_title', 'contact_phone',
        'blanket_po_memo', 'sales_rep_id', 'office_location_id', 'contract_description', 'memo', 'shipping_address',
        'production_lead_time', 'price_validity', 'order_confirmation_type', 'order_confirmation_ref', 'credit_term', 'bill_to_contact_number']
        .map((k) => [k, head[k] ?? null])),
      lines: lines.map((l) => ({
        id: l.id, job_location_id: l.job_location_id || null, description: l.description, quantity: l.quantity, units: l.units, price_per_unit: l.price_per_unit,
        disc_per_piece: l.disc_per_piece, tax_code_id: l.tax_code_id || null, length: l.length, width: l.width, height: l.height,
        uom: l.uom, shipping: l.shipping, remarks: l.remarks, memo: l.memo, delivery_date: l.delivery_date || null, delivery_time: l.delivery_time || null,
      })) };
      await api.put(`/sales-orders/${id}`, body);
      navigate(`/sales-orders/${id}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Sales Order <span className="muted">/ Edit {so.sales_order_no}</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={`/sales-orders/${id}`}>Cancel</Link>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 20px' }}>
          <div>
            <div className="field">
              <label>Customer</label>
              {so.customer_locked
                ? <input readOnly value={so.customer_name || ''} title="Not editable: this Sales Order already has invoices or delivery tickets" />
                : (
                  <EntityPicker label="Customer" items={customers.length ? customers : [{ id: so.customer_id, name: so.customer_name }]}
                    value={head.customer_id || ''} getLabel={(c) => c?.name}
                    columns={[{ key: 'name', label: 'Name' }, { key: 'customer_code', label: 'Code' }]} searchKeys={['name', 'customer_code']}
                    placeholder="--Select--" onSelect={pickCustomer} />
                )}
              {String(head.customer_id) !== String(so.customer_id) && <div className="muted" style={{ fontSize: 12 }}>Changed from {so.customer_name}. Blanket PO will be cleared.</div>}
            </div>
            <div className="field">
              <label>Contact Person</label>
              <select value={head.contact_person_id ?? ''} onChange={(e) => pickContact(e.target.value)}>
                <option value="">—</option>
                {lk.contacts.map((c) => <option key={c.id} value={c.id}>{c.contact_name}</option>)}
              </select>
            </div>
            <div className="field"><label>Contact Email</label><input {...h('contact_email')} /></div>
            <div className="field"><label>Contact Title</label><input {...h('contact_title')} /></div>
            <div className="field"><label>Contact Phone</label><input {...h('contact_phone')} /></div>
          </div>
          <div>
            <div className="field"><label>Date Created</label><input type="date" {...h('date_created')} /></div>
            <div className="field"><label>Reference #</label><input {...h('ref_no')} /></div>
            <div className="field"><label>Blanket PO Memo</label><input {...h('blanket_po_memo')} /></div>
            <div className="field">
              <label>Sales Rep</label>
              <select {...h('sales_rep_id')}>
                <option value="">—</option>
                {lk.reps.filter((r) => Number(r.is_active) || String(r.id) === String(so.sales_rep_id))
                  .map((r) => <option key={r.id} value={r.id}>{r.first_name} {r.last_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Office Location</label>
              <select {...h('office_location_id')}>
                <option value="">—</option>
                {lk.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <div className="field"><label>Contract Description</label><input {...h('contract_description')} /></div>
            <div className="field"><label>Production Lead Time</label><input {...h('production_lead_time')} /></div>
            <div className="field"><label>Price Validity</label><input {...h('price_validity')} /></div>
            <div className="field"><label>Order Confirmation</label>
              <div style={{ display: 'flex', gap: 6 }}><input placeholder="Type" {...h('order_confirmation_type')} /><input placeholder="Ref" {...h('order_confirmation_ref')} /></div>
            </div>
            <div className="field"><label>Credit Term</label><input {...h('credit_term')} /></div>
            <div className="field"><label>Bill to Contact No.</label><input {...h('bill_to_contact_number')} /></div>
          </div>
          <div>
            <div className="field"><label>Shipping Address</label><textarea rows={3} {...h('shipping_address')} /></div>
            <div className="field"><label>Memo</label><textarea rows={3} {...h('memo')} /></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>JO #</th><th>Job Location</th><th>Description</th><th>Qty</th><th>Units</th><th>Price/Unit</th><th>Subtotal</th>
                <th title="Per piece">Disc Amt</th><th>Disc Price/Unit</th><th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th>
                <th>Length</th><th>Width</th><th>Height</th><th>UOM</th><th>Delivery Date</th><th>Delivery Time</th><th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const c = calc(l);
                const inp = (k, w = 90, type = 'text') => <input type={type} style={{ width: w }} value={l[k] ?? ''} onChange={(e) => setLine(i, k, e.target.value)} />;
                return (
                  <tr key={l.id}>
                    <td>{l.line_no}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{l.job_order_no || '—'}</td>
                    <td>
                      <select style={{ width: 170 }} value={l.job_location_id || ''} onChange={(e) => setLine(i, 'job_location_id', e.target.value)}>
                        <option value="">—</option>
                        {lk.locations.map((x) => <option key={x.id} value={x.id}>{x.location_name}</option>)}
                      </select>
                    </td>
                    <td><textarea rows={2} style={{ width: 220 }} value={l.description ?? ''} onChange={(e) => setLine(i, 'description', e.target.value)} /></td>
                    <td>{inp('quantity', 70, 'number')}</td>
                    <td>{inp('units', 70)}</td>
                    <td>{inp('price_per_unit', 100, 'number')}</td>
                    <td className="text-right">{money(c.subtotal)}</td>
                    <td>{inp('disc_per_piece', 90, 'number')}</td>
                    <td className="text-right">{c.discPrice.toFixed(4)}</td>
                    <td className="text-right">{money(c.net)}</td>
                    <td>
                      <select value={l.tax_code_id || ''} onChange={(e) => setLine(i, 'tax_code_id', e.target.value)}>
                        <option value="">—</option>
                        {lk.taxes.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
                      </select>
                    </td>
                    <td className="text-right">{money(c.tax)}</td>
                    <td className="text-right">{money(c.gross)}</td>
                    <td>{inp('length', 60, 'number')}</td>
                    <td>{inp('width', 60, 'number')}</td>
                    <td>{inp('height', 60, 'number')}</td>
                    <td>{inp('uom', 60)}</td>
                    <td>{inp('delivery_date', 140, 'date')}</td>
                    <td>{inp('delivery_time', 100, 'time')}</td>
                    <td>{inp('remarks', 140)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Disc Amt is per piece. A line&rsquo;s Job Order takes its new quantity, description and job location on save.
        </p>
      </div>

      <div className="estimate-footer card">
        <div><span className="muted">Subtotal</span><div className="hi-lg">{money(totals.sub)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(totals.disc)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(totals.net)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(totals.tax)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(totals.gross)}</div></div>
      </div>
    </div>
  );
}
