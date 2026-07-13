import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's "Production > Assembly Build" ("Saved Assembly Build")
// list -- a flat filterable table (no status tabs), same pattern as Saved Job Orders.
export default function AssemblyBuilds() {
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const [search, setSearch] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [jobLocationId, setJobLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [customers, setCustomers] = useState([]);

  async function load() {
    setLoading(true);
    const params = { page, limit };
    if (search) params.search = search;
    if (salesRepId) params.sales_rep_id = salesRepId;
    if (jobLocationId) params.job_location_id = jobLocationId;
    if (customerId) params.customer_id = customerId;
    if (asOf) params.as_of = asOf;
    const { data } = await api.get('/assembly-builds', { params });
    setRows(data.rows);
    setTotal(data.total);
    setLoading(false);
  }

  useEffect(() => {
    api.get('/employees').then(({ data }) => setEmployees(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
    api.get('/customers').then(({ data }) => setCustomers(data));
  }, []);

  useEffect(() => { load(); }, [page]);

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <h1>Saved Assembly Build</h1>
        <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
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
              <label>JO Location</label>
              <select value={jobLocationId} onChange={(e) => setJobLocationId(e.target.value)}>
                <option value="">All</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Customer</label>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">All</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>AB #</th>
                    <th>JO #</th>
                    <th>Date Created</th>
                    <th>Job Location</th>
                    <th>Job Type</th>
                    <th>Job Desc</th>
                    <th>Sales Rep</th>
                    <th>Customer</th>
                    <th>Qty</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No assembly builds found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.ab_no}</td>
                      <td>{row.job_order_no}</td>
                      <td>{row.date_created ? String(row.date_created).slice(0, 10) : ''}</td>
                      <td>{row.job_location_name}</td>
                      <td>{row.job_type_name}</td>
                      <td>{row.job_desc}</td>
                      <td>{row.sales_rep_name}</td>
                      <td>{row.customer_name}</td>
                      <td>{row.quantity_built}</td>
                      <td>{row.status === 'cancelled' ? <span className="badge badge-muted">Cancelled</span> : <span className="badge badge-success">Saved</span>}</td>
                      <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/assembly-builds/${row.id}`)}>View</button></td>
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
