import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { DEPRECIATION_STATUS_LABELS, formatMoney, formatMonth } from '../utils/assetLabels';

const PAGE_SIZE = 15;

// Generating a run shows the charge BEFORE the document exists. Depreciation is a posting nobody
// wants to discover was wrong after it hit the Trial Balance, so the preview is the point.
function NewRunModal({ suggested, onClose, onCreated }) {
  const [period, setPeriod] = useState(suggested || new Date().toISOString().slice(0, 7));
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!period) return;
    setLoading(true); setError('');
    api.get('/asset-depreciation/preview', { params: { period_month: period } })
      .then(({ data }) => setPreview(data))
      .catch((e) => { setPreview(null); setError(e.response?.data?.error || 'Could not preview that period.'); })
      .finally(() => setLoading(false));
  }, [period]);

  async function create() {
    setError(''); setSaving(true);
    try { const { data } = await api.post('/asset-depreciation', { period_month: period }); onCreated(data); }
    catch (e) { setError(e.response?.data?.error || 'Could not create the run.'); setSaving(false); }
  }

  return (
    <Modal title="Run Depreciation" onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      <div className="field" style={{ maxWidth: 240 }}>
        <label>Period *</label>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
      </div>

      {loading ? <LoadingSpinner /> : preview && (
        <>
          <p className="muted">
            {preview.asset_count} asset{preview.asset_count === 1 ? '' : 's'} due depreciation for {formatMonth(preview.period_month)},
            totalling <strong>{formatMoney(preview.total_amount)}</strong>.
          </p>
          <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Reference No</th><th>Asset</th><th>Class</th>
                  <th style={{ textAlign: 'right' }}>Cost</th><th style={{ textAlign: 'right' }}>Base</th>
                  <th style={{ textAlign: 'right' }}>Accumulated</th><th style={{ textAlign: 'right' }}>This Month</th>
                  <th style={{ textAlign: 'right' }}>Months Left</th>
                </tr>
              </thead>
              <tbody>
                {(preview.lines || []).map((l) => (
                  <tr key={l.id}>
                    <td>{l.reference_no}</td>
                    <td>{l.item_name}</td>
                    <td>{l.class_name}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(l.capitalized_cost)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(l.depreciable_base)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(l.opening_accumulated)}</td>
                    <td style={{ textAlign: 'right' }}><strong>{formatMoney(l.amount)}</strong></td>
                    <td style={{ textAlign: 'right' }}>{l.remaining_life_months}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !preview?.asset_count} onClick={create}>
          {saving ? 'Creating...' : 'Create Draft Run'}
        </button>
      </div>
    </Modal>
  );
}

export default function AssetDepreciation() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    if (applied) params.status = applied;
    const { data } = await api.get('/asset-depreciation', { params });
    setRows(data.rows); setTotal(data.total); setLoading(false);
  }, [page, applied]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/asset-depreciation/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <h1>Asset Depreciation</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/assets">Assets</Link>
          <Link className="btn btn-sm" to="/reports/fixed-asset-roll-forward">Roll Forward</Link>
          {can('/asset-depreciation', 'can_add') && meta && <button className="btn btn-primary" onClick={() => setShowNew(true)}>Run Depreciation</button>}
        </div>
      </div>

      {meta && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div>Last posted period : <span className="hi">{meta.last_posted_period ? formatMonth(meta.last_posted_period) : 'none yet'}</span></div>
            <div>Next period due : <span className="hi">{formatMonth(meta.suggested_period)}</span></div>
          </div>
          {(meta.open_drafts || []).length > 0 && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
              {meta.open_drafts.length} draft run{meta.open_drafts.length === 1 ? '' : 's'} waiting to be posted.
            </p>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              {Object.entries(DEPRECIATION_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => { setPage(1); setApplied(status); }}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Run No</th><th>Period</th><th style={{ textAlign: 'right' }}>Assets</th>
                  <th style={{ textAlign: 'right' }}>Amount</th><th>Status</th><th>Posted By</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No depreciation runs yet.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Run No">{r.run_no}</td>
                    <td data-label="Period">{formatMonth(r.period_month)}</td>
                    <td data-label="Assets" style={{ textAlign: 'right' }}>{r.asset_count}</td>
                    <td data-label="Amount" style={{ textAlign: 'right' }}>{formatMoney(r.total_amount)}</td>
                    <td data-label="Status">{DEPRECIATION_STATUS_LABELS[r.status] || r.status}</td>
                    <td data-label="Posted By">{r.posted_by_name || '—'}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-depreciation/${r.id}`)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {showNew && meta && (
        <NewRunModal suggested={meta.suggested_period} onClose={() => setShowNew(false)} onCreated={(d) => navigate(`/asset-depreciation/${d.id}`)} />
      )}
    </div>
  );
}
