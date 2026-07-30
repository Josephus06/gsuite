import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function today() { return new Date().toISOString().slice(0, 10); }
const PAYEE_TYPES = [{ v: 'VENDOR', l: 'Vendor' }, { v: 'CUSTOMER', l: 'Customer' }, { v: 'EMPLOYEE', l: 'Employee' }];
const EMPTY_LINE = { account_id: '', account_label: '', department_id: '', description: '', amount: '', tax_code_id: '', apply_withholding_tax: false, withholding_tax_amount: '' };

// Create a Cheque -- mirrors the live form: header (Date/Payee/Account/Cheque details/Currency/Memo),
// a running totals panel, and an Expenses grid. GL: DR each expense account / CR the bank Account.
export default function ChequeForm() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [header, setHeader] = useState({
    date_created: today(), payee_type: 'VENDOR', payee_id: '', payee_name: '', office_location_id: '',
    account_id: '', cheque_date: today(), cheque_number: '', currency: 'PHP', conversion_rate: 1, memo: '',
  });
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/cheques/meta').then(({ data }) => { setMeta(data); setLoading(false); }).catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, []);

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { ...EMPTY_LINE }]);
  const delLine = (i) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  function payeeItems(type) {
    if (type === 'VENDOR') return meta.vendors;
    if (type === 'CUSTOMER') return meta.customers;
    if (type === 'EMPLOYEE') return meta.employees;
    return [];
  }
  function taxRate(taxCodeId) { const t = (meta?.taxes || []).find((x) => String(x.id) === String(taxCodeId)); return t ? Number(t.rate) : 0; }

  // Per-line derived figures.
  const computed = useMemo(() => lines.map((l) => {
    const amount = Number(l.amount) || 0;
    const tax = amount * (taxRate(l.tax_code_id) / 100);
    const wtax = Number(l.withholding_tax_amount) || 0;
    const gross = amount + tax;
    return { tax, wtax, gross, total: gross - wtax };
  }), [lines, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    const net = computed.reduce((s, c, i) => s + (Number(lines[i].amount) || 0), 0);
    const tax = computed.reduce((s, c) => s + c.tax, 0);
    const wtax = computed.reduce((s, c) => s + c.wtax, 0);
    const gross = net + tax;
    return { net, tax, wtax, gross, total: gross - wtax };
  }, [computed, lines]);

  async function save() {
    setError('');
    if (!header.account_id) { setError('Select the bank Account to draw the cheque against.'); return; }
    const payload = lines
      .map((l, i) => ({ ...l, tax_amount: computed[i].tax, withholding_tax_amount: Number(l.withholding_tax_amount) || 0 }))
      .filter((l) => l.account_id && Number(l.amount) > 0)
      .map((l) => ({
        account_id: l.account_id, department_id: l.department_id || null, description: l.description,
        amount: Number(l.amount), tax_code_id: l.tax_code_id || null, tax_amount: l.tax_amount,
        apply_withholding_tax: l.apply_withholding_tax, withholding_tax_amount: l.withholding_tax_amount,
      }));
    if (!payload.length) { setError('Add at least one expense line with an account and amount.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/cheques', { ...header, lines: payload });
      navigate(`/cheques/${data.id}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;
  const TotalsRow = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px dashed var(--border)' }}>
      <span className="muted">{label}</span><span style={{ color: '#2563eb' }}>{money(value)}</span>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Cheque <span className="muted">/ Create</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/cheques')}>Back to Lists</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 300px', gap: 20, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field"><label>Date</label><input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} /></div>
            <div className="field">
              <label>Payee</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={header.payee_type} onChange={(e) => setH({ payee_type: e.target.value, payee_id: '', payee_name: '' })} style={{ width: 110 }}>
                  {PAYEE_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
                </select>
                <div style={{ flex: 1 }}>
                  <EntityPicker label="Payee" items={payeeItems(header.payee_type)} value={header.payee_id} getLabel={(x) => x.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder={header.payee_name || '--Select--'}
                    onSelect={(x) => setH({ payee_id: x?.id || '', payee_name: x?.name || '' })} />
                </div>
              </div>
            </div>
            <div className="field"><label>Payee Name</label><input value={header.payee_name} onChange={(e) => setH({ payee_name: e.target.value })} /></div>
            <div className="field">
              <label>Office Location</label>
              <EntityPicker label="Office Location" items={meta.locations} value={header.office_location_id} getLabel={(l) => l.location_name}
                columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="--Select--" onSelect={(l) => setH({ office_location_id: l?.id || '' })} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field">
              <label>Account</label>
              <EntityPicker label="Bank Account" items={meta.bankAccounts} value={header.account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]} searchKeys={['account_code', 'account_name']} placeholder="--Select--" onSelect={(a) => setH({ account_id: a?.id || '' })} />
            </div>
            <div className="field"><label>Cheque Date</label><input type="date" value={header.cheque_date} onChange={(e) => setH({ cheque_date: e.target.value })} /></div>
            <div className="field"><label>Cheque No</label><input value={header.cheque_number} onChange={(e) => setH({ cheque_number: e.target.value })} /></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="field" style={{ flex: 1 }}><label>Currency</label><input value={header.currency} onChange={(e) => setH({ currency: e.target.value })} /></div>
              <div className="field" style={{ flex: 1 }}><label>Conversion Rate</label><input type="number" step="0.000001" value={header.conversion_rate} onChange={(e) => setH({ conversion_rate: e.target.value })} /></div>
            </div>
          </div>

          <div className="field"><label>Memo</label><textarea rows={8} value={header.memo} onChange={(e) => setH({ memo: e.target.value })} style={{ height: '100%' }} /></div>

          <div style={{ background: '#f8fafc', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 18px' }}>
            <TotalsRow label="Sub Total" value={totals.net} />
            <TotalsRow label="Discount Amount" value={0} />
            <TotalsRow label="Net of Tax" value={totals.net} />
            <TotalsRow label="Tax Amount" value={totals.tax} />
            <TotalsRow label="Withholding Tax Amount" value={totals.wtax} />
            <TotalsRow label="Gross Amount" value={totals.gross} />
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 700 }}>
              <span>Total Amount</span><span style={{ color: '#2563eb' }}>{money(totals.total)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 8 }}><button className="status-tab active">Expenses</button></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th><th>Account</th><th>Description</th><th>Department</th><th style={{ textAlign: 'right' }}>Amount</th>
                <th>Tax Code</th><th style={{ textAlign: 'right' }}>Tax Amount</th><th>Apply WTax</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Withholding Tax</th><th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><button type="button" className="btn btn-sm btn-warning" onClick={() => delLine(i)}>✕</button></td>
                  <td style={{ minWidth: 230 }}>
                    <EntityPicker label="Account" items={meta.accounts} value={l.account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                      columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Title' }]} searchKeys={['account_code', 'account_name']}
                      placeholder={l.account_label || '--Select--'} onSelect={(a) => setLine(i, { account_id: a?.id || '', account_label: a ? `${a.account_code} — ${a.account_name}` : '' })} />
                  </td>
                  <td><input style={{ width: 150 }} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                  <td style={{ minWidth: 140 }}>
                    <EntityPicker label="Department" items={meta.departments} value={l.department_id} getLabel={(d) => d.name}
                      columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--" onSelect={(d) => setLine(i, { department_id: d?.id || '' })} />
                  </td>
                  <td><input type="number" step="0.01" style={{ width: 100, textAlign: 'right' }} value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></td>
                  <td>
                    <select value={l.tax_code_id} onChange={(e) => setLine(i, { tax_code_id: e.target.value })}>
                      <option value="">--None--</option>
                      {meta.taxes.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate)}%)</option>)}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(computed[i].tax)}</td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={l.apply_withholding_tax} onChange={(e) => setLine(i, { apply_withholding_tax: e.target.checked })} /></td>
                  <td style={{ textAlign: 'right' }}>{money(computed[i].gross)}</td>
                  <td><input type="number" step="0.01" style={{ width: 90, textAlign: 'right' }} value={l.withholding_tax_amount} onChange={(e) => setLine(i, { withholding_tax_amount: e.target.value })} disabled={!l.apply_withholding_tax} /></td>
                  <td style={{ textAlign: 'right' }}>{money(computed[i].total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn btn-sm btn-primary" style={{ marginTop: 10 }} onClick={addLine}>Add Expense</button>
      </div>
    </div>
  );
}
