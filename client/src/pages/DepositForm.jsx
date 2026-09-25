import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

import { displayDate } from '../utils/dates';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(v) { return v ? displayDate(v) : ''; }
function dayISO(v) { return v ? String(v).slice(0, 10) : ''; }

const EMPTY_OTHER = { party_key: '', amount: '', account_id: '', payment_method_id: '', department_id: '', location_id: '', memo: '' };
const EMPTY_CASHBACK = { amount: '', account_id: '', department_id: '', location_id: '', memo: '' };

// Create a Bank Deposit: pick a bank account + date, then tick the not-deposited customer payments to
// sweep in. Other Deposit lines (money in that no payment explains) are ADDED to the total; Cash Back
// lines (cash kept back instead of banked) are DEDUCTED from it. Save posts them to a new BD-####.
export default function DepositForm() {
  const navigate = useNavigate();
  const location = useLocation();
  const preselectId = location.state?.preselectPaymentId;
  const [meta, setMeta] = useState(null);
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [checked, setChecked] = useState({});
  const [tab, setTab] = useState('payments');
  const [others, setOthers] = useState([{ ...EMPTY_OTHER }]);
  const [cashBacks, setCashBacks] = useState([{ ...EMPTY_CASHBACK }]);
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

  const paymentsTotal = useMemo(() => (meta?.payments || []).filter((p) => checked[p.id]).reduce((s, p) => s + Number(p.payment_amount || 0), 0), [meta, checked]);
  const otherTotal = others.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const cashBackTotal = cashBacks.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const total = paymentsTotal + otherTotal - cashBackTotal;
  const selectedIds = Object.keys(checked).filter((k) => checked[k]).map(Number);

  // The Name picker's Employees / Vendor / Customer tabs, each with its own columns, the way the
  // live form offers them. Ids are keyed TYPE:id because the three tables' ids overlap.
  const partyTabs = useMemo(() => {
    if (!meta) return [];
    const keyed = (type, list) => (list || []).map((x) => ({ ...x, id: `${type}:${x.id}` }));
    return [
      {
        key: 'EMPLOYEE', label: 'Employees', items: keyed('EMPLOYEE', meta.employees),
        searchKeys: ['code', 'name', 'position_title', 'contact_no'],
        columns: [
          { key: 'code', label: 'Employee ID' }, { key: 'name', label: 'Name' }, { key: 'position_title', label: 'Position' },
          { key: 'address', label: 'Address' }, { key: 'birth_date', label: 'Birthdate', render: (x) => formatDate(x.birth_date) },
          { key: 'sex', label: 'Gender' }, { key: 'contact_no', label: 'Contact No' },
        ],
      },
      {
        key: 'VENDOR', label: 'Vendor', items: keyed('VENDOR', meta.vendors),
        searchKeys: ['code', 'name', 'company_name', 'tin'],
        columns: [
          { key: 'code', label: 'Vendor ID' }, { key: 'name', label: 'Name' }, { key: 'company_name', label: 'Company' },
          { key: 'address', label: 'Address' }, { key: 'contact_no', label: 'Contact No' }, { key: 'tin', label: 'TIN' },
        ],
      },
      {
        key: 'CUSTOMER', label: 'Customer', items: keyed('CUSTOMER', meta.customers),
        searchKeys: ['code', 'name', 'company_name', 'tin'],
        columns: [
          { key: 'code', label: 'Customer ID' }, { key: 'name', label: 'Name' }, { key: 'company_name', label: 'Company' },
          { key: 'address', label: 'Address' }, { key: 'tin', label: 'TIN' },
        ],
      },
    ];
  }, [meta]);

  const setOther = (i, patch) => setOthers((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const setCashBack = (i, patch) => setCashBacks((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  // Mirrors lib/depositGl.js on the server, which is what actually posts.
  const gl = useMemo(() => {
    if (!meta) return [];
    const acct = (id) => meta.lineAccounts.find((a) => String(a.id) === String(id));
    const bank = meta.accounts.find((a) => String(a.id) === String(accountId));
    const rows = [];
    if (bank && total > 0) rows.push({ code: bank.account_code, name: bank.account_name, debit: total, credit: 0 });
    cashBacks.forEach((l) => { const a = acct(l.account_id); if (a && Number(l.amount) > 0) rows.push({ code: a.account_code, name: a.account_name, debit: Number(l.amount), credit: 0 }); });
    if (paymentsTotal > 0) rows.push({ code: '10006', name: 'Undeposited Funds', debit: 0, credit: paymentsTotal });
    others.forEach((l) => { const a = acct(l.account_id); if (a && Number(l.amount) > 0) rows.push({ code: a.account_code, name: a.account_name, debit: 0, credit: Number(l.amount) }); });
    return rows;
  }, [meta, accountId, total, paymentsTotal, others, cashBacks]);

  async function save() {
    setError('');
    if (!accountId) { setError('Select a bank account to deposit into.'); return; }
    if (!selectedIds.length && !(otherTotal > 0)) { setError('Tick at least one payment or add an Other Deposit.'); return; }
    if (!(total > 0)) { setError('Cash Back cannot be as much as the payments and Other Deposits together.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/deposits', {
        date_created: date, account_id: accountId, memo, payment_ids: selectedIds,
        other_deposits: others.map(({ party_key: key, ...l }) => {
          const [type, pid] = key ? key.split(':') : [null, null];
          return { ...l, party_type: type, party_id: pid };
        }),
        cash_backs: cashBacks,
      });
      navigate(`/deposits/${data.id}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading) return <LoadingSpinner />;
  // A failed load used to leave the spinner up for ever, with the reason set but never shown.
  if (!meta) return <div className="error-banner">{error || 'Failed to load.'}</div>;

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
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '16px 22px', minWidth: 280 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted">Total Deposit</span>
              <span style={{ color: '#2563eb', fontWeight: 700, fontSize: 18 }}>{money(total)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 8 }}>
          <button className={`status-tab ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>Payments {money(paymentsTotal)}</button>
          <button className={`status-tab ${tab === 'other' ? 'active' : ''}`} onClick={() => setTab('other')}>Other Deposit {money(otherTotal)}</button>
          <button className={`status-tab ${tab === 'cashback' ? 'active' : ''}`} onClick={() => setTab('cashback')}>Cash Back {money(cashBackTotal)}</button>
          <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        </div>

        {tab === 'other' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Amount</th><th>Account</th><th>Payment Method</th><th>Department</th><th>Location</th><th>Memo</th><th></th></tr></thead>
              <tbody>
                {others.map((l, i) => (
                  <tr key={i}>
                    <td style={{ minWidth: 180 }}>
                      <EntityPicker label="Accounts" tabs={partyTabs} value={l.party_key} getLabel={(x) => x.name}
                        placeholder="Select Name" onSelect={(x) => setOther(i, { party_key: x?.id || '' })} onClear={() => setOther(i, { party_key: '' })} />
                    </td>
                    <td><input type="number" step="0.01" min="0" style={{ width: 130, textAlign: 'right' }} value={l.amount} onChange={(e) => setOther(i, { amount: e.target.value })} /></td>
                    <td style={{ minWidth: 220 }}>
                      <EntityPicker label="Account" items={meta.lineAccounts} value={l.account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                        columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Title' }, { key: 'account_type', label: 'Type' }]}
                        searchKeys={['account_code', 'account_name']} placeholder="Select Account" onSelect={(a) => setOther(i, { account_id: a?.id || '' })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <EntityPicker label="Payment Method" items={meta.paymentMethods} value={l.payment_method_id} getLabel={(m) => m.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="Select Payment Method" onSelect={(m) => setOther(i, { payment_method_id: m?.id || '' })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <EntityPicker label="Department" items={meta.departments} value={l.department_id} getLabel={(d) => d.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="Select Department" onSelect={(d) => setOther(i, { department_id: d?.id || '' })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <EntityPicker label="Location" items={meta.locations} value={l.location_id} getLabel={(x) => x.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="Select Location" onSelect={(x) => setOther(i, { location_id: x?.id || '' })} />
                    </td>
                    <td><input style={{ width: 180 }} value={l.memo} onChange={(e) => setOther(i, { memo: e.target.value })} /></td>
                    <td><button type="button" className="btn btn-sm btn-warning" onClick={() => setOthers((ls) => ls.filter((_, idx) => idx !== i))}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => setOthers((ls) => [...ls, { ...EMPTY_OTHER }])}>Add Other Deposit</button>
          </div>
        )}

        {tab === 'cashback' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Amount</th><th>Account</th><th>Department</th><th>Location</th><th>Memo</th><th></th></tr></thead>
              <tbody>
                {cashBacks.map((l, i) => (
                  <tr key={i}>
                    <td><input type="number" step="0.01" min="0" style={{ width: 130, textAlign: 'right' }} value={l.amount} onChange={(e) => setCashBack(i, { amount: e.target.value })} /></td>
                    <td style={{ minWidth: 220 }}>
                      <EntityPicker label="Account" items={meta.lineAccounts} value={l.account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                        columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Title' }, { key: 'account_type', label: 'Type' }]}
                        searchKeys={['account_code', 'account_name']} placeholder="Select Account" onSelect={(a) => setCashBack(i, { account_id: a?.id || '' })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <EntityPicker label="Department" items={meta.departments} value={l.department_id} getLabel={(d) => d.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="Select Department" onSelect={(d) => setCashBack(i, { department_id: d?.id || '' })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <EntityPicker label="Location" items={meta.locations} value={l.location_id} getLabel={(x) => x.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="Select Location" onSelect={(x) => setCashBack(i, { location_id: x?.id || '' })} />
                    </td>
                    <td><input style={{ width: 220 }} value={l.memo} onChange={(e) => setCashBack(i, { memo: e.target.value })} /></td>
                    <td><button type="button" className="btn btn-sm btn-warning" onClick={() => setCashBacks((ls) => ls.filter((_, idx) => idx !== i))}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => setCashBacks((ls) => [...ls, { ...EMPTY_CASHBACK }])}>Add Cash Back</button>
          </div>
        )}

        {tab === 'gl' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account Code</th><th>Account Title</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {gl.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>Pick a bank account and something to deposit.</td></tr>}
                {gl.map((r, i) => (
                  <tr key={i}><td>{r.code}</td><td>{r.name}</td><td style={{ textAlign: 'right' }}>{r.debit ? money(r.debit) : ''}</td><td style={{ textAlign: 'right' }}>{r.credit ? money(r.credit) : ''}</td></tr>
                ))}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={2} style={{ textAlign: 'right' }}>Total</td>
                <td style={{ textAlign: 'right' }}>{money(gl.reduce((s, r) => s + r.debit, 0))}</td>
                <td style={{ textAlign: 'right' }}>{money(gl.reduce((s, r) => s + r.credit, 0))}</td></tr></tfoot>
            </table>
          </div>
        )}

        {tab === 'payments' && (
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
        )}
      </div>
    </div>
  );
}
