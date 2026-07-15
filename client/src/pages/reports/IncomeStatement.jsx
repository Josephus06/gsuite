import { useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { money } from './CoaTreeRows';

function today() { return new Date().toISOString().slice(0, 10); }

const BREAKDOWN_OPTIONS = [
  { value: 'total', label: 'Total Only' },
  { value: 'months', label: 'Months' },
  { value: 'location', label: 'Location' },
  { value: 'department', label: 'Department' },
];

// Every row/column here is generic over `report.columns` (always >=1 entries, even in
// Total Only mode) -- one shared rendering path for all 4 breakdown modes, matching how
// the backend (reportsEngine.js's buildIncomeStatement) computes them through the same
// multi-column pipeline.
function SectionRows({ sections, numCols }) {
  const rows = [];
  for (const s of sections) {
    rows.push(
      <tr key={`sub-${s.sub_type}`}>
        <td colSpan={2} style={{ fontStyle: 'italic', paddingLeft: 12 }}>{s.sub_type}</td>
        {Array.from({ length: numCols }).map((_, i) => <td key={i} />)}
      </tr>
    );
    for (const a of s.accounts) {
      rows.push(
        <tr key={a.account_code}>
          <td style={{ paddingLeft: 24 }}>{a.account_code}</td>
          <td>{a.account_name}</td>
          {a.amounts.map((v, i) => (
            <td key={i} style={{ textAlign: 'right' }}>{money(v)} <span style={{ color: 'var(--muted, #888)', fontSize: '0.85em' }}>({a.percents[i]}%)</span></td>
          ))}
        </tr>
      );
    }
    rows.push(
      <tr key={`subtotal-${s.sub_type}`}>
        <td /><td style={{ fontWeight: 600 }}>Total {s.sub_type}</td>
        {s.subtotals.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 600 }}>{money(v)}</td>)}
      </tr>
    );
  }
  return rows;
}

// Mirrors the real system's Accounting > Reports > Income Statement, including its
// split "Generate" button (Total Only/Months/Location/Department breakdown modes) and
// its "Date:" row filter-type dropdown ("As of" = calendar-year-to-date through the
// date; "Period from" = an explicit custom range) -- the same filter/date1/date2 shape
// the other 3 reports use.
export default function IncomeStatement() {
  const [filterType, setFilterType] = useState('as_of');
  const [asOf, setAsOf] = useState(today());
  const [fromDate, setFromDate] = useState(today());
  const [breakdown, setBreakdown] = useState('total');
  const [menuOpen, setMenuOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function generate(mode) {
    setMenuOpen(false);
    setBreakdown(mode);
    setLoading(true);
    setError('');
    try {
      const params = { asOf, breakdown: mode };
      if (filterType === 'period_from') params.from = fromDate;
      const { data } = await api.get('/reports/income-statement', { params });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  const numCols = report?.columns?.length || 1;

  return (
    <div>
      <div className="page-header">
        <h1>Income Statement</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date</label>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="as_of">As of</option>
              <option value="period_from">Period from</option>
            </select>
          </div>
          {filterType === 'period_from' && (
            <div className="field">
              <label>From</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>{filterType === 'period_from' ? 'To' : 'Date as of'}</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
        <div style={{ position: 'relative', display: 'inline-block', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => setMenuOpen((v) => !v)} disabled={loading}>
            {loading ? 'Generating...' : 'Generate'} <span style={{ fontSize: '0.8em' }}>▾</span>
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 160,
              background: 'var(--surface, #fff)', border: '1px solid var(--border, #ddd)',
              borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 6, zIndex: 10,
            }}
            >
              {BREAKDOWN_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="link-btn"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px' }}
                  onClick={() => generate(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner />}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12 }}>
            <strong>{report.from_date} to {report.as_of}</strong>
            {report.breakdown !== 'total' && <span style={{ marginLeft: 12, color: 'var(--muted, #888)' }}>Breakdown: {BREAKDOWN_OPTIONS.find((o) => o.value === report.breakdown)?.label}</span>}
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Account</th><th></th>
                  {report.columns.map((c) => <th key={c.key} style={{ textAlign: 'right' }}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr><td colSpan={2 + numCols} style={{ fontWeight: 700, background: 'var(--panel-2, #f3f4f6)' }}>REVENUES</td></tr>
                <SectionRows sections={report.revenue_sections} numCols={numCols} />
                <tr>
                  <td /><td style={{ fontWeight: 700 }}>TOTAL REVENUES</td>
                  {report.revenue_totals.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 700 }}>{money(v)}</td>)}
                </tr>

                <tr><td colSpan={2 + numCols} style={{ fontWeight: 700, background: 'var(--panel-2, #f3f4f6)' }}>COST OF GOODS SOLD &amp; EXPENSES</td></tr>
                <SectionRows sections={report.expense_sections} numCols={numCols} />
                <tr>
                  <td /><td style={{ fontWeight: 700 }}>TOTAL EXPENSES</td>
                  {report.expense_totals.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 700 }}>{money(v)}</td>)}
                </tr>

                <tr>
                  <td /><td style={{ fontWeight: 700, fontSize: '1.05em' }}>NET INCOME</td>
                  {report.net_income.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 700, fontSize: '1.05em' }}>{money(v)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
