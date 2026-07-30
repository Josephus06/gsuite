import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;
const TYPE_LABELS = { rma: 'RMA', rma_installation: 'RMA - Installation', sample: 'Sample', internal: 'Internal' };
const STATUS_LABELS = {
  pending_approval: 'Pending / Needs Approval', pending_for_jo: 'Pending for JO', jo_in_process: 'JO In-Process',
  pending_billing: 'Pending Billing', billed: 'Billed', cancelled: 'Cancelled',
};

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function NonStandardSalesOrders() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (type) params.type = type;
    if (search) params.search = search;
    const { data } = await api.get('/non-standard-sales-orders', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status, type]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Saved Non-Standard Sales Orders</h1>
        {can('/non-standard-sales-orders', 'can_add') && (
          <Link className="btn btn-primary" to="/non-standard-sales-orders/new">Add New</Link>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="NSSO # or Customer..." />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="rma">RMA</option>
              <option value="rma_installation">RMA - Installation</option>
              <option value="sample">Sample</option>
              <option value="internal">Internal</option>
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="pending_approval">Pending / Needs Approval</option>
              <option value="jo_in_process">JO In-Process</option>
              <option value="billed">Billed</option>
              <option value="cancelled">Cancelled</option>
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
                  <th>Sale Order No.</th><th>Date</th><th>Type</th><th>Location</th><th>Customer</th>
                  <th>Sales Rep</th><th>Memo</th><th style={{ textAlign: 'right' }}>Total Amount</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No non-standard sales orders found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Sale Order No.">{row.nsso_no}</td>
                    <td data-label="Date">{formatDate(row.date_created)}</td>
                    <td data-label="Type">{TYPE_LABELS[row.type] || row.type}</td>
                    <td data-label="Location">{row.office_location_name}</td>
                    <td data-label="Customer">{row.customer_name}</td>
                    <td data-label="Sales Rep">{row.sales_rep_name}</td>
                    <td data-label="Memo">{row.memo}</td>
                    <td data-label="Total Amount" style={{ textAlign: 'right' }}>{money(row.total_amount)}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/non-standard-sales-orders/${row.id}`}>View</Link></td>
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
