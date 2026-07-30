import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }
function dayISO(v) { return v ? String(v).slice(0, 10) : ''; }

// Create a Bank Deposit: pick a bank account + date, then tick the not-deposited customer payments to
// sweep in. Total Deposit sums the checked rows. Save posts them to a new BD-####.
export default function DepositForm() {
  const navigate = useNavigate();
  const location = useLocation();
  const preselectId = location.state?.preselectPaymentId;
  const [meta, setMeta] = useState(null);
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [checked, setChecked] = useState({});
  const [filters, setFilters] = useState({ trans: '', customer: '', location: '', method: '', from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/deposits/meta').then(({ data }) => {
      setMeta(data);
      // Deposit reached from a single Customer Payment's "Deposit" button: pre-tick that payment.
      if (preselectId && (data.payments || []).some((p) => p.id === preselectId)) setChecked({ [preselectId]: true });
      setLoading(false);
    }).catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [preselectId]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));

  const rows = useMemo(() => {
    const pays = meta?.payments || [];
    return pays.filter((p) => {
      if (filters.trans && !String(p.customer_payment_no || '').toLowerCase().includes(filters.trans.toLowerCase())) return false;
      if (filters.customer && !String(p.customer_name || '').toLowerCase().includes(filters.customer.toLowerCase())) return false;
      if (filters.location && !String(p.location_name || '').toLowerCase().includes(filters.location.toLowerCase())) return false;
      if (filters.method && !String(p.payment_method_name || '').toLowerCase().includes(filters.method.toLowerCase())) return false;
      if (filters.from && dayISO(p.date_created) < filters.from) return false;
      if (filters.to && dayISO(p.date_created) > filters.to) return false;
      return true;
    });
  }, [meta, filters]);

  const total = useMemo(() => (meta?.payments || []).filter((p) => checked[p.id]).reduce((s, p) => s + Number(p.payment_amount || 0), 0), [meta, checked]);
  const selectedIds = Object.keys(checked).filter((k) => checked[k]).map(Number);

  async function save() {
    setError('');
    if (!accountId) { setError('Select a bank account to deposit into.'); return; }
    if (!selectedIds.length) { setError('Tick at least one payment to deposit.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/deposits', { date_created: date, account_id: accountId, memo, payment_ids: selectedIds });
      navigate(`/deposits/${data.id}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Deposit <span className="muted">/ Create</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/deposits')}>Back to Lists</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 20, alignItems: 'start' }}>
          <div>
            <div className="field"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="field">
              <label>Account</label>
              <EntityPicker label="Bank Account" items={meta.accounts} value={accountId} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]} searchKeys={['account_code', 'account_name']}
                placeholder="--Select--" onSelect={(a) => setAccountId(a?.id || '')} />
            </div>
          </div>
          <div className="field"><label>Memo</label><textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
          <div style={{ background: '#f1f5f9', borderRadius: 8, padding: '16px 22px', minWidth: 280 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted">Total Deposit</span>
              <span style={{ color: '#2563eb', fontWeight: 700, fontSize: 18 }}>{money(total)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 8 }}>
          <button className="status-tab active">Payments {money(total)}</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th></th><th>Trans. #</th><th>Customer</th><th>Location</th><th>Payment Method</th><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
              <tr>
                <th></th>
                <th><input value={filters.trans} onChange={(e) => setF({ trans: e.target.value })} placeholder="Trans #" style={{ width: '100%' }} /></th>
                <th><input value={filters.customer} onChange={(e) => setF({ customer: e.target.value })} placeholder="Customer" style={{ width: '100%' }} /></th>
                <th><input value={filters.location} onChange={(e) => setF({ location: e.target.value })} placeholder="Location" style={{ width: '100%' }} /></th>
                <th><input value={filters.method} onChange={(e) => setF({ method: e.target.value })} placeholder="Method" style={{ width: '100%' }} /></th>
                <th style={{ display: 'flex', gap: 4 }}>
                  <input type="date" value={filters.from} onChange={(e) => setF({ from: e.target.value })} />
                  <input type="date" value={filters.to} onChange={(e) => setF({ to: e.target.value })} />
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No not-deposited payments.</td></tr>}
              {rows.map((p) => (
                <tr key={p.id}>
                  <td><input type="checkbox" checked={!!checked[p.id]} onChange={(e) => setChecked((c) => ({ ...c, [p.id]: e.target.checked }))} /></td>
                  <td>{p.customer_payment_no}</td>
                  <td>{p.customer_name}</td>
                  <td>{p.location_name}</td>
                  <td>{p.payment_method_name}</td>
                  <td>{formatDate(p.date_created)}</td>
                  <td style={{ textAlign: 'right' }}>{money(p.payment_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
