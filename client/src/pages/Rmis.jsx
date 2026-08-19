import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Mirrors the real system's "Inventory > RMI" screen. A Return Material Inventory sends
// material back from a branch or satellite warehouse to a central one -- job leftovers,
// wrong items pulled, stock being consolidated.
//
// The tabs are in the document's own order rather than alphabetical, because that is the
// order a return actually moves through. "All" leads: unlike Inventory Adjustments, where
// the pending queue is the thing you open the page to work, most RMIs here are historical
// and people arrive looking for a particular one.
const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'pending_receipt', label: 'Pending Receipt' },
  { key: 'partially_received', label: 'Partially Received' },
  { key: 'received', label: 'Received' },
  { key: 'cancelled', label: 'Cancelled' },
];

const LABEL = Object.fromEntries(STATUS_TABS.filter((t) => t.key).map((t) => [t.key, t.label]));

function qty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  // Quantities here are genuinely fractional (4.62 rolls), but a whole number should not be
  // padded out to "83.0000".
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function Rmis() {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    const { data } = await api.get('/rmis', { params });
    setRows(data.rows);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const allCount = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);

  function runSearch() {
    setPage(1);
    load();
  }

  return (
    <div>
      <div className="page-header">
        <h1>Return Material Inventory</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="RMI No., memo or warehouse..."
            />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key || 'all'}
            className={`status-tab ${status === t.key ? 'active' : ''}`}
            onClick={() => setStatus(t.key)}
          >
            {t.label} <span className="badge badge-muted">{t.key ? (counts[t.key] ?? 0) : allCount}</span>
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>RMI No.</th>
                  <th>Date Created</th>
                  <th>Return From</th>
                  <th>Return To</th>
                  <th>Items</th>
                  <th>Qty</th>
                  <th>Received</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No RMIs found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="RMI No.">{row.rmi_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Return From">{row.return_from_name}</td>
                    <td data-label="Return To">{row.return_to_name}</td>
                    <td data-label="Items">{row.line_count}</td>
                    <td data-label="Qty">{qty(row.total_qty)}</td>
                    <td data-label="Received">{qty(row.total_received)}</td>
                    <td data-label="Status">{LABEL[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/rmis/${row.id}`}>View</Link></td>
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
