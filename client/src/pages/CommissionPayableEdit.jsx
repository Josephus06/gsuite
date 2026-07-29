import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function formatMonth(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''; }
function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

// Standalone create form for a Commission Payable (the live #/commission_payable_crud screen). The
// employee is "user based": a normal user can only raise their own (name locked), while a System
// Admin may generate a payable for any sales account (employee picker). Department + office
// location auto-fill from the chosen employee. You pick the commission month, Compute, and Save.
export default function CommissionPayableEdit() {
  const navigate = useNavigate();
  const [context, setContext] = useState(null); // { is_admin, self, employees }
  const [emp, setEmp] = useState(null);          // { id, name, department_name, office_location_name }
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [month, setMonth] = useState(currentMonth());
  const [memo, setMemo] = useState('');

  const [computed, setComputed] = useState(null);
  const [computing, setComputing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/commission-payables/my-context')
      .then(({ data }) => {
        setContext(data);
        if (!data.is_admin && data.self) setEmp(data.self); // normal user: locked to self
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load your employee profile.'));
  }, []);

  const isAdmin = context?.is_admin;

  async function handleCompute() {
    setError(''); setComputed(null);
    if (!month) { setError('Select the commission month.'); return; }
    if (isAdmin && !emp) { setError('Select an employee.'); return; }
    setComputing(true);
    try {
      const params = { month };
      if (isAdmin && emp) params.employee_id = emp.id;
      const { data } = await api.get('/commission-payables/compute', { params });
      setComputed(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Compute failed.');
    } finally {
      setComputing(false);
    }
  }

  async function handleSave() {
    setError('');
    if (!computed) { setError('Click Compute Commission first.'); return; }
    setSaving(true);
    try {
      const body = { date_created: date, month, memo: memo || null };
      if (isAdmin && emp) body.employee_id = emp.id;
      const { data } = await api.post('/commission-payables', body);
      navigate(`/commission-payables/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
      setSaving(false);
    }
  }

  const t = computed?.totals;
  const summary = [
    ['Quota', t?.quota], ['Weighted Sales', t?.weighted_sales], ['JO with Passing GP Rate', t?.passing_jos],
    ['Expected Commission', t?.expected_commission], ['Commission Amount', t?.commissionable_amount],
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Commission Payable</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/commission-payables')}>Back to Lists</button>
          <button className="btn btn-sm btn-primary" disabled={saving || !computed} onClick={handleSave}>Save</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Commission Date</label>
            <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setComputed(null); }} />
          </div>
          <div className="field">
            <label>Employee</label>
            {isAdmin ? (
              <EntityPicker
                label="Employee" items={context?.employees || []} value={emp?.id || ''} getLabel={(e) => e.name}
                columns={[{ key: 'name', label: 'Name' }, { key: 'department_name', label: 'Department' }]}
                searchKeys={['name', 'department_name']} placeholder="--Select--"
                onSelect={(e) => { setEmp(e); setComputed(null); }}
              />
            ) : (
              <input value={emp?.name || ''} readOnly placeholder="Loading..." />
            )}
          </div>
          <div className="field">
            <label>Office Location</label>
            <input value={emp?.office_location_name || ''} readOnly />
          </div>
          <div className="field">
            <label>Department</label>
            <input value={emp?.department_name || ''} readOnly />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Memo</label>
            <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={computing || !context || (isAdmin && !emp)} onClick={handleCompute}>
          {computing ? <LoadingSpinner inline size="sm" label="Computing..." /> : 'Compute Commission'}
        </button>
      </div>

      {computed && (
        <>
          <div className="card" style={{ marginBottom: 16, maxWidth: 420, marginLeft: 'auto' }}>
            {summary.map(([label, val]) => (
              <div key={label} className="commission-summary-row"><span>{label}</span><span className="hi">{money(val)}</span></div>
            ))}
            {computed.scheme_name && <div className="muted" style={{ marginTop: 8, textAlign: 'right' }}>Scheme: {computed.scheme_name}</div>}
          </div>

          <div className="card">
            <strong>Commissions</strong>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead><tr>
                  <th>#</th><th>Date</th><th style={{ textAlign: 'right' }}>Quota</th><th style={{ textAlign: 'right' }}>Weighted</th>
                  <th style={{ textAlign: 'right' }}>JO with Passing GP Rate</th><th style={{ textAlign: 'right' }}>Expected Comission</th>
                  <th style={{ textAlign: 'right' }}>Confirmed Comission</th><th style={{ textAlign: 'right' }}>Released Comission</th>
                  <th style={{ textAlign: 'right' }}>Commissionable Amount</th>
                </tr></thead>
                <tbody>
                  {computed.lines.map((l, i) => (
                    <tr key={l.line_month}>
                      <td>{i + 1}</td>
                      <td>{formatMonth(l.line_month)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.quota)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.weighted)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.passing_jos)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.expected)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.confirmed)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.released)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
