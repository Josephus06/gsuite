import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;
const STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.', for_revision: 'For Revision', in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process', for_qi: 'For QI', partially_completed: 'Part. Completed', completed: 'Completed', invoiced: 'Invoiced',
};
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }
function statusLabel(r) {
  if (r.status === 'Pending RMA Approval' || r.status === 'Cancelled') return r.status;
  return STAGE_LABELS[r.production_stage] || r.status;
}

// All RFQC (rework-from-quality-check) job orders -- read-only list under Production. RFQCs are
// raised during Quality Inspection for the RMA/damaged qty; this browses them.
export default function RfqcJobOrders() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (stage) params.stage = stage;
    if (search) params.search = search;
    const { data } = await api.get('/rfqc-job-orders', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>RFQC Job Orders</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="RFQC #, Mother JO #, SO # or Customer..." />
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
                  <th>RFQC #</th><th>Date</th><th>Mother JO</th><th>Sales Order</th><th>Customer</th>
                  <th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Approved By</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No RFQC job orders found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="RFQC #">{row.job_order_no}</td>
                    <td data-label="Date">{formatDate(row.created_at)}</td>
                    <td data-label="Mother JO">{row.parent_job_order_no}</td>
                    <td data-label="Sales Order">{row.sales_order_no}</td>
                    <td data-label="Customer">{row.customer_name}</td>
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
