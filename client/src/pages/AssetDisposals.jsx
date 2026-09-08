import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { DISPOSAL_STATUS_LABELS, DISPOSAL_TYPE_LABELS, formatMoney } from '../utils/assetLabels';

const PAGE_SIZE = 15;
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

export default function AssetDisposals() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ search: '', status: '', disposal_type: '' });
  const [applied, setApplied] = useState({ search: '', status: '', disposal_type: '' });

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    for (const [k, v] of Object.entries(applied)) if (v) params[k] = v;
    const { data } = await api.get('/asset-disposals', { params });
    setRows(data.rows); setTotal(data.total); setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <h1>Asset Disposals</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/assets">Assets</Link>
          {can('/asset-disposals', 'can_add') && <Link className="btn btn-primary" to="/asset-disposals/new">Add New</Link>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={filters.search} onChange={(e) => setF({ search: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && (setPage(1), setApplied(filters))} placeholder="Disposal no, reference no, buyer..." />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(DISPOSAL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Type</label>
            <select value={filters.disposal_type} onChange={(e) => setF({ disposal_type: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(DISPOSAL_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => { setPage(1); setApplied(filters); }}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Disposal No</th><th>Date</th><th>Asset</th><th>Type</th>
                  <th style={{ textAlign: 'right' }}>Cost</th>
                  <th style={{ textAlign: 'right' }}>Book Value</th>
                  <th style={{ textAlign: 'right' }}>Proceeds</th>
                  <th style={{ textAlign: 'right' }}>Gain / (Loss)</th>
                  <th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No disposals yet.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Disposal No">{r.disposal_no}</td>
                    <td data-label="Date">{formatDate(r.disposal_date)}</td>
                    <td data-label="Asset">{r.reference_no} — {r.item_name}</td>
                    <td data-label="Type">{DISPOSAL_TYPE_LABELS[r.disposal_type] || r.disposal_type}</td>
                    <td data-label="Cost" style={{ textAlign: 'right' }}>{formatMoney(r.cost_at_disposal)}</td>
                    <td data-label="Book Value" style={{ textAlign: 'right' }}>{formatMoney(r.net_book_value)}</td>
                    <td data-label="Proceeds" style={{ textAlign: 'right' }}>{formatMoney(r.proceeds)}</td>
                    <td data-label="Gain / (Loss)" style={{ textAlign: 'right' }}>
                      {Number(r.gain_loss) < 0 ? `(${formatMoney(Math.abs(Number(r.gain_loss)))})` : formatMoney(r.gain_loss)}
                    </td>
                    <td data-label="Status">{DISPOSAL_STATUS_LABELS[r.status] || r.status}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-disposals/${r.id}`)}>View</button></td>
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
