import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GROUPS = [['admin', 'Admin Expenses'], ['selling', 'Selling Expenses'], ['cogs', 'COGS (Production)']];
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const STATUS = { draft: 'Draft', approved: 'Approved', superseded: 'Superseded' };

// A department budget, in the accounting workbook's shape: one monthly budget per department
// (Admin / Selling) and for COGS. The monthly Sales Target is what the budget is sized against --
// give a row a % of sales and its twelve months are Sales Target x %, or type the months directly.
export default function DeptBudgetEdit({ budget: b, onReload }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [target, setTarget] = useState(b.sales_target ?? '');
  const [rows, setRows] = useState(b.rows);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The spec is one Monthly Budget per department (typed, or % of the Sales Target). Month-by-month
  // amounts are there for the exception, behind a link, not in everyone's way.
  const [showMonths, setShowMonths] = useState(false);
  useEffect(() => { setRows(b.rows); setTarget(b.sales_target ?? ''); setDirty(false); }, [b]);

  const editable = b.status === 'draft' && can('/budgets', 'can_edit');
  const patchRow = (id, patch) => { setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))); setDirty(true); };
  const fromPct = (pct, t) => (pct === '' || pct == null || !Number(t) ? null : Math.round(Number(t) * Number(pct)) / 100);
  function setPct(r, pct) {
    const amt = fromPct(pct, target);
    patchRow(r.id, { pct, ...(amt != null ? { amounts: new Array(12).fill(amt) } : {}) });
  }
  // A new Sales Target rescales every row that is set as a % of sales.
  function changeTarget(t) {
    setTarget(t); setDirty(true);
    setRows((rs) => rs.map((r) => { const amt = fromPct(r.pct, t); return amt != null ? { ...r, amounts: new Array(12).fill(amt) } : r; }));
  }
  const setMonth = (r, i, v) => { const a = [...r.amounts]; a[i] = v; patchRow(r.id, { amounts: a, pct: null }); };
  const setAll = (r, v) => patchRow(r.id, { amounts: new Array(12).fill(v), pct: null });
  const annual = (r) => r.amounts.reduce((s, v) => s + (Number(v) || 0), 0);

  async function run(label, fn) {
    setBusy(label); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e.response?.data?.error || `Could not ${label.toLowerCase()}.`); }
    setBusy('');
  }
  const save = () => run('Save', async () => {
    await api.put(`/budgets/${b.id}/rows`, {
      sales_target: target,
      rows: rows.map((r) => ({ id: r.id, pct: r.pct, remarks: r.remarks, amounts: r.amounts.map((v) => Number(v) || 0) })),
    });
    setDirty(false); setNotice('Saved.'); await onReload();
  });
  const importWorkbook = (file) => run('Import', async () => {
    if (!file) return;
    const base64 = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1]); fr.onerror = reject; fr.readAsDataURL(file); });
    const { data } = await api.post(`/budgets/${b.id}/import-workbook`, { file_base64: base64 });
    await onReload();
    setNotice(`Imported ${data.rows_updated} rows${data.sales_target ? `, Sales Target ${money(data.sales_target)}` : ''}.${data.unmatched.length ? ` Not matched: ${data.unmatched.join(', ')}.` : ''}`);
  });
  const approve = () => run('Approve', async () => {
    if (dirty) { setError('Save your changes before approving.'); return; }
    if (!window.confirm('Approve this budget? It becomes read-only and replaces any earlier approved department budget for the same year.')) return;
    await api.post(`/budgets/${b.id}/approve`); await onReload(); setNotice('Approved.');
  });
  const newVersion = () => run('New version', async () => { const { data } = await api.post(`/budgets/${b.id}/new-version`); navigate(`/budgets/${data.id}`); });
  const remove = () => run('Delete', async () => { if (!window.confirm('Delete this draft budget?')) return; await api.delete(`/budgets/${b.id}`); navigate('/budgets'); });

  const groupTotal = (grp, i) => rows.filter((r) => r.grp === grp).reduce((s, r) => s + (Number(r.amounts[i]) || 0), 0);

  return (
    <div>
      <div className="page-header">
        <h1>{b.name} <span className="muted" style={{ fontSize: '0.6em' }}>FY {b.fiscal_year} · v{b.version} · {STATUS[b.status]}</span></h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/budgets')}>Back</button>
          {editable && (
            <label className="btn btn-sm" style={{ cursor: 'pointer' }} title="The accounting workbook: sheets with a 'Department | Monthly Budget' table and a 'Month | Budget' COGS table">
              Import Accounting Workbook
              <input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => { importWorkbook(e.target.files[0]); e.target.value = ''; }} />
            </label>
          )}
          {editable && <button className="btn btn-sm btn-primary" disabled={!!busy || !dirty} onClick={save}>{busy === 'Save' ? 'Saving...' : 'Save'}</button>}
          {b.status === 'draft' && can('/budgets', 'can_approve') && <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={approve}>Approve</button>}
          {b.status !== 'draft' && can('/budgets', 'can_add') && <button className="btn btn-sm" disabled={!!busy} onClick={newVersion}>New Version</button>}
          {b.status === 'draft' && can('/budgets', 'can_delete') && <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={remove}>Delete</button>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Monthly Sales Target (the budget is sized against this)</label>
          {editable
            ? <input type="number" step="0.01" value={target} onChange={(e) => changeTarget(e.target.value)} style={{ width: 180 }} placeholder="e.g. 8500000" />
            : <strong>{target ? money(target) : '—'}</strong>}
        </div>
        <div className="muted" style={{ maxWidth: 560 }}>
          Give a department a <strong>% of sales</strong> and its budget becomes Sales Target × % every month; change the target and those rows follow.
          Or type the monthly budget (it fills all 12 months) or individual months.
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 12, padding: '8px 12px' }}>{notice}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => setShowMonths((v) => !v)}>{showMonths ? 'Hide months' : 'Show months (set a different budget per month)'}</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Department</th><th className="text-right">% of Sales</th><th className="text-right">Monthly Budget</th>
                {showMonths && MONTHS.map((m) => <th key={m} className="text-right">{m}</th>)}
                <th className="text-right">Annual Budget</th><th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.map(([grp, label]) => (
                <Fragment key={grp}>
                  <tr><td colSpan={showMonths ? 17 : 5} style={{ fontWeight: 700, background: 'var(--surface-2, #f3f4f6)' }}>{label}</td></tr>
                  {rows.filter((r) => r.grp === grp).map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.label}
                        {r.label === 'Support' && <div className="muted" style={{ fontSize: 11 }}>IT, System, Quality, Costing, Technical/Engineering</div>}
                        {grp !== 'cogs' && !r.department_id && r.label !== 'Support' && <span className="muted" style={{ fontSize: 11 }} title="No T1S department of this name: actuals come from the old system up to the cut-over only"> (no T1S dept)</span>}
                      </td>
                      <td className="text-right">
                        {editable ? <input type="number" step="0.01" style={{ width: 70, textAlign: 'right' }} value={r.pct ?? ''} onChange={(e) => setPct(r, e.target.value)} /> : (r.pct != null ? `${r.pct}%` : '')}
                      </td>
                      <td className="text-right">
                        {editable
                          ? <input type="number" step="0.01" style={{ width: 110, textAlign: 'right', fontWeight: 600, color: '#0070c0' }} value={r.amounts[0] || ''} onChange={(e) => setAll(r, e.target.value)} />
                          : <strong style={{ color: '#0070c0' }}>{money(r.amounts[0])}</strong>}
                      </td>
                      {showMonths && MONTHS.map((m, i) => (
                        <td key={m} className="text-right">
                          {editable
                            ? <input type="number" step="0.01" style={{ width: 96, textAlign: 'right' }} value={r.amounts[i] || ''} onChange={(e) => setMonth(r, i, e.target.value)} />
                            : money(r.amounts[i])}
                        </td>
                      ))}
                      <td className="text-right"><strong>{money(annual(r))}</strong></td>
                      <td>{editable ? <input style={{ width: 200 }} value={r.remarks || ''} onChange={(e) => patchRow(r.id, { remarks: e.target.value })} /> : (r.remarks || '')}</td>
                    </tr>
                  ))}
                  {grp !== 'cogs' && (
                    <tr style={{ fontWeight: 700 }}>
                      <td>Total</td><td></td><td className="text-right">{money(groupTotal(grp, 0))}</td>
                      {showMonths && MONTHS.map((m, i) => <td key={m} className="text-right">{money(groupTotal(grp, i))}</td>)}
                      <td className="text-right">{money(MONTHS.reduce((s, _, i) => s + groupTotal(grp, i), 0))}</td><td></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
