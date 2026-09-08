import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { TRANSFER_STATUS_LABELS } from '../utils/assetLabels';

const PAGE_SIZE = 15;

function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }

// Asset transfers (ATR-####). The "Waiting on me" filter is the reason this page is worth opening
// daily: it shows the transfers stopped on THIS user's signature, so an approval is something you
// find rather than something you have to be chased about.
export default function AssetTransfers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [awaitingCount, setAwaitingCount] = useState(0);

  const [filters, setFilters] = useState({ search: '', status: '', to_location_id: '', awaiting_me: '' });
  const [applied, setApplied] = useState({ search: '', status: '', to_location_id: '', awaiting_me: '' });

  useEffect(() => {
    api.get('/asset-transfers/meta').then(({ data }) => setLocations(data.locations)).catch(() => {});
    api.get('/asset-transfers', { params: { awaiting_me: 'yes', page_size: 1 } })
      .then(({ data }) => setAwaitingCount(data.total)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    for (const [k, v] of Object.entries(applied)) if (v) params[k] = v;
    const { data } = await api.get('/asset-transfers', { params });
    setRows(data.rows); setTotal(data.total); setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  function runSearch(overrides = {}) {
    const next = { ...filters, ...overrides };
    setFilters(next); setPage(1); setApplied(next);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <h1>Asset Transfers</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/assets">Assets</Link>
          {can('/asset-transfers', 'can_add') && <Link className="btn btn-primary" to="/asset-transfers/new">Add New</Link>}
        </div>
      </div>

      {awaitingCount > 0 && applied.awaiting_me !== 'yes' && (
        <div className="error-banner" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{awaitingCount} transfer{awaitingCount === 1 ? '' : 's'} {awaitingCount === 1 ? 'is' : 'are'} waiting for your approval.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => runSearch({ awaiting_me: 'yes' })}>Show them</button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={filters.search} onChange={(e) => setF({ search: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Transfer no, reason or memo..." />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">--ALL--</option>
              {Object.entries(TRANSFER_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Transfer To</label>
            <select value={filters.to_location_id} onChange={(e) => setF({ to_location_id: e.target.value })}>
              <option value="">--ALL--</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Approval</label>
            <select value={filters.awaiting_me} onChange={(e) => setF({ awaiting_me: e.target.value })}>
              <option value="">--ALL--</option>
              <option value="yes">Waiting on me</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => runSearch()}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Transfer No</th><th>Date</th><th>From</th><th>To</th><th>Releasing</th><th>Receiving</th><th style={{ textAlign: 'right' }}>Assets</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transfers found.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Transfer No">{r.transfer_no}</td>
                    <td data-label="Date">{formatDate(r.date_created)}</td>
                    <td data-label="From">{r.from_location_name || '—'}</td>
                    <td data-label="To">{r.to_location_name || '—'}</td>
                    <td data-label="Releasing">{r.from_custodian_name?.trim() || '—'}</td>
                    <td data-label="Receiving">{r.to_custodian_name?.trim() || '—'}</td>
                    <td data-label="Assets" style={{ textAlign: 'right' }}>{r.asset_count}</td>
                    <td data-label="Status">{TRANSFER_STATUS_LABELS[r.status] || r.status}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-transfers/${r.id}`)}>View</button></td>
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
