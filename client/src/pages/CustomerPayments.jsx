import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';
import CustomerPaymentModal from '../components/CustomerPaymentModal';
import { useAuth } from '../context/useAuth';

const PAGE_SIZE = 10;
const NO_FILTERS = { search: '', status: '', departmentId: '', locationId: '', dateFrom: '', dateTo: '' };
// A saved payment sits NOT DEPOSITED until a bank deposit sweeps it into the bank.
const STATUS_LABELS = { not_deposited: 'Not Deposited', deposited: 'Deposited', voided: 'Void' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function CustomerPayments() {
  const { can } = useAuth();
  // Raising a payment starts with the CUSTOMER, because that is the only thing known when someone
  // walks in and hands money over. Which invoices it settles is decided in the form afterwards.
  const [customers, setCustomers] = useState([]);
  const [newFor, setNewFor] = useState(null);
  const [rows, setRows] = useState([]);
  // How many match the current filter, which is no longer the same as how many were downloaded.
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // Two copies of the filters on purpose. `form` is what the controls show as they are typed;
  // `applied` is what the last fetch actually used. Without the split, every keystroke in the
  // search box or a half-typed year in a date field would be a query against 130,000 rows.
  const [form, setForm] = useState(NO_FILTERS);
  const [applied, setApplied] = useState(NO_FILTERS);
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [page, setPage] = useState(1);

  // Applying a filter always returns to page 1: page 9,000 of "all" is not page 9,000 of
  // "deposited", and landing past the end of the filtered list would show an empty table.
  function apply(next) {
    setForm(next);
    setApplied(next);
    setPage(1);
  }
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // Bumped to re-run the fetch when nothing about the page or the filters changed but the data
  // did -- saving a new payment. Re-applying the same filter object would not do it: React skips
  // a state update that sets the identical value.
  const [refreshKey, setRefreshKey] = useState(0);

  // One effect is the only thing that fetches, keyed on the page and the applied filters. Every
  // control changes one of those two and nothing else, so there is no path that sets state and
  // forgets to reload, and none that reloads twice for one click.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const params = { page, page_size: PAGE_SIZE };
      if (applied.status) params.status = applied.status;
      if (applied.search) params.search = applied.search;
      if (applied.departmentId) params.department_id = applied.departmentId;
      if (applied.locationId) params.office_location_id = applied.locationId;
      if (applied.dateFrom) params.date_from = applied.dateFrom;
      if (applied.dateTo) params.date_to = applied.dateTo;
      try {
        const { data } = await api.get('/customer-payments', { params });
        // A slow page 1 must not overwrite a fast page 2 that was asked for after it.
        if (cancelled) return;
        setRows(data.rows || []);
        setTotal(Number(data.total) || 0);
      } finally {
        // In a finally so a failed request cannot leave the page spinning forever, which is what
        // the old `setLoading(false)` after the await would have done on any error.
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [page, applied, refreshKey]);

  // The two dropdowns' options. Lookups, not the admin lists -- a handful of rows each, needing
  // no permission beyond seeing this page. Failures are swallowed: a filter that cannot offer its
  // options is a missing dropdown, not a reason to take the list down with it.
  useEffect(() => {
    const pick = (data) => (Array.isArray(data) ? data : (data?.rows || []));
    api.get('/lookups/departments').then(({ data }) => setDepartments(pick(data))).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(pick(data))).catch(() => {});
  }, []);

  // Only for the Add picker, and only when the button is there to use it.
  useEffect(() => {
    if (!can('/customer-payments', 'can_add')) return;
    api.get('/customers').then(({ data }) => setCustomers(Array.isArray(data) ? data : (data?.rows || []))).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasFilters = Object.values(applied).some(Boolean) || Object.values(form).some(Boolean);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <h1>Customer Payments</h1>
        {can('/customer-payments', 'can_add') && (
          <EntityPicker
            label="Customer" items={customers} value="" getLabel={(c) => c?.name}
            columns={[{ key: 'customer_code', label: 'Code' }, { key: 'name', label: 'Name' }]}
            searchKeys={['customer_code', 'name']}
            onSelect={(c) => setNewFor(c)}
            triggerLabel="Add Customer Payment"
            triggerClassName="btn btn-primary"
          />
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input
              value={form.search} onChange={(e) => setField('search', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply(form)}
              placeholder="CPAY #, OR # or Customer..."
            />
          </div>
          <div className="field">
            <label>Status</label>
            {/* A dropdown applies on pick -- there is nothing half-chosen about it, unlike a
                date being keyed in or a name being typed. */}
            <select value={form.status} onChange={(e) => apply({ ...form, status: e.target.value })}>
              <option value="">--ALL--</option>
              <option value="not_deposited">Not Deposited</option>
              <option value="deposited">Deposited</option>
              <option value="voided">Void</option>
            </select>
          </div>
          <div className="field">
            <label>Location</label>
            <select value={form.locationId} onChange={(e) => apply({ ...form, locationId: e.target.value })}>
              <option value="">--ALL--</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name || l.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Department</label>
            <select value={form.departmentId} onChange={(e) => apply({ ...form, departmentId: e.target.value })}>
              <option value="">--ALL--</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Date From</label>
            <input
              type="date" value={form.dateFrom} max={form.dateTo || undefined}
              onChange={(e) => setField('dateFrom', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply(form)}
            />
          </div>
          <div className="field">
            <label>Date To</label>
            <input
              type="date" value={form.dateTo} min={form.dateFrom || undefined}
              onChange={(e) => setField('dateTo', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply(form)}
            />
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => apply(form)}>Search</button>
          {hasFilters && <button className="btn" onClick={() => apply(NO_FILTERS)}>Clear</button>}
          {/* The row count is the only way to tell "this department has no payments" apart from
              "the filter did not apply", now that the table shows ten rows either way. */}
          {!loading && <span className="muted">{total.toLocaleString()} payment{total === 1 ? '' : 's'} found</span>}
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Payment #</th>
                  <th>Date Created</th>
                  <th>Customer</th>
                  <th>Location</th>
                  <th>Department</th>
                  <th>OR #</th>
                  <th>Payment Method</th>
                  <th>Payment Amount</th>
                  <th>Applied Amount</th>
                  <th>Unapplied Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No customer payments found.</td></tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Payment #">{row.customer_payment_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Customer">{row.customer_name}</td>
                    <td data-label="Location">{row.office_location_name}</td>
                    <td data-label="Department">{row.department_name}</td>
                    <td data-label="OR #">{row.or_no}</td>
                    <td data-label="Payment Method">{row.payment_method_name}</td>
                    <td data-label="Payment Amount">{money(row.payment_amount)}</td>
                    <td data-label="Applied Amount">{money(row.applied_amount)}</td>
                    <td data-label="Unapplied Amount">{money(row.unapplied_amount)}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/customer-payments/${row.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {/* The same form an invoice's Accept Payment button opens, entered from the customer end. */}
      {newFor && (
        <CustomerPaymentModal
          customerId={newFor.id}
          onClose={() => setNewFor(null)}
          // The new payment has the highest id and the list is newest-first, so it is on page 1.
          onSaved={() => { setNewFor(null); setPage(1); setRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}
