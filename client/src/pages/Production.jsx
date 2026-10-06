import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';

const PAGE_SIZE = 10;

// Mirrors the real system's "Production > Production" ("Saved Job Order Stages")
// screen: a separate production-floor tracking pipeline a JO enters once Released
// (Sales-approved) from the Job Orders module. Rows open the Production-specific detail
// view (ProductionJobOrderView.jsx), which shows the same JO with a wider,
// production-floor Processes table instead of the Sales-side Job Order view.
const STAGE_TABS = [
  // First, because it is what happens first: Sales forwards an advance copy so the floor can
  // see what is coming and move materials, before the job is approved and schedulable. Not a
  // production_stage value -- an advance copy deliberately has none -- so it is passed as its
  // own query param, exactly as Hold is.
  { key: 'advance_copy', label: 'Advance Copy' },
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

function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export default function Production() {
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(true); // shown by default; Toggle Filter hides them (asked 2026-10-06)

  const [stage, setStage] = useState('pending_for_scheduling');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = stage === 'hold' ? { hold: 1 }
      : stage === 'advance_copy' ? { advance: 1 }
      : { stage };
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
  useAutoSearch(search, runSearch);

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
                  <tr
                    key={row.id}
                    style={{ cursor: 'pointer' }}
                    // Ctrl/Cmd-click or middle-click anywhere on the row opens the JO in a new tab, like a link.
                    onClick={(e) => (e.ctrlKey || e.metaKey ? window.open(`/production/${row.id}`, '_blank') : navigate(`/production/${row.id}`))}
                    onAuxClick={(e) => { if (e.button === 1) window.open(`/production/${row.id}`, '_blank'); }}
                  >
                    {/* A real link, so the JO opens in a new tab (Ctrl/middle-click, right-click); the
                        row itself still opens it on a plain click. */}
                    <td><Link className="link-btn" to={`/production/${row.id}`} onClick={(e) => e.stopPropagation()}>{row.job_order_no}</Link></td>
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
