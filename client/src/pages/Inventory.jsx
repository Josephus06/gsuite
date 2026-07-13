import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Mirrors the real system's Inventory list -- status tabs (Approved / For Approval
// Costing / For Approval Accounting / Inactive) + search, matching the Estimates/Sales
// Orders list pattern used elsewhere in this app.
const STATUS_TABS = [
  { key: 'approved', label: 'Approved' },
  { key: 'for_approval_costing', label: 'For Approval Costing' },
  { key: 'for_approval_accounting', label: 'For Approval Accounting' },
  { key: 'inactive', label: 'Inactive' },
];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function Inventory() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('approved');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = { status, with_counts: 1 };
    if (search) params.search = search;
    const { data } = await api.get('/inventory', { params });
    setRows(data.rows);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]);

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function handleDelete(row) {
    if (!confirm(`Delete item "${row.display_name}"?`)) return;
    try {
      await api.delete(`/inventory/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Inventory Items</h1>
        {can('/inventory', 'can_add') && <button className="btn btn-primary" onClick={() => navigate('/inventory/new')}>Add New</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Item code, name, description..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${status === t.key ? 'active' : ''}`}
            onClick={() => setStatus(t.key)}
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
                  <th>Item Code</th>
                  <th>Display Name</th>
                  <th>Unit Title</th>
                  <th>Last Purchase Price</th>
                  <th>Average Cost</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.item_code}</td>
                    <td>{row.display_name}</td>
                    <td>{row.base_unit_title}</td>
                    <td>{money(row.last_purchase_price)}</td>
                    <td>{money(row.average_cost)}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => navigate(`/inventory/${row.id}`)}>View</button>
                      {can('/inventory', 'can_edit') && <button className="btn btn-sm" onClick={() => navigate(`/inventory/${row.id}/edit`)}>Update</button>}
                      {can('/inventory', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
                    </td>
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
