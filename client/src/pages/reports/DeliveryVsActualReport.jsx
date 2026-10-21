import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';
import Pagination from '../../components/Pagination';
import { displayDate } from '../../utils/dates';
import SearchInput from '../../components/SearchInput';

const mdy = (v) => (v ? displayDate(String(v).slice(0, 10)) : '');
const thisMonth = () => new Date().toISOString().slice(0, 7);
const PAGE_SIZE = 25;
const EMPTY = {
  search: '', office_location_id: '', job_location_id: '', department_id: '', sales_rep_id: '', customer: '',
  result: '', basis: 'completed', mode: 'month', month: thisMonth(), from: '', to: '',
};
const RESULT_BADGE = { LATE: 'badge-danger', EARLY: 'badge-info', 'ON TIME': 'badge-success' };

// Production > Delivery Date Vs Actual (2026-10-21): every INVOICED Job Order, the delivery date
// promised on it against the day it was completed (its last Quality Inspection), and how many days
// early or late. Pulled month by month on the completed date by default.
export default function DeliveryVsActualReport() {
  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/reports/delivery-vs-actual/meta').then(({ data: m }) => setMeta(m))
      .catch(() => setMeta({ locations: [], departments: [], reps: [], results: [] }));
  }, []);

  const params = useCallback((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null)), []);

  useEffect(() => {
    setLoading(true); setError('');
    api.get('/reports/delivery-vs-actual', { params: { ...params(applied), page, limit: PAGE_SIZE } })
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
      const res = await api.get('/reports/delivery-vs-actual/export', { params: params(applied), responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      const label = applied.mode === 'range' ? `${applied.from}_${applied.to}` : applied.month;
      a.href = url; a.download = `delivery-vs-actual-${label}.xlsx`;
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
  const s = data?.summary;
  const days = (n) => (n > 0 ? `+${n}` : String(n));

  return (
    <div>
      <div className="page-header">
        <h1>Delivery Date Vs Actual</h1>
        <button className="btn btn-primary" disabled={downloading || !data || !data.total} onClick={download}>{downloading ? 'Preparing…' : 'Download'}</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>General Searching</label>
            <SearchInput value={filters.search} onChange={set('search')} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="JO #, SO #, customer, description…" /></div>
          <div className="field"><label>Office Location</label>{select('office_location_id', meta?.locations, 'Office Location', (l) => l.location_name)}</div>
          <div className="field"><label>Job Location</label>{select('job_location_id', meta?.locations, 'Job Location', (l) => l.location_name)}</div>
          <div className="field"><label>Department</label>{select('department_id', meta?.departments, 'Department', (x) => x.name)}</div>
          <div className="field"><label>Sales Rep</label>{select('sales_rep_id', meta?.reps, 'Sales Rep', (x) => x.name)}</div>
          <div className="field"><label>Customer</label>
            <input value={filters.customer} onChange={set('customer')} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Customer" /></div>
          <div className="field"><label>Result</label>
            <select value={filters.result} onChange={set('result')}>
              <option value="">All</option>
              {(meta?.results || []).map((r) => <option key={r} value={r}>{r}</option>)}
            </select></div>
          <div className="field"><label>Date Basis</label>
            <select value={filters.basis} onChange={set('basis')}>
              <option value="completed">Date Completed</option>
              <option value="delivery">Delivery Date</option>
            </select></div>
          <div className="field"><label>Period</label>
            <select value={filters.mode} onChange={set('mode')}>
              <option value="month">Month</option>
              <option value="range">Date range</option>
            </select></div>
          {filters.mode === 'month' && <div className="field"><label>Month</label><input type="month" value={filters.month} onChange={set('month')} /></div>}
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
        {s && (
          <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
            <span><strong>{s.total.toLocaleString()}</strong> invoiced job order(s)</span>
            <span>Early <strong>{s.early.toLocaleString()}</strong></span>
            <span>On Time <strong>{s.on_time.toLocaleString()}</strong></span>
            <span style={{ color: 'var(--danger, #b91c1c)' }}>Late <strong>{s.late.toLocaleString()}</strong></span>
            <span>On time or early <strong>{s.on_time_rate}%</strong></span>
            <span>Avg days late <strong>{s.avg_days_late}</strong></span>
          </div>
        )}
        {loading ? <LoadingSpinner /> : data && (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>JO #</th><th>SO #</th><th>Customer</th><th>Description</th><th>Job Type</th>
                  <th style={{ textAlign: 'right' }}>Qty</th><th>Sales Rep</th><th>Job Location</th><th>Invoice #</th>
                  <th>Delivery Date</th><th>Date Completed</th><th style={{ textAlign: 'right' }}>Days</th><th>Result</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 20 }}>No invoiced job orders in this period.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="JO #">{r.job_order_no}</td>
                    <td data-label="SO #">{r.order_no}</td>
                    <td data-label="Customer"><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                    <td data-label="Description">{r.description}</td>
                    <td data-label="Job Type">{r.job_type}</td>
                    <td data-label="Qty" style={{ textAlign: 'right' }}>{r.quantity.toLocaleString()}</td>
                    <td data-label="Sales Rep">{r.sales_rep}</td>
                    <td data-label="Job Location">{r.job_location}</td>
                    <td data-label="Invoice #">{r.invoice_nos}</td>
                    <td data-label="Delivery Date">{mdy(r.delivery_date)}</td>
                    <td data-label="Date Completed">{mdy(r.completed_date)}</td>
                    <td data-label="Days" style={{ textAlign: 'right', fontWeight: 600, color: r.variance_days > 0 ? 'var(--danger, #b91c1c)' : undefined }}>{days(r.variance_days)}</td>
                    <td data-label="Result"><span className={`badge ${RESULT_BADGE[r.result] || 'badge-muted'}`}>{r.result}</span></td>
                    <td><Link className="btn btn-sm btn-primary" to={`/production/${r.id}`}>View</Link></td>
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
