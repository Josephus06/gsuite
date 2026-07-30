import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 15;
const STATUS_LABELS = { open: 'Open', void: 'Void' };
function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }

export default function Cheques() {
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
    const { data } = await api.get('/cheques', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Saved Cheques</h1>
        {can('/cheques', 'can_add') && <Link className="btn btn-primary" to="/cheques/new">Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Cheque No, Payee, Cheque # or Memo..." />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="open">Open</option>
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
                <tr><th>Cheque No</th><th>Date</th><th>Cheque Date</th><th>Cheque #</th><th>Payee</th><th>Account</th><th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No cheques found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Cheque No">{row.cheque_no}</td>
                    <td data-label="Date">{formatDate(row.date_created)}</td>
                    <td data-label="Cheque Date">{formatDate(row.cheque_date)}</td>
                    <td data-label="Cheque #">{row.cheque_number}</td>
                    <td data-label="Payee">{row.payee_name}</td>
                    <td data-label="Account">{row.account_name}</td>
                    <td data-label="Total" style={{ textAlign: 'right' }}>{money(row.total_amount)}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/cheques/${row.id}`}>View</Link></td>
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
