import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import SyncFromSourceButton from '../components/SyncFromSourceButton';

const PAGE_SIZE = 10;
const STATUS_LABELS = { open: 'Open', converted: 'Converted', void: 'Void' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

// Flat list of every Delivery Ticket. Converted tickets keep their row and link to the
// Invoice they became -- the ticket is the record of what left, so it stays visible after
// billing rather than disappearing from the list.
export default function DeliveryTickets() {
  const [rows, setRows] = useState([]);
  // The server now decides the page, so the total has to come from it too -- rows.length is
  // only ever the ten rows on screen.
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Asks the server for ONE page. This used to fetch every row and slice it here, which meant
  // downloading the whole table to display ten of it -- and it made the search box a lie, since
  // it could only match rows already downloaded. Both now happen server-side.
  async function load(toPage = page) {
    setLoading(true);
    const params = { page: toPage, limit: PAGE_SIZE };
    if (status) params.status = status;
    if (search) params.search = search;
    try {
      const { data } = await api.get('/delivery-tickets', { params });
      setRows(data.rows || []);
      setTotal(Number(data.total) || 0);
    } finally {
      setLoading(false);
    }
  }

  // Every one of these changes which rows the SERVER should return, so each has to refetch --
  // paging is no longer something the browser can answer out of what it already holds.
  useEffect(() => { setPage(1); load(1); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageRows = rows;

  return (
    <div>
      <div className="page-header">
        <h1>Delivery Tickets</h1>
        <SyncFromSourceButton module="delivery_tickets" onDone={load} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="DT #, SO #, Customer or PO #..."
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="open">Open</option>
              <option value="converted">Converted</option>
              <option value="void">Void</option>
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
                  <th>DT #</th>
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
                  <th>Term</th>
                  <th>PO #</th>
                  <th>Invoice</th>
                  <th>Status</th>
                  <th>Memo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={17} className="muted" style={{ textAlign: 'center', padding: 20 }}>No delivery tickets found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="DT #">{row.dt_no}</td>
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
                    <td data-label="Term">{row.term}</td>
                    <td data-label="PO #">{row.po_no}</td>
                    <td data-label="Invoice">
                      {row.sales_invoice_id
                        ? <Link className="link-btn" to={`/sales-invoices/${row.sales_invoice_id}`}>{row.invoice_no}</Link>
                        : '—'}
                    </td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td data-label="Memo">{row.memo}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/delivery-tickets/${row.id}`}>View</Link></td>
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
