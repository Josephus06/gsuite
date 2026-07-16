import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors server/src/lib/designSupervisorVisibility.js's own DESIGN_QUEUE_STATUS/
// DESIGN_QUEUE_SUB_STATUSES -- a JO is eligible for (re)assignment here only while
// still unassigned and sitting in a Design Supervisor's queue. Keep in sync with that
// file if the queue's status/sub-status values ever change.
const ASSIGNABLE_STATUS = 'Planned - Pending for BOM';
const ASSIGNABLE_SUB_STATUS = 'For Design Supervisor';

// Mirrors the real system's "Saved Job Orders" list -- a flat filterable table (no
// status tabs, unlike Estimates/Sales Orders), since Job Orders don't move through a
// small fixed set of approval-style stages. Design Supervisors additionally get a
// checkbox column + bulk "Assign Artist" action here (confirmed against the real
// system's own "Select Settings for Artist Schedule" screen), since assigning one JO
// at a time from its own detail page doesn't scale when a supervisor's queue has many
// waiting at once.
export default function JobOrders() {
  const navigate = useNavigate();
  const { user, can, permissions } = useAuth();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const [search, setSearch] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [jobLocationId, setJobLocationId] = useState('');
  const [officeLocationId, setOfficeLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [customers, setCustomers] = useState([]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showBulkAssign, setShowBulkAssign] = useState(false);
  const [pmsJobTypes, setPmsJobTypes] = useState([]);
  const [artists, setArtists] = useState([]);
  const [bulkFill, setBulkFill] = useState({ layout_job_type_id: '', artist_id: '', planned_start_at: '', layout_qty: 1 });
  const [rowSettings, setRowSettings] = useState({});
  const [bulkError, setBulkError] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const isDesignSupervisor = !!user?.is_design_supervisor;

  async function load() {
    setLoading(true);
    const params = { page, limit };
    if (search) params.search = search;
    if (salesRepId) params.sales_rep_id = salesRepId;
    if (jobLocationId) params.job_location_id = jobLocationId;
    if (officeLocationId) params.office_location_id = officeLocationId;
    if (customerId) params.customer_id = customerId;
    if (asOf) params.as_of = asOf;
    const { data } = await api.get('/job-orders', { params });
    setRows(data.rows);
    setTotal(data.total);
    setLoading(false);
  }

  useEffect(() => {
    api.get('/employees').then(({ data }) => setEmployees(data));
    // These two only feed optional filter-dropdown options -- a viewer without can_view
    // on Locations/Customers (e.g. a Design Supervisor's Artist-type account) should
    // still see the Job Orders list itself; skip the request entirely (rather than
    // fire-and-catch) so it doesn't even hit the network as a 403, and the affected
    // dropdown just stays empty.
    if (can('/lookups', 'can_view')) api.get('/lookups/locations').then(({ data }) => setLocations(data));
    if (can('/customers', 'can_view')) api.get('/customers').then(({ data }) => setCustomers(data));
    // Re-run once `permissions` actually finishes loading (starts empty on mount, even
    // for a returning user with a cached `user` object -- see AuthContext.jsx's loadMe)
    // -- otherwise a permitted viewer's very first render would wrongly skip these.
  }, [permissions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [page]);

  function runSearch() {
    setPage(1);
    load();
  }

  function isAssignable(row) {
    return row.status === ASSIGNABLE_STATUS && row.sub_status === ASSIGNABLE_SUB_STATUS;
  }

  function toggleSelect(row) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  function openBulkAssign() {
    if (pmsJobTypes.length === 0) api.get('/pms-job-types').then(({ data }) => setPmsJobTypes(data));
    if (artists.length === 0) api.get('/employees', { params: { account_type: 'Artist' } }).then(({ data }) => setArtists(data));
    // Each selected row starts from the current bulk-fill values -- editing a row
    // afterward only overrides that one row, same as the real screen's per-row table.
    const initial = {};
    for (const id of selectedIds) initial[id] = { ...bulkFill };
    setRowSettings(initial);
    setBulkError('');
    setShowBulkAssign(true);
  }

  function applyBulkFill(patch) {
    const next = { ...bulkFill, ...patch };
    setBulkFill(next);
    // Bulk-fill fields propagate to every selected row immediately -- matches filling
    // in the top of the real "Select Settings for Artist Schedule" screen and having
    // every listed JO pick it up, while still leaving each row individually editable.
    setRowSettings((prev) => {
      const updated = {};
      for (const id of Object.keys(prev)) updated[id] = { ...prev[id], ...patch };
      return updated;
    });
  }

  function updateRow(id, patch) {
    setRowSettings((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleBulkSave() {
    setBulkError('');
    const ids = Object.keys(rowSettings);
    for (const id of ids) {
      const r = rowSettings[id];
      if (!r.layout_job_type_id || !r.artist_id || !r.planned_start_at) {
        const jo = rows.find((row) => String(row.id) === String(id));
        setBulkError(`Fill in Layout Job Type, Artist, and Start Date for ${jo?.job_order_no || `JO #${id}`}.`);
        return;
      }
    }
    setBulkBusy(true);
    try {
      for (const id of ids) {
        const r = rowSettings[id];
        await api.put(`/job-orders/${id}/assign-design`, {
          layout_job_type_id: r.layout_job_type_id,
          artist_id: r.artist_id,
          planned_start_at: r.planned_start_at,
          layout_qty: r.layout_qty || 1,
        });
      }
      setShowBulkAssign(false);
      setSelectedIds(new Set());
      await load();
    } catch (err) {
      setBulkError(err.response?.data?.error || 'Assign failed');
    } finally {
      setBulkBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const selectedRows = rows.filter((r) => selectedIds.has(r.id));

  return (
    <div>
      <div className="page-header">
        <h1>Saved Job Orders</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {isDesignSupervisor && selectedIds.size > 0 && (
            <button className="btn btn-primary" onClick={openBulkAssign}>Assign Artist ({selectedIds.size})</button>
          )}
          <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
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
              <label>JO Location</label>
              <select value={jobLocationId} onChange={(e) => setJobLocationId(e.target.value)}>
                <option value="">All</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Office Location</label>
              <select value={officeLocationId} onChange={(e) => setOfficeLocationId(e.target.value)}>
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
                    {isDesignSupervisor && <th></th>}
                    <th>JO #</th>
                    <th>SO #</th>
                    <th>Date Created</th>
                    <th>Office Location</th>
                    <th>Location</th>
                    <th>Department</th>
                    <th>Job Type</th>
                    <th>Job Desc</th>
                    <th>Qty</th>
                    <th>Customer</th>
                    <th>Contact Person</th>
                    <th>Prepared By</th>
                    <th>Sales Rep</th>
                    <th>Artist</th>
                    <th>Status</th>
                    <th>Sub Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={18} className="muted" style={{ textAlign: 'center', padding: 20 }}>No job orders found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      {isDesignSupervisor && (
                        <td data-label="">
                          {isAssignable(row) && (
                            <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelect(row)} />
                          )}
                        </td>
                      )}
                      <td data-label="JO #">{row.job_order_no}</td>
                      <td data-label="SO #">
                        <button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${row.sales_order_id}`)}>
                          {row.sales_order_no}
                        </button>
                      </td>
                      <td data-label="Date Created">{row.created_at ? String(row.created_at).slice(0, 10) : ''}</td>
                      <td data-label="Office Location">{row.office_location_name}</td>
                      <td data-label="Location">{row.job_location_name}</td>
                      <td data-label="Department">{row.sales_division_name}</td>
                      <td data-label="Job Type">{row.job_type_name}</td>
                      <td data-label="Job Desc">{row.description}</td>
                      <td data-label="Qty">{row.quantity}</td>
                      <td data-label="Customer">{row.customer_name}</td>
                      <td data-label="Contact Person">{row.contact_name}</td>
                      <td data-label="Prepared By">{row.prepared_by_name}</td>
                      <td data-label="Sales Rep">{row.sales_rep_name}</td>
                      <td data-label="Artist">{row.artist_name}</td>
                      <td data-label="Status">{row.status}</td>
                      <td data-label="Sub Status">{row.sub_status}</td>
                      <td><Link className="btn btn-sm btn-primary" to={`/job-orders/${row.id}`}>View</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>

      {showBulkAssign && (
        <Modal title="Select Settings for Artist Schedule" onClose={() => setShowBulkAssign(false)} large>
          {bulkError && <div className="error-banner">{bulkError}</div>}
          <div className="field-row">
            <div className="field">
              <label>Layout Job Type</label>
              <select value={bulkFill.layout_job_type_id} onChange={(e) => applyBulkFill({ layout_job_type_id: e.target.value })}>
                <option value="">Select a Layout Job Type</option>
                {pmsJobTypes.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Start Date</label>
              <input type="datetime-local" value={bulkFill.planned_start_at} onChange={(e) => applyBulkFill({ planned_start_at: e.target.value })} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Artist</label>
              <select value={bulkFill.artist_id} onChange={(e) => applyBulkFill({ artist_id: e.target.value })}>
                <option value="">Select an Artist</option>
                {artists.map((a) => <option key={a.id} value={a.id}>{a.first_name} {a.last_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Qty (LOT)</label>
              <input type="number" min="1" value={bulkFill.layout_qty} onChange={(e) => applyBulkFill({ layout_qty: e.target.value })} />
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>JO Number</th><th>Layout Job Type</th><th>Artist</th><th>Start Date</th><th>Qty (LOT)</th>
                </tr>
              </thead>
              <tbody>
                {selectedRows.map((row) => {
                  const r = rowSettings[row.id] || {};
                  return (
                    <tr key={row.id}>
                      <td>{row.job_order_no}</td>
                      <td>
                        <select value={r.layout_job_type_id || ''} onChange={(e) => updateRow(row.id, { layout_job_type_id: e.target.value })}>
                          <option value="">Select a Layout Job Type</option>
                          {pmsJobTypes.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={r.artist_id || ''} onChange={(e) => updateRow(row.id, { artist_id: e.target.value })}>
                          <option value="">Select an Artist</option>
                          {artists.map((a) => <option key={a.id} value={a.id}>{a.first_name} {a.last_name}</option>)}
                        </select>
                      </td>
                      <td><input type="datetime-local" value={r.planned_start_at || ''} onChange={(e) => updateRow(row.id, { planned_start_at: e.target.value })} /></td>
                      <td><input type="number" min="1" style={{ width: 70 }} value={r.layout_qty || 1} onChange={(e) => updateRow(row.id, { layout_qty: e.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setShowBulkAssign(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={bulkBusy} onClick={handleBulkSave}>
              {bulkBusy ? 'Saving...' : 'Save To Project'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
