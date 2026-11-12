import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { downloadFile } from '../utils/downloadFile';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';
import FilterPicker from '../components/FilterPicker';
import SearchInput from '../components/SearchInput';

// Mirrors the real system's "Production > Assembly Build" ("Saved Assembly Build")
// list -- a flat filterable table (no status tabs), same pattern as Saved Job Orders.
export default function AssemblyBuilds() {

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(true); // shown by default; Toggle Filter hides them (asked 2026-10-06)

  const [search, setSearch] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [jobLocationId, setJobLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [asOf, setAsOf] = useState('');
  // Date Created: As of (up to a day) or Period from .. to (2026-11-12).
  const [dateMode, setDateMode] = useState('as_of');
  const [dateFrom, setDateFrom] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [customers, setCustomers] = useState([]);

  // The filters as query params -- shared by the list and its Extract.
  function filterParams() {
    const params = {};
    if (search) params.search = search;
    if (salesRepId) params.sales_rep_id = salesRepId;
    if (jobLocationId) params.job_location_id = jobLocationId;
    if (customerId) params.customer_id = customerId;
    if (asOf) params.as_of = asOf;
    if (dateMode === 'period' && dateFrom) params.date_from = dateFrom;
    return params;
  }

  async function load() {
    setLoading(true);
    const { data } = await api.get('/assembly-builds', { params: { ...filterParams(), page, limit } });
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
  useAutoSearch(search, runSearch);

  // Extract (2026-11-12): every build under the filters, as a workbook.
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    setExtracting(true);
    try { await downloadFile('/assembly-builds/export', filterParams(), 'assembly-builds.xlsx'); }
    catch { window.alert('Could not extract the assembly builds.'); }
    setExtracting(false);
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
              <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." />
            </div>
            <div className="field">
              <label>Sales Rep</label>
              <FilterPicker label="Sales Rep" items={employees} value={salesRepId} onChange={(v) => setSalesRepId(v)}
              getLabel={(e) => `${e.first_name} ${e.last_name}`} allLabel="All" />
            </div>
            <div className="field">
              <label>JO Location</label>
              <FilterPicker label="JO Location" items={locations} value={jobLocationId} onChange={(v) => setJobLocationId(v)}
              getLabel={(l) => l.location_name} allLabel="All" />
            </div>
            <div className="field">
              <label>Customer</label>
              <FilterPicker label="Customer" items={customers} value={customerId} onChange={(v) => setCustomerId(v)}
              getLabel={(c) => c.name} allLabel="All" />
            </div>
            <div className="field">
              <label>Date Created</label>
              <div style={{ alignItems: 'center' }}>
                <select value={dateMode} onChange={(e) => setDateMode(e.target.value)}>
                  <option value="as_of">As of</option>
                  <option value="period">Period from</option>
                </select>
                {dateMode === 'period' && (
                  <>
                    <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                    <span className="muted">to</span>
                  </>
                )}
                <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={runSearch}>Search</button>
            <button className="btn" onClick={extract} disabled={extracting}>{extracting ? 'Extracting...' : 'Extract'}</button>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table className="responsive-cards">
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
                      <td data-label="AB #">{row.ab_no}</td>
                      <td data-label="JO #">{row.job_order_no}</td>
                      <td data-label="Date Created">{row.date_created ? String(row.date_created).slice(0, 10) : ''}</td>
                      <td data-label="Job Location">{row.job_location_name}</td>
                      <td data-label="Job Type">{row.job_type_name}</td>
                      <td data-label="Job Desc">{row.job_desc}</td>
                      <td data-label="Sales Rep">{row.sales_rep_name}</td>
                      <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                      <td data-label="Qty">{row.quantity_built}</td>
                      <td data-label="Status">{row.status === 'cancelled' ? <span className="badge badge-muted">Cancelled</span> : <span className="badge badge-success">Saved</span>}</td>
                      <td><Link className="btn btn-sm btn-primary" to={`/assembly-builds/${row.id}`}>View</Link></td>
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
