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
// The app's date format on screen; the download keeps the sales workbook's own 09/25/2026.
const mdy = (v) => (v ? displayDate(String(v).slice(0, 10)) : '');
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
            <span>Net of Tax <strong>{money(data.total_amount)}</strong></span>
            <span>Weekly Target <strong>{money(data.total_weekly_target)}</strong></span>
            <span>Pending <strong>{money(data.total_pending)}</strong></span>
          </div>
        )}
        {loading ? <LoadingSpinner /> : data && (
          <div className="table-wrap">
            {/* The sales team's workbook layout (SALES 1.xlsx): Net of Tax under the Friday week its
                forecast falls in; this week's column is shaded and feeds WEEKLY TARGET. */}
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Date</th><th>Customer</th><th>JO #</th><th>JO Status</th><th>Sales Rep</th><th>Job Type</th><th>Description</th>
                  <th style={{ textAlign: 'right' }}>Unit Price</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Net of Tax</th>
                  {data.weeks.map((w, i) => (
                    <th key={w} style={{ textAlign: 'right', background: i === data.current_week ? 'var(--color-warning-soft, #fff2cc)' : undefined }}>{mdy(w)}</th>
                  ))}
                  <th>Delivery Date</th><th>Forecast Date</th><th>STATUS</th>
                  <th style={{ textAlign: 'right' }}>WEEKLY TARGET</th><th style={{ textAlign: 'right' }}>PENDING</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={16 + data.weeks.length} className="muted" style={{ textAlign: 'center', padding: 20 }}>No job orders forecast in this period.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Date">{mdy(r.order_date)}</td>
                    <td data-label="Customer">{r.customer_name}</td>
                    <td data-label="JO #">{r.job_order_no}</td>
                    <td data-label="JO Status">{r.jo_status}</td>
                    <td data-label="Sales Rep">{r.sales_rep}</td>
                    <td data-label="Job Type">{r.job_type}</td>
                    <td data-label="Description">{r.description}</td>
                    <td data-label="Unit Price" style={{ textAlign: 'right' }}>{money(r.unit_price)}</td>
                    <td data-label="Qty" style={{ textAlign: 'right' }}>{r.quantity.toLocaleString()}</td>
                    <td data-label="Net of Tax" style={{ textAlign: 'right' }}>{money(r.jo_amount)}</td>
                    {r.weeks.map((v, i) => (
                      <td key={i} data-label={mdy(data.weeks[i])} style={{ textAlign: 'right', background: i === data.current_week ? 'var(--color-warning-soft, #fff2cc)' : undefined }}>{v ? money(v) : ''}</td>
                    ))}
                    <td data-label="Delivery Date">{mdy(r.line_delivery_date)}</td>
                    <td data-label="Forecast Date">{mdy(r.forecast_date)}</td>
                    <td data-label="STATUS" style={{ fontWeight: 600 }}>{r.build_status}</td>
                    <td data-label="Weekly Target" style={{ textAlign: 'right' }}>{r.weekly_target ? money(r.weekly_target) : ''}</td>
                    <td data-label="Pending" style={{ textAlign: 'right' }}>{r.pending ? money(r.pending) : ''}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/production/${r.id}`)}>View</button></td>
                  </tr>
                ))}
              </tbody>
              {data.rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={9}>TOTAL (all {data.total.toLocaleString()} rows)</td>
                    <td style={{ textAlign: 'right' }}>{money(data.total_amount)}</td>
                    {data.week_totals.map((v, i) => <td key={i} style={{ textAlign: 'right' }}>{money(v)}</td>)}
                    <td colSpan={3} />
                    <td style={{ textAlign: 'right' }}>{money(data.total_weekly_target)}</td>
                    <td style={{ textAlign: 'right' }}>{money(data.total_pending)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
