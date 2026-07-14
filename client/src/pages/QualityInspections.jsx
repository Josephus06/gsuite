import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's "Production > Quality Inspection" ("Saved Quality
// Inspection") list -- a flat filterable table (no status tabs), same pattern as
// Assembly Build's list.
export default function QualityInspections() {

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const [search, setSearch] = useState('');
  const [jobLocationId, setJobLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [locations, setLocations] = useState([]);
  const [customers, setCustomers] = useState([]);

  async function load() {
    setLoading(true);
    const params = { page, limit };
    if (search) params.search = search;
    if (jobLocationId) params.job_location_id = jobLocationId;
    if (customerId) params.customer_id = customerId;
    if (asOf) params.as_of = asOf;
    const { data } = await api.get('/quality-inspections', { params });
    setRows(data.rows);
    setTotal(data.total);
    setLoading(false);
  }

  useEffect(() => {
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
        <h1>Saved Quality Inspection</h1>
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
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>QI #</th>
                    <th>JO #</th>
                    <th>Date Created</th>
                    <th>Job Location</th>
                    <th>Customer</th>
                    <th>Pass Qty</th>
                    <th>RMA Qty</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No quality inspections found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="QI #">{row.qi_no}</td>
                      <td data-label="JO #">{row.job_order_no}</td>
                      <td data-label="Date Created">{row.date_created ? String(row.date_created).slice(0, 10) : ''}</td>
                      <td data-label="Job Location">{row.job_location_name}</td>
                      <td data-label="Customer">{row.customer_name}</td>
                      <td data-label="Pass Qty">{row.total_pass_qty}</td>
                      <td data-label="RMA Qty">{row.total_rma_qty}</td>
                      <td data-label="Status">{row.status === 'cancelled' ? <span className="badge badge-muted">Cancelled</span> : <span className="badge badge-success">Saved</span>}</td>
                      <td><Link className="btn btn-sm btn-primary" to={`/quality-inspections/${row.id}`}>View</Link></td>
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
