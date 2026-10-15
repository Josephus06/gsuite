import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayDate } from '../../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`);
const day = (v) => (v ? displayDate(String(v).slice(0, 10)) : '');
const EMPTY = { year: String(new Date().getFullYear()), top: '20', office_location_id: '', sales_division_id: '', sales_rep_id: '' };

// Sales > Top Customers per Year: the customers who ordered the most in a year, by the Net of Tax
// of their (non-cancelled) Sales Orders, with last year's figure beside it. Whose orders count is
// the server's rule, the same as Weighted Sales.
export default function TopCustomersReport() {
  const [meta, setMeta] = useState(null);
  // Opens on Head Office, like the other location filters; Clear goes back to it.
  const [initial, setInitial] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/reports/top-customers/meta')
      .then(({ data: m }) => {
        setMeta(m);
        const start = { ...EMPTY, office_location_id: m.default_office_location_id ? String(m.default_office_location_id) : '' };
        setInitial(start); setFilters(start); setApplied(start);
      })
      .catch(() => { setMeta({ reps: [], divisions: [], offices: [], years: [], top_choices: [10, 20, 50, 100] }); setApplied(EMPTY); });
  }, []);

  const params = useCallback((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null)), []);

  useEffect(() => {
    if (!applied) return;
    setLoading(true); setError('');
    api.get('/reports/top-customers', { params: params(applied) })
      .then(({ data: r }) => setData(r))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the report.'))
      .finally(() => setLoading(false));
  }, [applied, params]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const search = () => setApplied(filters);
  const clear = () => { setFilters(initial); setApplied(initial); };

  async function extract() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/top-customers/export', { params: params(applied), responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `top-${data.top}-customers-${data.year}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Extract failed.'); } finally { setDownloading(false); }
  }

  const years = meta?.years?.length ? meta.years : [Number(EMPTY.year)];
  const right = { textAlign: 'right' };

  return (
    <div>
      <div className="page-header">
        <h1>Top Customers per Year</h1>
        <button className="btn btn-primary" disabled={downloading || !data || !data.rows.length} onClick={extract}>{downloading ? 'Preparing…' : 'Extract'}</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>Year</label>
            <select value={filters.year} onChange={set('year')}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select></div>
          <div className="field"><label>Show</label>
            <select value={filters.top} onChange={set('top')}>
              {(meta?.top_choices || [10, 20, 50, 100]).map((n) => <option key={n} value={n}>Top {n}</option>)}
            </select></div>
          <div className="field"><label>Office Location</label>
            <select value={filters.office_location_id} onChange={set('office_location_id')}>
              <option value="">All office locations</option>
              {(meta?.offices || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select></div>
          <div className="field"><label>Sales Group</label>
            <select value={filters.sales_division_id} onChange={set('sales_division_id')}>
              <option value="">All sales groups</option>
              {(meta?.divisions || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
          <div className="field"><label>Sales Rep</label>
            <select value={filters.sales_rep_id} onChange={set('sales_rep_id')}>
              <option value="">{meta?.scope_label || 'All'}</option>
              {(meta?.reps || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={search}>Search</button>
          <button className="btn" onClick={clear}>Clear</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading ? <LoadingSpinner /> : data && (
          <>
            <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
              <span>Top {data.top} ordered <strong>{money(data.top_total)}</strong> ({pct(data.top_share_pct)} of the year)</span>
              <span>All customers {data.year}: <strong>{money(data.year_total)}</strong> from {data.year_customers.toLocaleString()} customer(s), {data.year_orders.toLocaleString()} sales order(s)</span>
            </div>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead><tr>
                  <th style={right}>#</th><th>Customer</th><th style={right}>Sales Orders</th>
                  <th style={right}>Amount Ordered (Net of Tax)</th><th style={right}>Gross (VAT incl.)</th>
                  <th style={right}>% of Year</th><th style={right}>{data.prev_label}</th><th style={right}>Change</th>
                  <th>First Order</th><th>Last Order</th>
                </tr></thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No sales orders in {data.year}.</td></tr>}
                  {data.rows.map((r) => (
                    <tr key={r.customer_id}>
                      <td data-label="#" style={right}>{r.rank}</td>
                      <td data-label="Customer"><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td data-label="Sales Orders" style={right}>{r.orders.toLocaleString()}</td>
                      <td data-label="Amount Ordered" style={{ ...right, fontWeight: 600 }}>{money(r.net_of_tax)}</td>
                      <td data-label="Gross" style={right}>{money(r.gross_amount)}</td>
                      <td data-label="% of Year" style={right}>{pct(r.share_pct)}</td>
                      <td data-label={data.prev_label} style={right}>{r.prev_year_net ? money(r.prev_year_net) : '—'}</td>
                      <td data-label="Change" style={{ ...right, color: r.change_pct == null ? undefined : r.change_pct >= 0 ? '#16a34a' : '#dc2626' }}>
                        {r.change_pct == null ? 'new' : `${r.change_pct >= 0 ? '+' : ''}${pct(r.change_pct)}`}
                      </td>
                      <td data-label="First Order">{day(r.first_order)}</td>
                      <td data-label="Last Order">{day(r.last_order)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
