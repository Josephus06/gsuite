import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

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
    const { data } = await api.get('/sales-invoices', { params });
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
        <h1>Saved Invoices</h1>
      </div>

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
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
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
                    <td>{row.invoice_no}</td>
                    <td>{row.sales_order_no}</td>
                    <td>{formatDate(row.date_created)}</td>
                    <td>{formatDate(row.date_due)}</td>
                    <td>{row.office_location_name}</td>
                    <td>{row.customer_name}</td>
                    <td>{row.sales_rep_name}</td>
                    <td>{row.department_name}</td>
                    <td>{money(row.net_of_tax)}</td>
                    <td>{money(row.tax_amount)}</td>
                    <td>{money(row.gross_amount)}</td>
                    <td>{money(row.amount_due)}</td>
                    <td>SI</td>
                    <td>{row.bs_si_no}</td>
                    <td>{row.term}</td>
                    <td>{STATUS_LABELS[row.status] || row.status}</td>
                    <td>{row.memo}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/sales-invoices/${row.id}`)}>View</button></td>
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
