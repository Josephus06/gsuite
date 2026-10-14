import { useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
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

  const sheet = data?.sheets.find((s) => s.name === tab);
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
          {sheet?.blocks.map((b) => (
            <div key={b.employee_id} style={{ marginBottom: 24 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{b.label}: {b.name}</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th rowSpan={2}>Month</th>
                      {COLS.filter(([k]) => !['expenses_deducted', 'expenses_refunded'].includes(k)).map(([k, label]) => (
                        k === 'unpaid_commission'
                          ? [<th key="exp" colSpan={2} style={{ textAlign: 'center' }}>Expenses</th>, <th key={k} rowSpan={2} style={{ textAlign: 'right' }}>{label}</th>]
                          : <th key={k} rowSpan={2} style={{ textAlign: k === 'division_name' ? 'left' : 'right' }}>{label}</th>
                      ))}
                    </tr>
                    <tr><th style={{ textAlign: 'right' }}>Deducted</th><th style={{ textAlign: 'right' }}>Refunded</th></tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r) => (
                      <tr key={r.month}>
                        <td>{r.month_name}</td>
                        {COLS.map(([k]) => (
                          <td key={k} style={{ textAlign: k === 'division_name' ? 'left' : 'right' }}>
                            {k === 'division_name' ? (r[k] || '') : money(r[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td colSpan={COLS.length} style={{ textAlign: 'right' }}>TOTAL</td>
                      <td style={{ textAlign: 'right' }}>{money(b.total_unpaid) || '0.00'}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
