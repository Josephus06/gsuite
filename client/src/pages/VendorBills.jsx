import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;
const STATUS_LABELS = { open: 'Open', paid_in_full: 'Paid in Full', cancelled: 'Cancelled' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

// Mirrors Saved Invoices' list layout -- the AP-side counterpart, reached from a
// Purchase Order's "Bill" button rather than its own standalone Add flow.
export default function VendorBills() {

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    const { data } = await api.get('/vendor-bills', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Vendor Bills</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Bill # or PO No..." />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="open">Open</option>
              <option value="paid_in_full">Paid in Full</option>
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
                  <th>Bill #</th>
                  <th>PO #</th>
                  <th>Date Created</th>
                  <th>Date Due</th>
                  <th>Office Location</th>
                  <th>Vendor</th>
                  <th>Gross Amount</th>
                  <th>Amount Due</th>
                  <th>Term</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No bills found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Bill #">{row.bill_no}</td>
                    <td data-label="PO #">{row.po_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Date Due">{formatDate(row.date_due)}</td>
                    <td data-label="Office Location">{row.office_location_name}</td>
                    <td data-label="Vendor">{row.supplier_name}</td>
                    <td data-label="Gross Amount">{money(row.gross_amount)}</td>
                    <td data-label="Amount Due">{money(row.amount_due)}</td>
                    <td data-label="Term">{row.term}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/vendor-bills/${row.id}`}>View</Link></td>
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
