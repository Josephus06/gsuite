import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { DISPOSAL_STATUS_LABELS, DISPOSAL_TYPE_LABELS, formatMoney } from '../utils/assetLabels';

function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

function VoidModal({ disposal, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    if (!reason.trim()) { setError('A reason is required.'); return; }
    setError(''); setSaving(true);
    try { await api.post(`/asset-disposals/${disposal.id}/void`, { reason: reason.trim() }); onDone(); }
    catch (e) { setError(e.response?.data?.error || 'Void failed.'); setSaving(false); }
  }

  return (
    <Modal title={`Void ${disposal.disposal_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        This removes the disposal from the ledger and brings the asset back into service at the location and
        custodian it had before.
      </p>
      <div className="field">
        <label>Reason *</label>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-warning" disabled={saving} onClick={go}>{saving ? 'Voiding...' : 'Void Disposal'}</button>
      </div>
    </Modal>
  );
}

export default function AssetDisposalView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('summary');
  const [auditLogs, setAuditLogs] = useState([]);
  const [showVoid, setShowVoid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/asset-disposals/${id}`).then(({ data }) => { setD(data); setLoading(false); }); }
  useEffect(() => { load().catch(() => setLoading(false)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/asset-disposals/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function act(fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Action failed.'); }
    finally { setBusy(false); }
  }

  if (loading || !d) return <LoadingSpinner />;
  const isDraft = d.status === 'draft';
  const gain = Number(d.gain_loss);

  // The entry this document produces, laid out as debits and credits.
  const entry = [];
  if (Number(d.accumulated_at_disposal)) entry.push({ account: `${d.accumulated_account_code} — ${d.accumulated_account_name}`, debit: Number(d.accumulated_at_disposal), credit: 0 });
  if (Number(d.proceeds)) entry.push({ account: d.proceeds_account_code ? `${d.proceeds_account_code} — ${d.proceeds_account_name}` : 'Proceeds account not set', debit: Number(d.proceeds), credit: 0 });
  if (Number(d.cost_at_disposal)) entry.push({ account: `${d.cost_account_code} — ${d.cost_account_name}`, debit: 0, credit: Number(d.cost_at_disposal) });
  if (gain) entry.push({ account: `${d.gain_loss_account_code} — ${d.gain_loss_account_name}`, debit: gain < 0 ? -gain : 0, credit: gain > 0 ? gain : 0 });
  const totalDebit = entry.reduce((n, e) => n + e.debit, 0);
  const totalCredit = entry.reduce((n, e) => n + e.credit, 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/asset-disposals')}>Back to Lists</button>
          {isDraft && can('/asset-disposals', 'can_edit') && (
            <button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-disposals/${id}/edit`)}>Edit</button>
          )}
          {isDraft && can('/asset-disposals', 'can_approve') && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={() => act(() => api.post(`/asset-disposals/${id}/post`), 'Post this disposal? The asset leaves the balance sheet and is retired.')}>Post to Ledger</button>
          )}
          {d.status === 'posted' && can('/asset-disposals', 'can_approve') && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setShowVoid(true)}>Void</button>
          )}
          {isDraft && can('/asset-disposals', 'can_delete') && (
            <button className="btn btn-sm btn-warning" disabled={busy}
              onClick={() => act(async () => { await api.delete(`/asset-disposals/${id}`); navigate('/asset-disposals'); }, 'Delete this draft?')}>Delete</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {isDraft && <div className="error-banner">This disposal is a draft — the asset is still on the balance sheet and still depreciating.</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Asset Disposal</h1>
          <span className="estimate-no">{d.disposal_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{DISPOSAL_STATUS_LABELS[d.status] || d.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Asset : <span className="hi">
              <button type="button" className="link-btn" onClick={() => navigate(`/assets/${d.asset_id}`)}>{d.reference_no}</button> — {d.item_name}
            </span></div>
            <div>Class : <span className="hi">{d.class_name || '—'}</span></div>
            <div>Date : <span className="hi">{formatDate(d.disposal_date)}</span></div>
          </div>
          <div>
            <div>Type : <span className="hi">{DISPOSAL_TYPE_LABELS[d.disposal_type] || d.disposal_type}</span></div>
            <div>Buyer : <span className="hi">{d.buyer_name || '—'}</span></div>
            <div>Reason : <span className="hi">{d.reason || '—'}</span></div>
          </div>
          <div>
            <div>Created By : <span className="hi">{d.created_by_name || '—'}</span></div>
            <div>Posted By : <span className="hi">{d.posted_by_name || '—'}</span></div>
            {d.status === 'voided' && <div>Voided : <span className="hi">{d.voided_by_name} — {d.void_reason}</span></div>}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'summary' ? 'active' : ''}`} onClick={() => setTab('summary')}>Summary</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'summary' && (
        <div className="card">
          <div className="table-wrap" style={{ maxWidth: 560 }}>
            <table>
              <tbody>
                <tr><td>Capitalised cost</td><td style={{ textAlign: 'right' }}>{formatMoney(d.cost_at_disposal)}</td></tr>
                <tr><td>Less accumulated depreciation</td><td style={{ textAlign: 'right' }}>({formatMoney(d.accumulated_at_disposal)})</td></tr>
                <tr><th>Net book value</th><th style={{ textAlign: 'right' }}>{formatMoney(d.net_book_value)}</th></tr>
                <tr><td>Proceeds</td><td style={{ textAlign: 'right' }}>{formatMoney(d.proceeds)}</td></tr>
                <tr>
                  <th>{gain < 0 ? 'Loss on disposal' : 'Gain on disposal'}</th>
                  <th style={{ textAlign: 'right' }}>{gain < 0 ? `(${formatMoney(Math.abs(gain))})` : formatMoney(gain)}</th>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            {d.status === 'posted'
              ? 'These figures were frozen when the disposal was posted.'
              : 'These are live figures and will be re-read when the disposal is posted.'}
          </p>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {entry.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing to post.</td></tr>}
                {entry.map((e) => (
                  <tr key={e.account}>
                    <td>{e.account}</td>
                    <td style={{ textAlign: 'right' }}>{e.debit ? formatMoney(e.debit) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{e.credit ? formatMoney(e.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>{formatMoney(totalDebit)}</th>
                  <th style={{ textAlign: 'right' }}>{formatMoney(totalCredit)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => new Date(r.set_at).toLocaleString() },
              { key: 'set_by_name', label: 'Set By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}

      {showVoid && <VoidModal disposal={d} onClose={() => setShowVoid(false)} onDone={() => { setShowVoid(false); load(); }} />}
    </div>
  );
}
