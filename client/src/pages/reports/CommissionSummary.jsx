import { useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import CommissionPayableCell from '../../components/CommissionPayableCell';
import { downloadFile } from '../../utils/downloadFile';

// Commission Summary (asked 2026-10-14; server lib/commissionSummaryWorkbook.js): every rep's year,
// grouped as the team's own spreadsheet -- a tab per group (Sales Manager, SBU, Sales-1 ... Branch
// SM), a block per person, a TOTAL of Unpaid Commission under each. Extract gives the same as Excel.
// The figures are the Commission report's; who is listed is who the user may see there.
const money = (v) => (Number(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const COLS = [
  ['quota', 'Quota'], ['division_name', 'Sales Division'], ['weighted_sales', 'Weighted Sales'], ['performance_pct', '%'],
  ['estimated_commission', 'Estimated Commission'], ['passing_gp_total', "Total Amount of JO's with Passing Rate"],
  ['expected_commission', 'Expected Commission'], ['confirmed_commission', 'Confirmed Commission'],
  ['released_commission', 'Released Commission'], ['expenses_deducted', 'Deducted'], ['expenses_refunded', 'Refunded'],
  ['unpaid_commission', 'Unpaid Commission'],
];

export default function CommissionSummary() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('');
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/reports/commission/summary', { params: { year }, timeout: 300000 });
      setData(d);
      setTab(d.sheets[0]?.name || '');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not generate the report.');
    }
    setLoading(false);
  }

  async function extract() {
    setExtracting(true); setError('');
    try {
      await downloadFile('/reports/commission/summary', { year, format: 'xlsx' }, `commission-${year}.xlsx`);
    } catch {
      setError('Could not extract the report.');
    }
    setExtracting(false);
  }

  // Lock / Unlock (System Admin and Accounting: data.can_lock). Only finished months -- before the
  // current one -- can be locked; the server checks the same. The reply carries the person's
  // refreshed rows, swapped into their block in place.
  const [lockBusy, setLockBusy] = useState('');
  const now = new Date();
  const finished = (m) => year * 12 + m < now.getFullYear() * 12 + now.getMonth() + 1;
  async function setLock(block, months, action) {
    if (!months.length) return;
    const names = months.map((m) => block.rows.find((r) => r.month === m)?.month_name).join(', ');
    const msg = action === 'lock'
      ? `Lock ${names} for ${block.name}?\n\nThe figures shown now are kept as they are: later invoices and payments will not change them. Only new releases change Unpaid.`
      : `Unlock ${names} for ${block.name}?\n\nThe month(s) will be recalculated from today's invoices and payments, so Confirmed and Unpaid may change.`;
    if (!window.confirm(msg)) return;
    setLockBusy(`${block.employee_id}`); setError('');
    try {
      const { data: d } = await api.post('/reports/commission/locks', { employeeId: block.employee_id, year, months, action }, { timeout: 300000 });
      setData((prev) => ({
        ...prev,
        sheets: prev.sheets.map((s) => ({
          ...s,
          blocks: s.blocks.map((b) => (b.employee_id === block.employee_id ? { ...b, rows: d.rows, total_unpaid: d.total_unpaid } : b)),
        })),
      }));
    } catch (e) {
      setError(e.response?.data?.error || `Could not ${action} the month(s).`);
    }
    setLockBusy('');
  }

  const sheet = data?.sheets.find((s) => s.name === tab);
  const canLock = !!data?.can_lock;
  return (
    <div>
      <div className="page-header"><h1>Commission Summary</h1></div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Year</label>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
        <button className="btn" style={{ marginTop: 12, marginLeft: 8 }} onClick={extract} disabled={extracting}>
          {extracting ? 'Extracting...' : 'Extract'}
        </button>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          One sheet per group, one block per person, the same figures as the Commission report. Extract gives the Excel workbook.
          CP # is the month&apos;s Commission Payable; <span style={{ color: '#b91c1c', fontWeight: 600 }}>No CP</span> means none has been created: that month cannot be released on a voucher, and its Confirmed and Unpaid Commission are not shown until one is.
          {' '}🔒 marks a locked month: its figures are kept as they were handed over for release, and only new releases change its Unpaid.
          {data?.can_lock && ' A lock stays until someone unlocks it here; only finished months can be locked.'}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <LoadingSpinner label="Generating..." />}

      {!loading && data && (
        <div className="card">
          <div className="status-tabs" style={{ marginBottom: 12 }}>
            {data.sheets.map((s) => (
              <button key={s.name} type="button" className={`status-tab ${tab === s.name ? 'active' : ''}`} onClick={() => setTab(s.name)}>
                {s.name} <span className="badge badge-muted">{s.blocks.length}</span>
              </button>
            ))}
          </div>
          {!data.sheets.length && <div className="muted">No commissioned sales reps to report on.</div>}
          {sheet?.blocks.map((b) => {
            const busy = lockBusy === `${b.employee_id}`;
            const toLock = b.rows.filter((r) => !r.locked && finished(r.month) && (Number(r.expected_commission) || Number(r.released_commission))).map((r) => r.month);
            const toUnlock = b.rows.filter((r) => r.locked).map((r) => r.month);
            return (
            <div key={b.employee_id} style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ fontWeight: 700 }}>{b.label}: {b.name}</span>
                {canLock && (
                  <>
                    <button type="button" className="btn btn-sm" disabled={busy || !toLock.length} onClick={() => setLock(b, toLock, 'lock')}
                      title="Keep every finished month's figures as they are now">
                      🔒 Lock all finished months
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy || !toUnlock.length} onClick={() => setLock(b, toUnlock, 'unlock')}
                      title="Recalculate every locked month from today's invoices and payments">
                      Unlock all
                    </button>
                    {busy && <span className="muted" style={{ fontSize: 12 }}>Saving...</span>}
                  </>
                )}
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th rowSpan={2}>Month</th>
                      <th rowSpan={2}>CP #</th>
                      {COLS.filter(([k]) => !['expenses_deducted', 'expenses_refunded'].includes(k)).map(([k, label]) => (
                        k === 'unpaid_commission'
                          ? [<th key="exp" colSpan={2} style={{ textAlign: 'center' }}>Expenses</th>, <th key={k} rowSpan={2} style={{ textAlign: 'right' }}>{label}</th>]
                          : <th key={k} rowSpan={2} style={{ textAlign: k === 'division_name' ? 'left' : 'right' }}>{label}</th>
                      ))}
                      {canLock && <th rowSpan={2} style={{ textAlign: 'center' }}>Lock</th>}
                    </tr>
                    <tr><th style={{ textAlign: 'right' }}>Deducted</th><th style={{ textAlign: 'right' }}>Refunded</th></tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r) => (
                      <tr key={r.month}>
                        <td>{r.month_name}</td>
                        <td><CommissionPayableCell row={r} /></td>
                        {COLS.map(([k]) => (
                          <td key={k} style={{ textAlign: k === 'division_name' ? 'left' : 'right' }}
                            title={k === 'confirmed_commission' && r.locked ? `Locked${r.locked_source ? ` from ${r.locked_source}` : ''}: kept as handed over for release, not recomputed from invoices` : undefined}>
                            {k === 'confirmed_commission' && r.locked && <span aria-label="Locked" style={{ marginRight: 4, fontSize: '0.85em' }}>🔒</span>}
                            {k === 'division_name' ? (r[k] || '') : money(r[k])}
                          </td>
                        ))}
                        {canLock && (
                          <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                            {r.locked && (
                              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setLock(b, [r.month], 'unlock')}
                                title={r.locked_source || 'Locked'}>
                                Unlock
                              </button>
                            )}
                            {!r.locked && finished(r.month) && (Number(r.expected_commission) || Number(r.released_commission)) ? (
                              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setLock(b, [r.month], 'lock')}>
                                Lock
                              </button>
                            ) : null}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td colSpan={COLS.length + 1} style={{ textAlign: 'right' }}>TOTAL</td>
                      <td style={{ textAlign: 'right' }}>{money(b.total_unpaid) || '0.00'}</td>
                      {canLock && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
