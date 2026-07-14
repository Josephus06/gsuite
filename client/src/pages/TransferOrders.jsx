import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

const STATUS_TABS = [
  { key: 'pending_fulfillment', label: 'Pending Fulfillment' },
  { key: 'partially_fulfilled', label: 'Partially Fulfilled' },
  { key: 'pending_receipt', label: 'Pending Receipt' },
  { key: 'pending_receipt_partially_fulfilled', label: 'Pending Receipt / Partially Fulfilled' },
  { key: 'received', label: 'Received' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_LABELS = Object.fromEntries(STATUS_TABS.map((t) => [t.key, t.label]));

function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

// Mirrors the real system's "Transfer Order" list -- how stock gets withdrawn from one
// warehouse (almost always Warehouse - Central) into whichever warehouse a Job Order's
// materials are actually short at. Most rows here are raised via the "Create TO" button
// on a Job Order's Production view rather than "Add New" here directly.
export default function TransferOrders() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('pending_fulfillment');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = { status };
    if (search) params.search = search;
    const [{ data }, { data: countData }] = await Promise.all([
      api.get('/transfer-orders', { params }),
      api.get('/transfer-orders/status-counts'),
    ]);
    setRows(data);
    setCounts(countData);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]);

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Transfer Orders</h1>
        {can('/transfer-orders', 'can_add') && <button className="btn btn-primary" onClick={() => navigate('/transfer-orders/new')}>Add New</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="TO No. or Job Order No..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button key={t.key} className={`status-tab ${status === t.key ? 'active' : ''}`} onClick={() => setStatus(t.key)}>
            {t.label}{counts[t.key] ? <span className="badge badge-success" style={{ marginLeft: 6 }}>{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>TO No.</th>
                  <th>Date Created</th>
                  <th>Date Needed</th>
                  <th>Withdraw From</th>
                  <th>Transfer To</th>
                  <th>Job Order</th>
                  <th>Requestor</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transfer orders found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="TO No.">{row.to_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Date Needed">{formatDate(row.date_needed)}</td>
                    <td data-label="Withdraw From">{row.withdraw_from_name}</td>
                    <td data-label="Transfer To">{row.transfer_to_name}</td>
                    <td data-label="Job Order">{row.job_order_no || '—'}</td>
                    <td data-label="Requestor">{row.requestor_name || '—'}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/transfer-orders/${row.id}`}>View</Link></td>
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
