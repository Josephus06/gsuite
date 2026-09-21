import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import SyncFromSourceButton from '../components/SyncFromSourceButton';
import SalesInvoiceModal from '../components/SalesInvoiceModal';
import { useAuth } from '../context/useAuth';

const PAGE_SIZE = 10;
const STATUS_LABELS = { saved: 'Open', cancelled: 'Void' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

// Mirrors the real system's "Saved Invoices" list -- reached from Accounting > Invoice
// on the real site. Only Sales Invoices exist in this build (no BS/DR/DT transaction
// types), so Type always reads "SI" and there's no Type filter -- everything else
// (columns, Status filter, search) mirrors the real screen.
export default function SalesInvoices() {
  const navigate = useNavigate();
  const { can } = useAuth();
  // can_add, matching what the server asks of this path: raising an invoice against an Estimate
  // is creating a new document, not amending one. Billing a Sales Order or a Delivery Ticket
  // still needs can_edit, because those move quantities and statuses on records that already
  // exist -- see requireInvoiceCreatePermission in routes/salesInvoices.js.
  const mayCreate = can('/sales-invoices', 'can_add');
  const [showCreate, setShowCreate] = useState(false);

  const [rows, setRows] = useState([]);
  // The server now decides the page, so the total has to come from it too -- rows.length is
  // only ever the ten rows on screen.
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  // Date Created, both ends optional and both inclusive. Held as plain yyyy-mm-dd strings, which
  // is what <input type="date"> gives and what the server compares against a DATE column -- no
  // Date object in between to drag the value through a timezone on the way.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [page, setPage] = useState(1);

  // From the invoice module's own meta route, not /lookups/departments: a third of the people who
  // can read this page cannot read /lookups, and they would have got an empty dropdown with no
  // sign of why. See the /meta route in routes/salesInvoices.js.
  useEffect(() => {
    api.get('/sales-invoices/meta')
      .then(({ data }) => setDepartments(data.departments || []))
      .catch(() => setDepartments([]));
  }, []);

  // Asks the server for ONE page. This used to fetch every row and slice it here, which meant
  // downloading the whole table to display ten of it -- and it made the search box a lie, since
  // it could only match rows already downloaded. Both now happen server-side.
  async function load(toPage = page) {
    setLoading(true);
    const params = { page: toPage, limit: PAGE_SIZE };
    if (status) params.status = status;
    if (search) params.search = search;
    if (from) params.from = from;
    if (to) params.to = to;
    if (departmentId) params.department_id = departmentId;
    try {
      const { data } = await api.get('/sales-invoices', { params });
      setRows(data.rows || []);
      setTotal(Number(data.total) || 0);
    } finally {
      setLoading(false);
    }
  }

  // Every one of these changes which rows the SERVER should return, so each has to refetch --
  // paging is no longer something the browser can answer out of what it already holds.
  // The two dropdowns apply themselves; the dates and the search box wait for Search. A <select>
  // is one deliberate act, but a date input fires onChange on the way to a complete date, so
  // refetching on it would run a query per keystroke against half-typed years.
  useEffect(() => { setPage(1); load(1); }, [status, departmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load(1);
  }

  // Cleared in one go rather than field by field: four filters can combine into an empty list
  // whose cause is off-screen, and hunting for which one did it is the moment people give up on
  // a filter bar. The fetch is issued with the cleared values directly -- setState has not landed
  // yet when load() reads them.
  function clearFilters() {
    setStatus(''); setSearch(''); setFrom(''); setTo(''); setDepartmentId('');
    setPage(1);
    setLoading(true);
    api.get('/sales-invoices', { params: { page: 1, limit: PAGE_SIZE } })
      .then(({ data }) => { setRows(data.rows || []); setTotal(Number(data.total) || 0); })
      .finally(() => setLoading(false));
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageRows = rows;

  return (
    <div>
      <div className="page-header">
        <h1>Saved Invoices</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {mayCreate && (
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create New</button>
          )}
          <SyncFromSourceButton module="sales_invoices" onDone={load} />
        </div>
      </div>

      {showCreate && (
        <SalesInvoiceModal
          fromEstimate
          onClose={() => setShowCreate(false)}
          onSaved={(si) => { setShowCreate(false); navigate(`/sales-invoices/${si.id}`); }}
        />
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Invoice # or SO No..." />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="saved">Open</option>
              <option value="cancelled">Void</option>
            </select>
          </div>
          <div className="field">
            <label>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">--ALL--</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Date From</label>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>Date To</label>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={runSearch}>Search</button>
          <button className="btn" onClick={clearFilters}>Clear</button>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>SO #</th>
                  <th>Date Created</th>
                  <th>Date Due</th>
                  <th>Office Location</th>
                  <th>Customer</th>
                  <th>Sales Rep</th>
                  <th>Department</th>
                  <th>Net of Tax</th>
                  <th>Tax Amount</th>
                  <th>Gross Amount</th>
                  <th>Amount Due</th>
                  <th>Type</th>
                  <th>BS/SI #</th>
                  <th>Term</th>
                  <th>Status</th>
                  <th>Memo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={18} className="muted" style={{ textAlign: 'center', padding: 20 }}>No invoices found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Invoice #">{row.invoice_no}</td>
                    <td data-label="SO #">{row.sales_order_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Date Due">{formatDate(row.date_due)}</td>
                    <td data-label="Office Location">{row.office_location_name}</td>
                    <td data-label="Customer">{row.customer_name}</td>
                    <td data-label="Sales Rep">{row.sales_rep_name}</td>
                    <td data-label="Department">{row.department_name}</td>
                    <td data-label="Net of Tax">{money(row.net_of_tax)}</td>
                    <td data-label="Tax Amount">{money(row.tax_amount)}</td>
                    <td data-label="Gross Amount">{money(row.gross_amount)}</td>
                    <td data-label="Amount Due">{money(row.amount_due)}</td>
                    <td data-label="Type">SI</td>
                    <td data-label="BS/SI #">{row.bs_si_no}</td>
                    <td data-label="Term">{row.term}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td data-label="Memo">{row.memo}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/sales-invoices/${row.id}`}>View</Link></td>
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
