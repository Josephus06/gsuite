import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';
import SearchInput from '../components/SearchInput';

// Certificate of Completion list (2026-10-28) -- same shape as the Warranty Certificate list.
const PAGE_SIZE = 15;
// No approval: anything not voided is Issued (older pending/approved ones included).
const STATUS_LABELS = { issued: 'Issued', pending_approval: 'Issued', approved: 'Issued', voided: 'Voided' };
function formatDate(v) { return v ? displayDate(v) : ''; }

export default function CompletionCertificates() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (search) params.search = search;
    if (status) params.status = status;
    const { data } = await api.get('/completion-certificates', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Certificates of Completion</h1>
        {can('/completion-certificates', 'can_add') && <Link className="btn btn-primary" to="/completion-certificates/new">Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="COC #, SO #, PO #, Customer or Project..." />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="issued">Issued</option>
              <option value="voided">Voided</option>
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
                <tr><th>COC #</th><th>Date</th><th>Sales Order</th><th>PO #</th><th>Customer</th><th>Project Name</th><th>Submitted By</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No certificates of completion found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="COC #">{row.coc_no}</td>
                    <td data-label="Date">{formatDate(row.date_created)}</td>
                    <td data-label="Sales Order">{row.sales_order_no}</td>
                    <td data-label="PO #">{row.po_no}</td>
                    <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                    <td data-label="Project Name">{row.project_name}</td>
                    <td data-label="Submitted By">{row.submitted_by_name}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/completion-certificates/${row.id}`}>View</Link></td>
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
