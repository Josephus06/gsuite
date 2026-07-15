import { Fragment, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import CoaTreeRows, { money } from './CoaTreeRows';

function today() { return new Date().toISOString().slice(0, 10); }

// Mirrors the real system's Accounting > Reports > Balance Sheet: same "as of" /
// Generate pattern and parent/child COA tree as Trial Balance, but only Asset,
// Liability, and Equity accounts. This build has no formal period-closing entries, so
// the backend adds a synthetic "Current Earnings (Unclosed)" line under Equity
// (cumulative Income - cumulative Expense to date) -- without it Assets would never
// actually equal Liabilities + Equity. Flagged in the UI, not hidden.
export default function BalanceSheet() {
  const [asOf, setAsOf] = useState(today());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/balance-sheet', { params: { asOf } });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Balance Sheet</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date as of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner />}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>As of {report.as_of}</strong>
            <span>Total Assets: {money(report.asset_total)}</span>
            <span>Total Liabilities &amp; Equity: {money(report.liability_equity_total)}</span>
            <span>Current Earnings (Unclosed): {money(report.current_earnings)}</span>
            <span style={{ color: report.balanced ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
              {report.balanced ? 'Balanced' : 'Out of Balance'}
            </span>
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Account Code</th>
                  <th>Account Title</th>
                  <th style={{ textAlign: 'right' }}>Debit</th>
                  <th style={{ textAlign: 'right' }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {report.data.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No activity as of this date.</td></tr>
                )}
                {report.data.map((typeGroup) => (
                  <Fragment key={`${typeGroup.normal}-${typeGroup.type}`}>
                    <tr>
                      <td colSpan={4} style={{ fontWeight: 700, background: 'var(--panel-2, #f3f4f6)' }}>{typeGroup.type}</td>
                    </tr>
                    {typeGroup.accounts.map((sub) => (
                      <Fragment key={`${typeGroup.type}-${sub.sub_type}`}>
                        <tr>
                          <td colSpan={4} style={{ fontStyle: 'italic', paddingLeft: 12 }}>{sub.sub_type}</td>
                        </tr>
                        {sub.account_ledgers.map((node) => (
                          <CoaTreeRows key={node.account_code} node={node} normal={typeGroup.normal} />
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
