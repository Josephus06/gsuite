import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from './Pagination';
import LoadingSpinner from './LoadingSpinner';
import EntityPicker from './EntityPicker';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import { downloadFile } from '../utils/downloadFile';
import { CustomerLink } from './PartyLink';

const PAGE_SIZE = 10;
const STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.', for_revision: 'For Revision', in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process', for_qi: 'For QI', partially_completed: 'Part. Completed', completed: 'Completed', invoiced: 'Invoiced',
};
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
function statusLabel(r) {
  if (r.status === 'Pending RMA Approval' || r.status === 'Cancelled') return r.status;
  return STAGE_LABELS[r.production_stage] || r.status;
}

// The RWIP and RFQC Job Orders lists -- read-only browses of rework job orders under Production
// (they are created, approved, built and inspected from the job-order views). Same filters as the
// NSSO list (2026-10-12): General Searching, Location (Head Office on open), Date (As of, or a
// From-To period), Sales Rep, Customer, Status -- and Extract. Server: lib/reworkJobOrderList.js.
//   prefix   'RWIP' | 'RFQC'
export default function ReworkJobOrderList({ prefix }) {
  const base = `/${prefix.toLowerCase()}-job-orders`;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  // Location starts null and becomes Head Office once the locations are in, so the first list is
  // already Head Office's.
  const [locationId, setLocationId] = useState(null);
  const [locations, setLocations] = useState([]);
  const [dateMode, setDateMode] = useState('as_of');
  const [asOf, setAsOf] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [salesRep, setSalesRep] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [options, setOptions] = useState({ reps: [], customers: [] });
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    api.get('/lookups/locations')
      .then(({ data }) => {
        const locs = Array.isArray(data) ? data : (data?.rows || []);
        setLocations(locs);
        const ho = locs.find((l) => String(l.location_name || '').trim().toLowerCase() === 'head office');
        setLocationId(ho ? String(ho.id) : '');
      })
      .catch(() => setLocationId(''));
    api.get(`${base}/filter-options`).then(({ data }) => setOptions(data)).catch(() => {});
  }, [base]);

  function listParams() {
    const params = {};
    if (stage) params.stage = stage;
    if (search) params.search = search;
    if (locationId) params.location_id = locationId;
    if (salesRep) params.sales_rep_id = salesRep.id;
    if (customer) params.customer_id = customer.id;
    if (dateMode === 'range') {
      params.date_mode = 'range';
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
    } else if (asOf) params.as_of = asOf;
    return params;
  }

  async function load() {
    setLoading(true);
    const { data } = await api.get(base, { params: listParams() });
    setRows(data);
    setLoading(false);
  }

  // Extract: every job order under the filters above, as a workbook.
  async function extract() {
    setExtracting(true);
    try {
      await downloadFile(`${base}/export`, listParams(), `${prefix.toLowerCase()}-job-orders-${new Date().toLocaleDateString('en-CA')}.xlsx`);
    } catch {
      alert(`Could not extract the ${prefix} job orders.`);
    } finally {
      setExtracting(false);
    }
  }

  useEffect(() => { if (locationId === null) return; setPage(1); load(); }, [stage, locationId]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>{prefix} Job Orders</h1>
        <button type="button" className="btn" onClick={extract} disabled={extracting}
          title={`Download every ${prefix} job order under the filters below`}>
          {extracting ? 'Extracting...' : 'Extract'}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder={`${prefix} #, Mother JO #, SO # or Customer...`} />
          </div>
          <div className="field">
            <label>Location</label>
            <select value={locationId ?? ''} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">--ALL--</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Date</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={dateMode} onChange={(e) => setDateMode(e.target.value)} style={{ width: 'auto' }}>
                <option value="as_of">As of</option>
                <option value="range">Period</option>
              </select>
              {dateMode === 'range' ? (
                <>
                  <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} title="From" />
                  <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} title="To" />
                </>
              ) : (
                <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              )}
            </div>
          </div>
          <div className="field">
            <label>Sales Rep</label>
            <EntityPicker
              label="Sales Rep" items={options.reps} value={salesRep?.id ?? ''} getLabel={(r) => r.name}
              columns={[{ key: 'name', label: 'Sales Rep' }]} searchKeys={['name']} placeholder="--ALL--"
              onSelect={(r) => setSalesRep(r || null)} onClear={() => setSalesRep(null)}
            />
          </div>
          <div className="field">
            <label>Customer</label>
            <EntityPicker
              label="Customer" items={options.customers} value={customer?.id ?? ''} getLabel={(c) => c.name}
              columns={[{ key: 'name', label: 'Customer' }]} searchKeys={['name']} placeholder="--ALL--"
              onSelect={(c) => setCustomer(c || null)} onClear={() => setCustomer(null)}
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="pending">Pending RMA Approval</option>
              <option value="open">Approved / In-Process</option>
              <option value="completed">Completed</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>{prefix} #</th><th>Date</th><th>Mother JO</th><th>Sales Order</th><th>Location</th><th>Customer</th>
                  <th>Sales Rep</th><th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Approved By</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>No {prefix} job orders found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label={`${prefix} #`}>{row.job_order_no}</td>
                    <td data-label="Date">{formatDate(row.created_at)}</td>
                    <td data-label="Mother JO">{row.parent_job_order_no}</td>
                    <td data-label="Sales Order">{row.sales_order_no}</td>
                    <td data-label="Location">{row.office_location_name}</td>
                    <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                    <td data-label="Sales Rep">{(row.sales_rep_name || '').trim()}</td>
                    <td data-label="Job Type">{row.job_type_name}</td>
                    <td data-label="Description">{row.description}</td>
                    <td data-label="Qty" style={{ textAlign: 'right' }}>{Number(row.quantity)}</td>
                    <td data-label="Approved By">{row.rma_approved_by_name && row.rma_approved_by_name.trim() ? row.rma_approved_by_name : ''}</td>
                    <td data-label="Status">{statusLabel(row)}</td>
                    {/* Pending approval -> Sales JO view (Approve lives there); once approved it's in
                        production, so link into the Production view to Build / Quality Inspect it. */}
                    <td><Link className="btn btn-sm btn-primary" to={row.production_stage ? `/production/${row.id}` : `/job-orders/${row.id}`}>View</Link></td>
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
