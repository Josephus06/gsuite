import { useEffect, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import { money } from './CoaTreeRows';

function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

// Mirrors the real system's Accounting > Reports > AR Aging: a Location / Name Starts /
// No Location / Date-as-of filter bar + Generate, then a customer-per-row table split into
// Current / 1-30 / 31-60 / 61-90 / Over-90 buckets with a totals row. DETAILS and LEDGER
// drill each customer down to the open items behind the number, and the full transaction
// history, respectively.
export default function ArAging() {
  const [asOf, setAsOf] = useState(today());
  const [locationId, setLocationId] = useState('');
  const [noLocation, setNoLocation] = useState(false);
  const [nameStarts, setNameStarts] = useState('');
  const [locations, setLocations] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null); // { mode: 'details'|'ledger', customer, data }
  const [drillLoading, setDrillLoading] = useState(false);

  useEffect(() => {
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
  }, []);

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const params = { asOf };
      if (noLocation) params.noLocation = true;
      else if (locationId) params.locationId = locationId;
      if (nameStarts) params.nameStarts = nameStarts;
      const { data } = await api.get('/reports/ar-aging', { params });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  async function openDrill(mode, customer) {
    setDrill({ mode, customer, data: null });
    setDrillLoading(true);
    try {
      const { data } = await api.get(`/reports/ar-aging/customer/${customer.customer_id}/${mode}`, { params: { asOf } });
      setDrill({ mode, customer, data });
    } catch (err) {
      setDrill({ mode, customer, data: null, error: err.response?.data?.error || 'Failed to load' });
    } finally {
      setDrillLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>AR Aging</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Location</label>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={noLocation}>
              <option value="">--ALL--</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Name Starts (eg. ABCD)</label>
            <input value={nameStarts} onChange={(e) => setNameStarts(e.target.value)} placeholder="Name Starts" />
          </div>
          <div className="field">
            <label>No Location</label>
            <input type="checkbox" checked={noLocation} onChange={(e) => setNoLocation(e.target.checked)} />
          </div>
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
          <div style={{ marginBottom: 12 }}><strong>As of {report.as_of}</strong></div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Customer Name</th>
                  <th style={{ textAlign: 'right' }}>Current</th>
                  <th style={{ textAlign: 'right' }}>1-30 days</th>
                  <th style={{ textAlign: 'right' }}>31-60 days</th>
                  <th style={{ textAlign: 'right' }}>61-90 days</th>
                  <th style={{ textAlign: 'right' }}>Over 90 days</th>
                  <th style={{ textAlign: 'right' }}>Total Balance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No outstanding balances as of this date.</td></tr>
                )}
                {report.rows.map((row) => (
                  <tr key={row.customer_id}>
                    <td data-label="Customer">{row.customer_name}</td>
                    <td data-label="Current" style={{ textAlign: 'right' }}>{money(row.current)}</td>
                    <td data-label="1-30 days" style={{ textAlign: 'right' }}>{money(row.d1_30)}</td>
                    <td data-label="31-60 days" style={{ textAlign: 'right' }}>{money(row.d31_60)}</td>
                    <td data-label="61-90 days" style={{ textAlign: 'right' }}>{money(row.d61_90)}</td>
                    <td data-label="Over 90 days" style={{ textAlign: 'right' }}>{money(row.over_90)}</td>
                    <td data-label="Total Balance" style={{ textAlign: 'right', fontWeight: 600 }}>{money(row.total_balance)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-primary" style={{ marginRight: 4 }} onClick={() => openDrill('details', row)}>Details</button>
                      <button className="btn btn-sm btn-primary" onClick={() => openDrill('ledger', row)}>Ledger</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {report.rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td style={{ textAlign: 'right' }}>Total :</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.current)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.d1_30)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.d31_60)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.d61_90)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.over_90)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.total_balance)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {drill && (
        <Modal
          title={`${drill.mode === 'details' ? 'AR Details' : 'Customer Ledger'} — ${drill.customer.customer_name}`}
          onClose={() => setDrill(null)}
          xl
        >
          {drillLoading && <LoadingSpinner />}
          {drill.error && <div className="error-banner">{drill.error}</div>}
          {!drillLoading && drill.data && drill.mode === 'details' && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Type</th><th>Reference</th><th>Date</th><th>Due Date</th><th style={{ textAlign: 'right' }}>Original</th><th style={{ textAlign: 'right' }}>Balance</th><th style={{ textAlign: 'right' }}>Days Overdue</th></tr>
                </thead>
                <tbody>
                  {drill.data.items.length === 0 && (
                    <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No open items.</td></tr>
                  )}
                  {drill.data.items.map((it, idx) => (
                    <tr key={idx}>
                      <td>{it.type}</td>
                      <td>{it.reference}</td>
                      <td>{formatDate(it.date)}</td>
                      <td>{formatDate(it.due_date)}</td>
                      <td style={{ textAlign: 'right' }}>{money(it.original_amount)}</td>
                      <td style={{ textAlign: 'right' }}>{money(it.balance)}</td>
                      <td style={{ textAlign: 'right' }}>{it.days_overdue}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={5} style={{ textAlign: 'right' }}>Total Balance :</td>
                    <td style={{ textAlign: 'right' }}>{money(drill.data.total_balance)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {!drillLoading && drill.data && drill.mode === 'ledger' && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>Type</th><th>Reference</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Running Balance</th></tr>
                </thead>
                <tbody>
                  {drill.data.ledger.length === 0 && (
                    <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transactions.</td></tr>
                  )}
                  {drill.data.ledger.map((e, idx) => (
                    <tr key={idx}>
                      <td>{formatDate(e.date)}</td>
                      <td>{e.type}</td>
                      <td>{e.reference}</td>
                      <td style={{ textAlign: 'right' }}>{money(e.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{money(e.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={4} style={{ textAlign: 'right' }}>Total Balance :</td>
                    <td style={{ textAlign: 'right' }}>{money(drill.data.total_balance)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
