import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's Estimates list: status tabs with counts (instead of a
// plain flat table), a collapsible filter panel, and a "View" action per row that
// opens a read-only detail page rather than jumping straight into edit.
const STATUS_TABS = [
  { key: 'pending_supervisor_approval', label: 'Pending Supervisor Approval' },
  { key: 'pending_customer_approval', label: 'Pending Customer Approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'disapproved', label: 'Disapproved' },
];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function Estimates() {
  const { can, user } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [status, setStatus] = useState('pending_supervisor_approval');
  const [search, setSearch] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [officeLocationId, setOfficeLocationId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);

  async function load() {
    setLoading(true);
    const params = { status, page, limit };
    if (search) params.search = search;
    if (salesRepId) params.sales_rep_id = salesRepId;
    if (officeLocationId) params.office_location_id = officeLocationId;
    if (asOf) params.as_of = asOf;
    const { data } = await api.get('/estimates', { params });
    setRows(data.rows);
    setTotal(data.total);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => {
    api.get('/employees').then(({ data }) => setEmployees(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
  }, []);

  useEffect(() => { load(); }, [status, page]);

  function runSearch() {
    setPage(1);
    load();
  }

  async function handleDelete(row) {
    if (!confirm(`Delete estimate "${row.estimate_no}"? This removes its job orders and process lines too.`)) return;
    try {
      await api.delete(`/estimates/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const { data } = await api.post('/admin/sync-estimates');
      alert(`Sync complete. Checked ${data.checked}, imported ${data.imported} new, ${data.skipped} already present, ${data.errored} errored.`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <h1>Saved Estimates</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
          {user?.account_type === 'System Admin' && (
            <button className="btn btn-sm" disabled={syncing} onClick={handleSync}>
              {syncing ? <LoadingSpinner inline size="sm" label="Syncing..." /> : 'Sync New Estimates'}
            </button>
          )}
          {can('/estimates', 'can_add') && <button className="btn btn-primary" onClick={() => navigate('/estimates/new')}>Add Estimate</button>}
        </div>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." />
            </div>
            <div className="field">
              <label>Sales Rep</label>
              <select value={salesRepId} onChange={(e) => setSalesRepId(e.target.value)}>
                <option value="">All</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Location</label>
              <select value={officeLocationId} onChange={(e) => setOfficeLocationId(e.target.value)}>
                <option value="">All</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Date Created (As of)</label>
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
        </div>
      )}

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${status === t.key ? 'active' : ''}`}
            onClick={() => { setStatus(t.key); setPage(1); }}
          >
            {t.label} <span className="badge badge-muted">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Estimate No</th>
                    <th>Date Created</th>
                    <th>Location</th>
                    <th>Customer</th>
                    <th>Contract Description</th>
                    <th>Sales Rep.</th>
                    <th>Prepared By</th>
                    <th>Total Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No estimates found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.estimate_no}</td>
                      <td>{row.date_created ? String(row.date_created).slice(0, 10) : ''}</td>
                      <td>{row.location_name}</td>
                      <td>{row.customer_name}</td>
                      <td>{row.contract_description}</td>
                      <td>{row.sales_rep_name}</td>
                      <td>{row.prepared_by_name}</td>
                      <td>{money(row.total_amount)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-sm btn-primary" onClick={() => navigate(`/estimates/${row.id}`)}>View</button>
                          {can('/estimates', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
                        </div>
                      </td>
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
