import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useHeadOfficeFilter } from '../utils/useHeadOffice';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import SyncFromSourceButton from '../components/SyncFromSourceButton';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';
import FilterPicker from '../components/FilterPicker';
import { downloadFile } from '../utils/downloadFile';
import SearchInput from '../components/SearchInput';

// Mirrors Estimates.jsx / the real system's "Saved Sales Orders" list -- Sales Orders
// are only ever generated automatically (when an estimate reaches Approved), so there
// is no "Add" action here, just filtering/browsing/viewing.
const STATUS_TABS = [
  { key: 'pending_for_jo', label: 'Pending for JO' },
  { key: 'jo_in_process', label: 'JO In-Process' },
  { key: 'pending_delivery', label: 'Pending Delivery' },
  { key: 'partially_delivered', label: 'Partially Delivered' },
  { key: 'pending_billing', label: 'Pending Billing' },
  { key: 'pending_billing_partially_delivered', label: 'Pending Billing / Partially Delivered' },
  { key: 'partially_billed', label: 'Partially Billed' },
  { key: 'billed', label: 'Billed' },
  { key: 'cancelled', label: 'Cancelled' },
];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function SalesOrders() {

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(true); // shown by default; Toggle Filter hides them (asked 2026-10-06)

  const [status, setStatus] = useState('pending_for_jo');
  const [search, setSearch] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  // Head Office by default (2026-10-14; utils/useHeadOffice); null until known, and the list waits for it.
  const [officeLocationId, setOfficeLocationId] = useHeadOfficeFilter();
  const [asOf, setAsOf] = useState('');
  // Customer, and Date Created as "As of" or "Period from" (added 2026-10-26).
  const [customerId, setCustomerId] = useState('');
  const [dateMode, setDateMode] = useState('as of');
  const [dateFrom, setDateFrom] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [customers, setCustomers] = useState([]);

  // The filters on screen. status '' = every status (the All tab / Status filter, 2026-10-14).
  function filterParams() {
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    if (salesRepId) params.sales_rep_id = salesRepId;
    if (officeLocationId) params.office_location_id = officeLocationId;
    if (customerId) params.customer_id = customerId;
    if (dateMode === 'period from' && dateFrom) params.date_from = dateFrom;
    if (asOf) params.as_of = asOf;
    return params;
  }

  // Extract: every order under the filters and status on screen, as Excel (2026-10-14).
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    setExtracting(true);
    try {
      await downloadFile('/sales-orders', { ...filterParams(), format: 'xlsx' }, `sales-orders${status ? `-${status}` : ''}.xlsx`);
    } catch {
      window.alert('Could not extract the sales orders.');
    }
    setExtracting(false);
  }

  async function load() {
    setLoading(true);
    const params = { ...filterParams(), page, limit };
    const { data } = await api.get('/sales-orders', { params });
    setRows(data.rows);
    setTotal(data.total);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => {
    api.get('/employees').then(({ data }) => setEmployees(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
    api.get('/customers').then(({ data }) => setCustomers(Array.isArray(data) ? data : (data?.rows || []))).catch(() => setCustomers([]));
  }, []);

  useEffect(() => { if (officeLocationId === null) return; load(); }, [status, page, officeLocationId === null]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <h1>Saved Sales Orders</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <SyncFromSourceButton module="sales_orders" onDone={load} />
          <button className="btn btn-sm" onClick={extract} disabled={extracting}>{extracting ? 'Extracting...' : 'Extract'}</button>
          <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
        </div>
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
              <label>Location</label>
              <FilterPicker label="Location" items={locations} value={officeLocationId ?? ''} onChange={(v) => setOfficeLocationId(v)}
              getLabel={(l) => l.location_name} allLabel="All" />
            </div>
            <div className="field">
              <label>Status</label>
              <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                <option value="">All</option>
                {STATUS_TABS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Customer</label>
              <FilterPicker label="Customer" items={customers} value={customerId} onChange={(v) => setCustomerId(v)}
                getLabel={(c) => c.name} allLabel="All" />
            </div>
            {/* As of: up to the date. Period from: between the two dates. */}
            <div className="field" style={{ gridColumn: dateMode === 'period from' ? 'span 2' : undefined }}>
              <label>Date Created</label>
              <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                <select value={dateMode} style={{ flex: '0 0 125px', minWidth: 0 }} onChange={(e) => setDateMode(e.target.value)}>
                  <option value="as of">As of</option>
                  <option value="period from">Period from</option>
                </select>
                {dateMode === 'period from' && (
                  <input type="date" style={{ flex: '1 1 0', minWidth: 0 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                )}
                <input type="date" style={{ flex: '1 1 0', minWidth: 0 }} value={asOf} onChange={(e) => setAsOf(e.target.value)}
                  title={dateMode === 'period from' ? 'To' : 'As of'} />
              </div>
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
        </div>
      )}

      <div className="status-tabs">
        <button className={`status-tab ${status === '' ? 'active' : ''}`} onClick={() => { setStatus(''); setPage(1); }}>
          All <span className="badge badge-muted">{Object.values(counts).reduce((s, n) => s + Number(n || 0), 0)}</span>
        </button>
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
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>Sale Order No.</th>
                    <th>Est No.</th>
                    <th>Date</th>
                    {status === '' && <th>Status</th>}
                    <th>Location</th>
                    <th>Customer</th>
                    <th>Contract Description</th>
                    <th>Sales Rep.</th>
                    <th>Prepared By</th>
                    <th>Net of Tax</th>
                    <th>Total Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No sales orders found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Sale Order No.">{row.sales_order_no}</td>
                      <td data-label="Est No.">{row.estimate_no}</td>
                      <td data-label="Date">{row.date_created ? String(row.date_created).slice(0, 10) : ''}</td>
                      {status === '' && <td data-label="Status">{STATUS_TABS.find((t) => t.key === row.status)?.label || row.status}</td>}
                      <td data-label="Location">{row.location_name}</td>
                      <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                      <td data-label="Contract Description">{row.contract_description}</td>
                      <td data-label="Sales Rep.">{row.sales_rep_name}</td>
                      <td data-label="Prepared By">{row.prepared_by_name}</td>
                      <td data-label="Net of Tax">{money(row.net_of_tax)}</td>
                      <td data-label="Total Amount">{money(row.total_amount)}</td>
                      <td><Link className="btn btn-sm btn-primary" to={`/sales-orders/${row.id}`}>View</Link></td>
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
