import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function today() { return new Date().toISOString().slice(0, 10); }
const PARTY_TYPES = [{ v: '', l: '—' }, { v: 'VENDOR', l: 'Vendor' }, { v: 'CUSTOMER', l: 'Customer' }, { v: 'EMPLOYEE', l: 'Employee' }];
const EMPTY_LINE = { account_id: '', account_label: '', department_id: '', party_type: '', party_id: '', party_name: '', debit: '', credit: '', memo: '' };

// Add New Journal: a header plus a balanced set of debit/credit lines. Each line picks an account
// (required), an optional department + party (Vendor/Customer/Employee), and either a debit or a
// credit. Total debit must equal total credit before it can be saved.
export default function JournalForm() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [header, setHeader] = useState({ date_created: today(), location_id: '', currency: '', conversion: 1, memo: '' });
  const [lines, setLines] = useState([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/journals/meta').then(({ data }) => { setMeta(data); setLoading(false); }).catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, []);

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { ...EMPTY_LINE }]);
  const delLine = (i) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  function partyItems(type) {
    if (type === 'VENDOR') return meta.vendors;
    if (type === 'CUSTOMER') return meta.customers;
    if (type === 'EMPLOYEE') return meta.employees;
    return [];
  }

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005 && totalDebit > 0;

  async function save() {
    setError('');
    const payload = lines
      .filter((l) => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
      .map((l) => ({
        account_id: l.account_id, department_id: l.department_id || null,
        party_type: l.party_type || null, party_id: l.party_id || null, party_name: l.party_name || null,
        debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo || null,
      }));
    if (payload.length < 2) { setError('Enter at least two lines with an account and a debit or credit.'); return; }
    if (!balanced) { setError(`Journal is out of balance: debit ${money(totalDebit)} vs credit ${money(totalCredit)}.`); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/journals', { ...header, lines: payload });
      navigate(`/journals/${data.id}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>New Journal</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/journals')}>Back</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="field">
            <label>Date</label>
            <input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} />
          </div>
          <div className="field">
            <label>Location</label>
            <EntityPicker label="Location" items={meta.locations} value={header.location_id} getLabel={(l) => l.location_name}
              columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="--Select--" onSelect={(l) => setH({ location_id: l?.id || '' })} />
          </div>
          <div className="field">
            <label>Currency</label>
            <input value={header.currency} onChange={(e) => setH({ currency: e.target.value })} placeholder="PHP" />
          </div>
          <div className="field">
            <label>Conversion</label>
            <input type="number" step="0.000001" value={header.conversion} onChange={(e) => setH({ conversion: e.target.value })} />
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Memo</label>
          <textarea rows={2} value={header.memo} onChange={(e) => setH({ memo: e.target.value })} />
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th><th>Account</th><th>Department</th><th>Type</th><th>Name</th>
                <th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th><th>Memo</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><button type="button" className="btn btn-sm btn-warning" onClick={() => delLine(i)}>✕</button></td>
                  <td style={{ minWidth: 240 }}>
                    <EntityPicker label="Account" items={meta.accounts} value={l.account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                      columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Title' }, { key: 'account_type', label: 'Type' }]}
                      searchKeys={['account_code', 'account_name']} placeholder="--Select--" onSelect={(a) => setLine(i, { account_id: a?.id || '', account_label: a ? `${a.account_code} — ${a.account_name}` : '' })} />
                  </td>
                  <td style={{ minWidth: 160 }}>
                    <EntityPicker label="Department" items={meta.departments} value={l.department_id} getLabel={(d) => d.name}
                      columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--" onSelect={(d) => setLine(i, { department_id: d?.id || '' })} />
                  </td>
                  <td>
                    <select value={l.party_type} onChange={(e) => setLine(i, { party_type: e.target.value, party_id: '', party_name: '' })}>
                      {PARTY_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
                    </select>
                  </td>
                  <td style={{ minWidth: 180 }}>
                    {l.party_type
                      ? <EntityPicker label="Name" items={partyItems(l.party_type)} value={l.party_id} getLabel={(x) => x.name}
                          columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder={l.party_name || '--Select--'}
                          onSelect={(x) => setLine(i, { party_id: x?.id || '', party_name: x?.name || '' })} />
                      : <span className="muted">—</span>}
                  </td>
                  <td><input type="number" step="0.01" style={{ width: 100, textAlign: 'right' }} value={l.debit}
                    onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></td>
                  <td><input type="number" step="0.01" style={{ width: 100, textAlign: 'right' }} value={l.credit}
                    onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></td>
                  <td><input style={{ width: 160 }} value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={5} style={{ textAlign: 'right' }}>Total</td>
                <td style={{ textAlign: 'right' }}>{money(totalDebit)}</td>
                <td style={{ textAlign: 'right' }}>{money(totalCredit)}</td>
                <td style={{ color: balanced ? '#16a34a' : '#dc2626' }}>{balanced ? 'Balanced' : `Off by ${money(Math.abs(totalDebit - totalCredit))}`}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <button className="btn btn-sm btn-primary" style={{ marginTop: 10 }} onClick={addLine}>Add Line</button>
      </div>
    </div>
  );
}
