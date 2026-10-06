import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';
import Pagination from '../../components/Pagination';
import { displayDate } from '../../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const thisMonth = () => new Date().toISOString().slice(0, 7);
const PAGE_SIZE = 25;
const EMPTY = { month: thisMonth(), office_location_id: '', sales_division_id: '', sales_rep_id: '', search: '' };

// Sales > Weighted Sales per Month: every Sales Order line created in the month, its Net of Tax
// being its weighted sales, totalled per rep. Whose orders appear is decided by the server --
// an account officer their own, a supervisor their team, an SBU head their group.
export default function WeightedSalesReport() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  // The page opens on Head Office (asked 2026-10-03), so nothing loads until /meta says which
  // location that is; Clear goes back to it too.
  const [initial, setInitial] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(null);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/reports/weighted-sales/meta')
      .then(({ data: m }) => {
        setMeta(m);
        const start = { ...EMPTY, office_location_id: m.default_office_location_id ? String(m.default_office_location_id) : '' };
        setInitial(start); setFilters(start); setApplied(start);
      })
      .catch(() => { setMeta({ reps: [], divisions: [], offices: [] }); setApplied(EMPTY); });
  }, []);

  const params = useCallback((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null)), []);

  useEffect(() => {
    if (!applied) return;
    setLoading(true); setError('');
    api.get('/reports/weighted-sales', { params: { ...params(applied), page, limit: PAGE_SIZE } })
      .then(({ data: r }) => setData(r))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the report.'))
      .finally(() => setLoading(false));
  }, [applied, page, params]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  function search() { setPage(1); setApplied(filters); }
  function clear() { setFilters(initial); setPage(1); setApplied(initial); }

  async function extract() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/weighted-sales/export', { params: params(applied), responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      const group = (meta?.divisions || []).find((d) => String(d.id) === String(applied.sales_division_id));
      a.href = url; a.download = `weighted-sales-${applied.month}${group ? `-${group.name.replace(/[^w-]+/g, '')}` : ''}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Extract failed.'); } finally { setDownloading(false); }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <div className="page-header">
        <h1>Weighted Sales per Month</h1>
        <button className="btn btn-primary" disabled={downloading || !data || !data.total} onClick={extract}>{downloading ? 'Preparing…' : 'Extract'}</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>Month</label><input type="month" value={filters.month} onChange={set('month')} /></div>
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
          <div className="field"><label>General Searching</label>
            <input value={filters.search} onChange={set('search')} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="SO #, JO #, customer, description…" /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={search}>Search</button>
          <button className="btn" onClick={clear}>Clear</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {data && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
            <span><strong>{data.total_orders.toLocaleString()}</strong> sales order(s)</span>
            <span><strong>{data.total.toLocaleString()}</strong> line(s)</span>
            <span>Weighted Sales <strong>{money(data.total_weighted_sales)}</strong></span>
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Sales Rep</th><th style={{ textAlign: 'right' }}>Sales Orders</th><th style={{ textAlign: 'right' }}>Lines</th><th style={{ textAlign: 'right' }}>Weighted Sales</th></tr></thead>
              <tbody>
                {data.reps.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 16 }}>No sales orders created in this month.</td></tr>}
                {data.reps.map((r) => (
                  <tr key={r.sales_rep_id ?? 'none'}>
                    <td data-label="Sales Rep">{r.sales_rep || '(no sales rep)'}</td>
                    <td data-label="Sales Orders" style={{ textAlign: 'right' }}>{r.orders}</td>
                    <td data-label="Lines" style={{ textAlign: 'right' }}>{r.lines}</td>
                    <td data-label="Weighted Sales" style={{ textAlign: 'right' }}>{money(r.weighted_sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : data && (
          <>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead><tr>
                  <th>SO Date</th><th>SO #</th><th>Customer</th><th>Sales Rep</th><th>Division</th><th>JO #</th>
                  <th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Weighted Sales</th><th style={{ textAlign: 'right' }}>GP %</th><th>Passing</th>
                </tr></thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No sales order lines.</td></tr>}
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td data-label="SO Date">{displayDate(String(r.date_created).slice(0, 10))}</td>
                      <td data-label="SO #"><Link className="link-btn" to={`/sales-orders/${r.sales_order_id}`}>{r.sales_order_no}</Link></td>
                      <td data-label="Customer"><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td data-label="Sales Rep">{r.sales_rep}</td>
                      <td data-label="Division">{r.division_name}</td>
                      <td data-label="JO #">{r.job_order_no || '—'}</td>
                      <td data-label="Job Type">{r.job_type}</td>
                      <td data-label="Description">{r.description}</td>
                      <td data-label="Qty" style={{ textAlign: 'right' }}>{Number(r.quantity || 0).toLocaleString()} {r.units || ''}</td>
                      <td data-label="Weighted Sales" style={{ textAlign: 'right' }}>{money(r.net_of_tax)}</td>
                      <td data-label="GP %" style={{ textAlign: 'right' }}>{r.gp_rate == null ? '' : `${Number(r.gp_rate).toFixed(2)}%`}</td>
                      <td data-label="Passing" style={{ color: r.passing ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{r.passing ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
