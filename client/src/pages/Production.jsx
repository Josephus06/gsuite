import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Mirrors the real system's "Production > Production" ("Saved Job Order Stages")
// screen: a separate production-floor tracking pipeline a JO enters once Released
// (Sales-approved) from the Job Orders module. Rows open the Production-specific detail
// view (ProductionJobOrderView.jsx), which shows the same JO with a wider,
// production-floor Processes table instead of the Sales-side Job Order view.
const STAGE_TABS = [
  { key: 'pending_for_scheduling', label: 'Pending for Sched.' },
  { key: 'for_revision', label: 'For Revision' },
  { key: 'in_process_with_revision', label: 'In-Process w/ Rev.' },
  { key: 'in_process', label: 'In-Process' },
  { key: 'for_qi', label: 'For QI' },
  { key: 'partially_completed', label: 'Part. Completed' },
  { key: 'completed', label: 'Completed' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'hold', label: 'Hold' },
];

function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function Production() {
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const [stage, setStage] = useState('pending_for_scheduling');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = stage === 'hold' ? { hold: 1 } : { stage };
    if (search) params.search = search;
    const { data } = await api.get('/production', { params });
    setRows(data.rows);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [stage]);

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Saved Job Order Stages</h1>
        <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." />
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
        </div>
      )}

      <div className="status-tabs">
        {STAGE_TABS.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${stage === t.key ? 'active' : ''}`}
            onClick={() => setStage(t.key)}
          >
            {t.label} <span className="badge badge-muted">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>JO / NSTD JO #</th>
                  <th>SO #</th>
                  <th>Date Created</th>
                  <th>Date Forwarded</th>
                  <th>Job Location</th>
                  <th>Job Type</th>
                  <th>Job Desc</th>
                  <th>Sales Rep</th>
                  <th>Customer</th>
                  <th>Artist</th>
                  <th>Qty</th>
                  <th>Qty Completed</th>
                  <th>Delivery Date</th>
                  <th>Delivery Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Job Orders in this stage.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id} onClick={() => navigate(`/production/${row.id}`)} style={{ cursor: 'pointer' }}>
                    <td><button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); navigate(`/production/${row.id}`); }}>{row.job_order_no}</button></td>
                    <td>{row.sales_order_no}</td>
                    <td>{formatDate(row.created_at)}</td>
                    <td>{formatDate(row.date_forwarded)}</td>
                    <td>{row.job_location_name}</td>
                    <td>{row.job_type_name}</td>
                    <td>{row.description}</td>
                    <td>{row.sales_rep_name}</td>
                    <td>{row.customer_name}</td>
                    <td>{row.artist_name}</td>
                    <td>{row.quantity} {row.units}</td>
                    <td>{row.quantity_built} {row.units}</td>
                    <td>{formatDate(row.delivery_date)}</td>
                    <td>{row.delivery_time}</td>
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
