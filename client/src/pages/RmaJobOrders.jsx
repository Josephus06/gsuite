import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';

const PAGE_SIZE = 10;
const STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.', for_revision: 'For Revision', in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process', for_qi: 'For QI', partially_completed: 'Part. Completed', completed: 'Completed', invoiced: 'Invoiced',
};
const TYPE_STYLE = {
  RMA: { background: 'rgba(244,114,182,0.15)', color: '#db2777' },
  RFQC: { background: 'rgba(251,191,36,0.18)', color: '#b45309' },
  RWIP: { background: 'rgba(34,211,238,0.15)', color: '#0e7490' },
};
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
function statusLabel(r) {
  if (['Pending RMA Approval', 'Pending Approval', 'Cancelled'].includes(r.status)) return r.status;
  return STAGE_LABELS[r.production_stage] || r.status;
}

// Production > RMA: every RMA (from an RMA NSSO), RFQC (Quality Inspection rework) and RWIP
// (Production rework) job order in one read-only list, filterable by type. Each is approved and
// worked from its own Job Order / Production view -- see server/src/routes/rmaJobOrders.js.
export default function RmaJobOrders() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('');
  const [stage, setStage] = useState('');
  const [search, setSearch] = useState('');
  // Period From / As of Date: inclusive bounds on the Date column, applied on Search.
  const [dateFrom, setDateFrom] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);

  function listParams() {
    const params = {};
    if (type) params.type = type;
    if (stage) params.stage = stage;
    if (search) params.search = search;
    if (dateFrom) params.date_from = dateFrom;
    if (asOf) params.as_of = asOf;
    return params;
  }

  // Extract: every row under the filters above, as a workbook (same params as the list).
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/rma-job-orders/export', { params: listParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'rma-job-orders.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the RMA job orders.');
    } finally {
      setExporting(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/rma-job-orders', { params: listParams() });
      setRows(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { setPage(1); load(); }, [type, stage]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.rma_type]: (acc[r.rma_type] || 0) + 1 }), {});

  return (
    <div>
      <div className="page-header">
        <h1>RMA</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="JO #, Mother JO #, SO / NSSO # or Customer..." />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="RMA">RMA</option>
              <option value="RFQC">RFQC</option>
              <option value="RWIP">RWIP</option>
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="pending">Pending Approval</option>
              <option value="open">Approved / In-Process</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="field">
            <label>Period From</label>
            <input type="date" value={dateFrom} max={asOf || undefined} onChange={(e) => setDateFrom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
          </div>
          <div className="field">
            <label>As of Date</label>
            <input type="date" value={asOf} min={dateFrom || undefined} onChange={(e) => setAsOf(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={runSearch}>Search</button>
          <button className="btn" disabled={exporting} onClick={runExport} title="Download every job order under the filters above">
            {exporting ? 'Extracting...' : 'Extract'}
          </button>
          {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
          {!loading && (
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {rows.length.toLocaleString('en-US')} job orders
              {['RMA', 'RFQC', 'RWIP'].filter((t) => counts[t]).map((t) => ` · ${t} ${counts[t].toLocaleString('en-US')}`).join('')}
            </span>
          )}
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Type</th><th>JO #</th><th>Date</th><th>Mother JO</th><th>SO / NSSO</th><th>Customer</th>
                  <th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Location</th><th>Approved By</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>No RMA, RFQC or RWIP job orders found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Type"><span className="holo-status-pill" style={TYPE_STYLE[row.rma_type]}>{row.rma_type}</span></td>
                    <td data-label="JO #">{row.job_order_no}</td>
                    <td data-label="Date">{formatDate(row.created_at)}</td>
                    <td data-label="Mother JO">{row.parent_job_order_no || ''}</td>
                    <td data-label="SO / NSSO">{row.sales_order_no || row.nsso_no || ''}</td>
                    <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                    <td data-label="Job Type">{row.job_type_name}</td>
                    <td data-label="Description">{row.description}</td>
                    <td data-label="Qty" style={{ textAlign: 'right' }}>{Number(row.quantity)}</td>
                    <td data-label="Location">{row.job_location_name}</td>
                    <td data-label="Approved By">{row.rma_approved_by_name && row.rma_approved_by_name.trim() ? row.rma_approved_by_name : ''}</td>
                    <td data-label="Status">{statusLabel(row)}</td>
                    {/* Before production -> the Job Order view (approval lives there); once in production,
                        the Production view, where it is built and inspected. */}
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
