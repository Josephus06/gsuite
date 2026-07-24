import { useEffect, useState } from 'react';
import api from '../../api/client';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import { money } from './CoaTreeRows';

function currentYear() { return new Date().getFullYear(); }

// Mirrors the real Commission module's Commission report: pick a Sales Rep, an optional
// Sales Division, and a Year, then twelve month rows of quota / weighted sales /
// performance / the several commission figures. Every column is computed server-side
// (see lib/commissionReport.js) from the rep's own commission scheme and their JOs.
export default function CommissionReport() {
  const [salesRep, setSalesRep] = useState(null);
  const [division, setDivision] = useState(null);
  const [year, setYear] = useState(currentYear());
  const [reps, setReps] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [selfOnly, setSelfOnly] = useState(false);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runReport(repId, yr = year) {
    if (!repId) { setError('Select a Sales Rep first.'); return; }
    setLoading(true);
    setError('');
    try {
      const params = { employeeId: repId, year: yr };
      if (division && !selfOnly) params.salesDivisionId = division.id;
      const { data } = await api.get('/reports/commission', { params });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Scope drives the whole page; keep it independent of the divisions lookup, which an
    // Account Officer isn't permitted to call (and doesn't need -- their picker is hidden).
    api.get('/reports/commission/scope').then(({ data }) => {
      setReps(data.reps);
      if (data.self_only && data.self) {
        // Account Officer / plain sales user: no picker -- auto-run their own report.
        setSelfOnly(true);
        setSalesRep(data.self);
        runReport(data.self.id);
      } else {
        // Only users who pick a rep also use the division filter (best-effort).
        api.get('/lookups/sales-divisions').then((r) => setDivisions(r.data)).catch(() => {});
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function generate() { runReport(salesRep?.id); }

  const totals = report ? report.rows.reduce((t, r) => ({
    weighted_sales: t.weighted_sales + r.weighted_sales,
    estimated_commission: t.estimated_commission + r.estimated_commission,
    passing_gp_total: t.passing_gp_total + r.passing_gp_total,
    expected_commission: t.expected_commission + r.expected_commission,
    confirmed_commission: t.confirmed_commission + r.confirmed_commission,
    released_commission: t.released_commission + r.released_commission,
    unpaid_commission: t.unpaid_commission + r.unpaid_commission,
  }), {
    weighted_sales: 0, estimated_commission: 0, passing_gp_total: 0, expected_commission: 0,
    confirmed_commission: 0, released_commission: 0, unpaid_commission: 0,
  }) : null;

  return (
    <div>
      <div className="page-header">
        <h1>Commission</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          {!selfOnly && (
            <div className="field">
              <label>Sales Rep.</label>
              <EntityPicker
                label="Sales Rep" items={reps} value={salesRep?.id || ''} getLabel={(r) => r.name}
                columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setSalesRep}
              />
            </div>
          )}
          {!selfOnly && (
            <div className="field">
              <label>Sales Division</label>
              <EntityPicker
                label="Sales Division" items={divisions} value={division?.id || ''} getLabel={(d) => d.name}
                columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDivision}
              />
            </div>
          )}
          <div className="field">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 120 }} />
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
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <strong>{report.employee_name}</strong>
            <span>Year: {report.year}</span>
            <span>Scheme: {report.scheme_name || <span style={{ color: '#b91c1c' }}>none (no role scheme)</span>}</span>
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Month</th>
                  <th style={{ textAlign: 'right' }}>Quota</th>
                  <th>Sales Division</th>
                  <th style={{ textAlign: 'right' }}>Weighted Sales</th>
                  <th style={{ textAlign: 'right' }}>%</th>
                  <th style={{ textAlign: 'right' }}>Estimated Commission</th>
                  <th style={{ textAlign: 'right' }}>Total Amount of JO&apos;s with Passing Rate</th>
                  <th style={{ textAlign: 'right' }}>Expected Commission</th>
                  <th style={{ textAlign: 'right' }}>Confirmed Commission</th>
                  <th style={{ textAlign: 'right' }}>Released Commission</th>
                  <th style={{ textAlign: 'right' }}>Unpaid Commission</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.month}>
                    <td data-label="Month">{r.month_name}</td>
                    <td data-label="Quota" style={{ textAlign: 'right' }}>{money(r.quota)}</td>
                    <td data-label="Sales Division">{r.division_name || ''}</td>
                    <td data-label="Weighted Sales" style={{ textAlign: 'right' }}>{money(r.weighted_sales)}</td>
                    <td data-label="%" style={{ textAlign: 'right' }}>{money(r.performance_pct)}</td>
                    <td data-label="Estimated Commission" style={{ textAlign: 'right' }}>{money(r.estimated_commission)}</td>
                    <td data-label="Total JO Passing" style={{ textAlign: 'right' }}>{money(r.passing_gp_total)}</td>
                    <td data-label="Expected Commission" style={{ textAlign: 'right' }}>{money(r.expected_commission)}</td>
                    <td data-label="Confirmed Commission" style={{ textAlign: 'right' }}>{money(r.confirmed_commission)}</td>
                    <td data-label="Released Commission" style={{ textAlign: 'right' }}>{money(r.released_commission)}</td>
                    <td data-label="Unpaid Commission" style={{ textAlign: 'right' }}>{money(r.unpaid_commission)}</td>
                  </tr>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td>
                    <td></td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>{money(totals.weighted_sales)}</td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>{money(totals.estimated_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.passing_gp_total)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.expected_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.confirmed_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.released_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.unpaid_commission)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            Released Commission is not yet sourced (shown as 0), so Unpaid = Confirmed for now.
          </p>
        </div>
      )}
    </div>
  );
}
