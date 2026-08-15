import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import { money } from './CoaTreeRows';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function currentYear() { return new Date().getFullYear(); }
function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Per-JO commission detail for one rep in one month: every JO (own + team + any SBU-owned
// divisions) with its GP rate, net of tax and paid-invoice amount, split into JOs that met
// their job type's passing GP rate and those below it. This is the line-by-line backing
// behind the monthly Commission report's passing-GP total and Confirmed figure.
export default function CommissionJoDetail() {
  const { can } = useAuth();
  const [salesRep, setSalesRep] = useState(null);
  const [division, setDivision] = useState(null);
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [reps, setReps] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savingLine, setSavingLine] = useState(null);

  const canApprove = can('/commission-report', 'can_approve');

  // Add a below-GP job order to the rep's commission (or take it back out). The totals and the
  // GP Status column both move, so the report is regenerated rather than patched in place --
  // it keeps this screen honest about what the monthly Commission report will now say.
  async function toggleCommission(row, include) {
    if (!row.sales_order_line_id) return;
    setSavingLine(row.sales_order_line_id);
    setError('');
    try {
      await api.post('/reports/commission/jo-detail/add-to-commission', {
        sales_order_line_id: row.sales_order_line_id, include,
      });
      await generate();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update this job order.');
    } finally {
      setSavingLine(null);
    }
  }

  useEffect(() => {
    Promise.all([
      api.get('/reports/commission/sales-reps'),
      api.get('/lookups/sales-divisions'),
    ]).then(([repRes, divRes]) => { setReps(repRes.data); setDivisions(divRes.data); }).catch(() => {});
  }, []);

  async function generate() {
    if (!salesRep) { setError('Select a Sales Rep first.'); return; }
    setLoading(true);
    setError('');
    try {
      const params = { employeeId: salesRep.id, year, month };
      if (division) params.salesDivisionId = division.id;
      const { data } = await api.get('/reports/commission/jo-detail', { params });
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
        <h1>Commission — JO Detail</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Sales Rep.</label>
            <EntityPicker
              label="Sales Rep" items={reps} value={salesRep?.id || ''} getLabel={(r) => r.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setSalesRep}
            />
          </div>
          <div className="field">
            <label>Sales Division</label>
            <EntityPicker
              label="Sales Division" items={divisions} value={division?.id || ''} getLabel={(d) => d.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDivision}
            />
          </div>
          <div className="field">
            <label>Month</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}
      {loading && <LoadingSpinner />}

      {!loading && report && (
        <>
          <div className="estimate-footer card" style={{ marginBottom: 16 }}>
            <div><span className="muted">Passing-GP JOs</span><div className="hi-lg">{report.totals.passing.count}</div></div>
            <div><span className="muted">Passing — Net of Tax</span><div className="hi-lg">{money(report.totals.passing.net_of_tax)}</div></div>
            <div><span className="muted">Passing — Paid Invoice</span><div className="hi-lg" style={{ color: '#15803d' }}>{money(report.totals.passing.paid_invoice)}</div></div>
            <div><span className="muted">Below-GP JOs</span><div className="hi-lg">{report.totals.below.count}</div></div>
            <div><span className="muted">Below — Net of Tax</span><div className="hi-lg">{money(report.totals.below.net_of_tax)}</div></div>
            <div><span className="muted">Below — Paid Invoice</span><div className="hi-lg" style={{ color: '#b91c1c' }}>{money(report.totals.below.paid_invoice)}</div></div>
          </div>

          <div className="card">
            <div style={{ marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <strong>{report.employee_name}</strong>
              <span>{MONTHS[report.month - 1]} {report.year}</span>
              <span>Team: {report.team_size}{report.sbu_division_count ? ` + ${report.sbu_division_count} division(s)` : ''}</span>
              <span>{report.rows.length} JO(s)</span>
            </div>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>JO #</th>
                    <th>SO #</th>
                    <th>DT #</th>
                    <th>Invoice #</th>
                    <th>Customer</th>
                    <th>Sales Rep</th>
                    <th>Job Type</th>
                    <th style={{ textAlign: 'right' }}>GP Rate</th>
                    <th style={{ textAlign: 'right' }}>Passing GP</th>
                    <th style={{ textAlign: 'right' }}>Net of Tax</th>
                    <th style={{ textAlign: 'right' }}>Paid Invoice</th>
                    <th>GP Status</th>
                    {canApprove && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.length === 0 && (
                    <tr><td colSpan={canApprove ? 13 : 12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No job orders for this rep in this month.</td></tr>
                  )}
                  {report.rows.map((r, i) => (
                    <tr key={i}>
                      <td data-label="JO #">{r.job_order_no}</td>
                      <td data-label="SO #">{r.sales_order_no}</td>
                      <td data-label="DT #">{r.dt_no || '—'}</td>
                      <td data-label="Invoice #">{r.invoice_no || '—'}</td>
                      <td data-label="Customer">{r.customer_name}</td>
                      <td data-label="Sales Rep">{r.rep_name}</td>
                      <td data-label="Job Type">{r.job_type}</td>
                      <td data-label="GP Rate" style={{ textAlign: 'right' }}>{r.gp_rate == null ? '—' : `${pct(r.gp_rate)}%`}</td>
                      <td data-label="Passing GP" style={{ textAlign: 'right' }}>{r.passing_gp_rate == null ? '—' : `${pct(r.passing_gp_rate)}%`}</td>
                      <td data-label="Net of Tax" style={{ textAlign: 'right' }}>{money(r.net_of_tax)}</td>
                      <td data-label="Paid Invoice" style={{ textAlign: 'right' }}>{money(r.paid_invoice)}</td>
                      <td data-label="GP Status">
                        <span style={{ color: r.is_passing ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
                          {r.is_passing ? 'Passing' : 'Below GP'}
                        </span>
                        {/* A JO that only passes because it was added is marked, so nobody reads
                            the green "Passing" as if it had earned the GP rate on its own. */}
                        {r.is_approved_low_gp && !r.meets_gp && (
                          <div className="muted" style={{ fontSize: '0.85em' }}>added to commission</div>
                        )}
                      </td>
                      {canApprove && (
                        <td>
                          {/* Only a below-GP JO needs adding; one that already meets the rate
                              counts anyway, so there is nothing to offer. */}
                          {!r.meets_gp && r.sales_order_line_id && (
                            r.is_approved_low_gp ? (
                              <button
                                className="btn btn-sm"
                                disabled={savingLine === r.sales_order_line_id}
                                onClick={() => toggleCommission(r, false)}
                              >
                                {savingLine === r.sales_order_line_id ? 'Saving...' : 'Remove'}
                              </button>
                            ) : (
                              <button
                                className="btn btn-sm btn-primary"
                                disabled={savingLine === r.sales_order_line_id}
                                onClick={() => toggleCommission(r, true)}
                              >
                                {savingLine === r.sales_order_line_id ? 'Saving...' : 'Add to Commission'}
                              </button>
                            )
                          )}
                        </td>
                      )}
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
