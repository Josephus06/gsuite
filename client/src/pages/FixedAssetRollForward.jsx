import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatMoney, formatMonth } from '../utils/assetLabels';

function thisMonth() { return new Date().toISOString().slice(0, 7); }
function janThisYear() { return `${new Date().getFullYear()}-01`; }

// The fixed asset roll forward: the schedule auditors ask for. Beginning balance, additions,
// disposals, depreciation, ending balance -- for cost and accumulated depreciation independently,
// so both columns can be tied out rather than taken on trust.
export default function FixedAssetRollForward() {
  const [from, setFrom] = useState(janThisYear());
  const [to, setTo] = useState(thisMonth());
  const [applied, setApplied] = useState({ from: janThisYear(), to: thisMonth() });
  const [report, setReport] = useState(null);
  const [detail, setDetail] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/reports/fixed-asset-roll-forward', { params: applied });
      setReport(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not generate the report.'); }
    setLoading(false);
  }, [applied]);

  useEffect(() => { load(); }, [load]);

  async function toggleDetail(classId) {
    if (expanded === classId) { setExpanded(null); return; }
    setExpanded(classId);
    const { data } = await api.get('/reports/fixed-asset-detail', { params: { to: applied.to, asset_class_id: classId } });
    setDetail(data);
  }

  const t = report?.totals || {};

  return (
    <div>
      <div className="page-header">
        <h1>Fixed Asset Roll Forward</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/assets">Assets</Link>
          <Link className="btn btn-sm" to="/asset-depreciation">Depreciation</Link>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>From</label>
            <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="month" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setApplied({ from, to })}>Generate</button>
      </div>

      {loading ? <LoadingSpinner /> : report && (
        <>
          <div className="card">
            <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
              {formatMonth(report.from)} to {formatMonth(report.to)}
            </h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Cost and accumulated depreciation each roll forward independently. Click a class to see the assets behind it.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2}>Asset Class</th>
                    <th colSpan={4} style={{ textAlign: 'center', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Cost</th>
                    <th colSpan={4} style={{ textAlign: 'center', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Accumulated Depreciation</th>
                    <th rowSpan={2} style={{ textAlign: 'right' }}>Net Book Value</th>
                  </tr>
                  <tr>
                    <th style={{ textAlign: 'right' }}>Beginning</th>
                    <th style={{ textAlign: 'right' }}>Additions</th>
                    <th style={{ textAlign: 'right' }}>Disposals</th>
                    <th style={{ textAlign: 'right' }}>Ending</th>
                    <th style={{ textAlign: 'right' }}>Beginning</th>
                    <th style={{ textAlign: 'right' }}>Depreciation</th>
                    <th style={{ textAlign: 'right' }}>Disposals</th>
                    <th style={{ textAlign: 'right' }}>Ending</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.rows || []).length === 0 && (
                    <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No capitalised assets in this range.</td></tr>
                  )}
                  {(report.rows || []).map((r) => (
                    <tr key={r.class_id} onClick={() => toggleDetail(r.class_id)} style={{ cursor: 'pointer' }}>
                      <td><strong>{r.class_name}</strong></td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(r.opening_cost)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(r.additions)}</td>
                      <td style={{ textAlign: 'right' }}>{r.disposed_cost ? `(${formatMoney(r.disposed_cost)})` : '—'}</td>
                      <td style={{ textAlign: 'right' }}><strong>{formatMoney(r.ending_cost)}</strong></td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(r.opening_accumulated)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(r.depreciation)}</td>
                      <td style={{ textAlign: 'right' }}>{r.disposed_accumulated ? `(${formatMoney(r.disposed_accumulated)})` : '—'}</td>
                      <td style={{ textAlign: 'right' }}><strong>{formatMoney(r.ending_accumulated)}</strong></td>
                      <td style={{ textAlign: 'right' }}><strong>{formatMoney(r.ending_nbv)}</strong></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(t.opening_cost)}</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(t.additions)}</th>
                    <th style={{ textAlign: 'right' }}>{t.disposed_cost ? `(${formatMoney(t.disposed_cost)})` : '—'}</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(t.ending_cost)}</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(t.opening_accumulated)}</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(t.depreciation)}</th>
                    <th style={{ textAlign: 'right' }}>{t.disposed_accumulated ? `(${formatMoney(t.disposed_accumulated)})` : '—'}</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(t.ending_accumulated)}</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(t.ending_nbv)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {Number(t.disposal_count) > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Disposals in the period</h2>
              <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <div>Assets disposed : <span className="hi">{t.disposal_count}</span></div>
                <div>Proceeds : <span className="hi">{formatMoney(t.proceeds)}</span></div>
                <div>
                  {Number(t.gain_loss) < 0 ? 'Loss' : 'Gain'} on disposal :{' '}
                  <span className="hi">{Number(t.gain_loss) < 0 ? `(${formatMoney(Math.abs(Number(t.gain_loss)))})` : formatMoney(t.gain_loss)}</span>
                </div>
              </div>
            </div>
          )}

          {expanded && detail && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="page-header" style={{ marginBottom: 12 }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>
                  {(report.rows || []).find((r) => r.class_id === expanded)?.class_name} — assets as at {formatMonth(report.to)}
                </h2>
                <button className="btn btn-sm" onClick={() => setExpanded(null)}>Close</button>
              </div>
              <div className="table-wrap">
                <table className="responsive-cards">
                  <thead>
                    <tr>
                      <th>Reference No</th><th>Asset</th><th>In Service</th><th style={{ textAlign: 'right' }}>Life</th>
                      <th style={{ textAlign: 'right' }}>Cost</th><th style={{ textAlign: 'right' }}>Accumulated</th>
                      <th style={{ textAlign: 'right' }}>Net Book Value</th><th>Disposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Reference No">{a.reference_no}</td>
                        <td data-label="Asset">{a.item_name}</td>
                        <td data-label="In Service">{a.in_service_date ? String(a.in_service_date).slice(0, 10) : '—'}</td>
                        <td data-label="Life" style={{ textAlign: 'right' }}>{a.useful_life_months ? `${a.useful_life_months} mo` : '—'}</td>
                        <td data-label="Cost" style={{ textAlign: 'right' }}>{formatMoney(a.cost)}</td>
                        <td data-label="Accumulated" style={{ textAlign: 'right' }}>{formatMoney(a.accumulated)}</td>
                        <td data-label="Net Book Value" style={{ textAlign: 'right' }}>{formatMoney(a.net_book_value)}</td>
                        <td data-label="Disposed">{a.disposal_no || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
