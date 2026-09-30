import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Pagination from '../../components/Pagination';
import { displayDate } from '../../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const d = (v) => (v ? displayDate(String(v).slice(0, 10)) : '');
const thisMonth = () => new Date().toISOString().slice(0, 7);
const PAGE_SIZE = 25;
const EMPTY = {
  search: '', office_location_id: '', job_location_id: '', department_id: '', sales_rep_id: '', customer: '',
  status: '', mode: 'month', month: thisMonth(), as_of: new Date().toISOString().slice(0, 10), from: '', to: '',
};

// Production > Forecast Report, as the source's: every Job Order by the forecast date production
// set on it (its planned end), in all statuses or one, with its build / delivery / invoice
// progress. Pulled month by month by default; Download gives the same rows as a workbook.
export default function ForecastReport() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/reports/forecast/meta').then(({ data: m }) => setMeta(m)).catch(() => setMeta({ locations: [], departments: [], reps: [], statuses: [] })); }, []);

  const params = useCallback((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null)), []);

  useEffect(() => {
    setLoading(true); setError('');
    api.get('/reports/forecast', { params: { ...params(applied), page, limit: PAGE_SIZE } })
      .then(({ data: r }) => setData(r))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the report.'))
      .finally(() => setLoading(false));
  }, [applied, page, params]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  function search() { setPage(1); setApplied(filters); }
  function clear() { setFilters(EMPTY); setPage(1); setApplied(EMPTY); }

  async function download() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/forecast/export', { params: params(applied), responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      const label = applied.mode === 'range' ? `${applied.from}_${applied.to}` : applied.mode === 'as_of' ? `as-of-${applied.as_of}` : applied.month;
      a.href = url; a.download = `forecast-report-${label}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Download failed.'); } finally { setDownloading(false); }
  }

  const select = (k, items, label, text) => (
    <select value={filters[k]} onChange={set(k)}>
      <option value="">{label}</option>
      {(items || []).map((i) => <option key={i.id} value={i.id}>{text(i)}</option>)}
    </select>
  );
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <div className="page-header">
        <h1>Forecast Report</h1>
        <button className="btn btn-primary" disabled={downloading || !data || !data.total} onClick={download}>{downloading ? 'Preparing…' : 'Download'}</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>General Searching</label>
            <input value={filters.search} onChange={set('search')} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="JO #, SO #, customer, description…" /></div>
          <div className="field"><label>Office Location</label>{select('office_location_id', meta?.locations, 'Office Location', (l) => l.location_name)}</div>
          <div className="field"><label>Job Location</label>{select('job_location_id', meta?.locations, 'Job Location', (l) => l.location_name)}</div>
          <div className="field"><label>Department</label>{select('department_id', meta?.departments, 'Department', (x) => x.name)}</div>
          <div className="field"><label>Sales Rep</label>{select('sales_rep_id', meta?.reps, 'Sales Rep', (x) => x.name)}</div>
          <div className="field"><label>Customer</label>
            <input value={filters.customer} onChange={set('customer')} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Customer" /></div>
          <div className="field"><label>JO Status</label>
            <select value={filters.status} onChange={set('status')}>
              <option value="">All statuses</option>
              {(meta?.statuses || []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div className="field"><label>Date Forecast</label>
            <select value={filters.mode} onChange={set('mode')}>
              <option value="month">Month</option>
              <option value="as_of">As of</option>
              <option value="range">Date range</option>
            </select></div>
          {filters.mode === 'month' && <div className="field"><label>Month</label><input type="month" value={filters.month} onChange={set('month')} /></div>}
          {filters.mode === 'as_of' && <div className="field"><label>As of</label><input type="date" value={filters.as_of} onChange={set('as_of')} /></div>}
          {filters.mode === 'range' && (
            <>
              <div className="field"><label>From</label><input type="date" value={filters.from} onChange={set('from')} /></div>
              <div className="field"><label>To</label><input type="date" value={filters.to} onChange={set('to')} /></div>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={search}>Search</button>
          <button className="btn" onClick={clear}>Clear</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {data && (
          <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
            <span><strong>{data.total.toLocaleString()}</strong> job order(s)</span>
            <span>JO Qty <strong>{Number(data.total_qty).toLocaleString()}</strong></span>
            <span>JO Amt <strong>{money(data.total_amount)}</strong></span>
          </div>
        )}
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Customer</th><th>Office Location</th><th>JO #</th><th>Job Type</th><th>Job Description</th><th>JO Location</th>
                  <th>Department</th><th>Sales Rep</th><th>JO Status</th><th style={{ textAlign: 'right' }}>JO Qty</th><th style={{ textAlign: 'right' }}>JO Amt</th>
                  <th>Delivery Date</th><th>Forecast Date</th><th>AB Date</th><th>ID Date</th><th>Invoice Date</th>
                  <th style={{ textAlign: 'right' }}>Invoice Qty</th><th style={{ textAlign: 'right' }}>Invoice Amt</th><th style={{ textAlign: 'right' }}>Unbilled Qty</th><th>Prod Rating</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data && data.rows.length === 0 && <tr><td colSpan={21} className="muted" style={{ textAlign: 'center', padding: 20 }}>No job orders forecast in this period.</td></tr>}
                {data && data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Customer">{r.customer_name}</td>
                    <td data-label="Office Location">{r.office_location}</td>
                    <td data-label="JO #">{r.job_order_no}</td>
                    <td data-label="Job Type">{r.job_type}</td>
                    <td data-label="Job Description">{r.description}</td>
                    <td data-label="JO Location">{r.job_location}</td>
                    <td data-label="Department">{r.department}</td>
                    <td data-label="Sales Rep">{r.sales_rep}</td>
                    <td data-label="JO Status">{r.jo_status}</td>
                    <td data-label="JO Qty" style={{ textAlign: 'right' }}>{r.quantity.toLocaleString()}</td>
                    <td data-label="JO Amt" style={{ textAlign: 'right' }}>{money(r.jo_amount)}</td>
                    <td data-label="Delivery Date">{d(r.delivery_date)}</td>
                    <td data-label="Forecast Date">{d(r.forecast_date)}</td>
                    <td data-label="AB Date">{d(r.ab_date)}</td>
                    <td data-label="ID Date">{d(r.id_date)}</td>
                    <td data-label="Invoice Date">{d(r.invoice_date)}</td>
                    <td data-label="Invoice Qty" style={{ textAlign: 'right' }}>{r.invoice_qty.toLocaleString()}</td>
                    <td data-label="Invoice Amt" style={{ textAlign: 'right' }}>{money(r.invoice_amount)}</td>
                    <td data-label="Unbilled Qty" style={{ textAlign: 'right' }}>{r.unbilled_qty.toLocaleString()}</td>
                    <td data-label="Prod Rating" title={r.gp_rate != null ? `GP ${r.gp_rate}% vs passing ${r.passing_gp_rate ?? '—'}%` : ''}
                      style={{ color: r.prod_rating === 'BELOW GP RATE' ? '#b91c1c' : r.prod_rating ? '#15803d' : undefined, fontWeight: 600 }}>
                      {r.prod_rating || '—'}{r.gp_rate != null && <div className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{r.gp_rate}% / {r.passing_gp_rate ?? '—'}%</div>}
                    </td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/production/${r.id}`)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
