import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { TRANSFER_STATUS_LABELS } from '../utils/assetLabels';

function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }
function formatDateTime(v) { return v ? new Date(v).toLocaleString() : ''; }

function ActionModal({ title, label, requireText, confirmLabel, danger, onClose, onConfirm }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    if (requireText && !text.trim()) { setError(`${label} is required.`); return; }
    setError(''); setSaving(true);
    try { await onConfirm(text.trim()); }
    catch (e) { setError(e.response?.data?.error || 'Action failed.'); setSaving(false); }
  }

  return (
    <Modal title={title} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>{label}{requireText ? ' *' : ''}</label>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-warning' : 'btn-primary'}`} disabled={saving} onClick={go}>
          {saving ? 'Working...' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// The approval trail, drawn as three steps so anyone opening the document can see at a glance where
// it is stuck and who it is stuck on -- which is the question the whole module exists to answer.
function ApprovalTrail({ t }) {
  const steps = [
    {
      title: 'Released by',
      who: t.from_custodian_name?.trim() || 'Any approver',
      done: !!t.released_at,
      by: t.released_by_name,
      at: t.released_at,
      remarks: t.release_remarks,
      pending: t.status === 'pending_release',
    },
    {
      title: 'Received by',
      who: t.to_custodian_name?.trim() || 'Any approver',
      done: !!t.received_at,
      by: t.received_by_name,
      at: t.received_at,
      remarks: t.receipt_remarks,
      pending: t.status === 'pending_receipt',
    },
    {
      title: 'Completed by',
      who: 'IT',
      done: !!t.completed_at,
      by: t.completed_by_name,
      at: t.completed_at,
      pending: t.status === 'approved',
    },
  ];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Approvals</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        {steps.map((s) => (
          <div key={s.title} style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border, #e2e8f0)', opacity: s.done || s.pending ? 1 : 0.6 }}>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, opacity: 0.7 }}>{s.title}</div>
            <div style={{ fontWeight: 600, marginTop: 4 }}>{s.done ? (s.by || '—') : s.who}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {s.done ? formatDateTime(s.at) : s.pending ? 'Waiting' : 'Not yet'}
            </div>
            {s.remarks && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{s.remarks}</div>}
          </div>
        ))}
      </div>
      {t.status === 'rejected' && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          Rejected by {t.rejected_by_name || 'a custodian'} on {formatDateTime(t.rejected_at)} — {t.reject_reason}
        </div>
      )}
    </div>
  );
}

export default function AssetTransferView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [t, setT] = useState(null);
  const [tab, setTab] = useState('assets');
  const [auditLogs, setAuditLogs] = useState([]);
  const [action, setAction] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/asset-transfers/${id}`).then(({ data }) => { setT(data); setLoading(false); }); }
  useEffect(() => { load().catch(() => setLoading(false)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/asset-transfers/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function run(fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Action failed.'); }
    finally { setBusy(false); }
  }

  if (loading || !t) return <LoadingSpinner />;

  const lines = t.lines || [];
  const acts = t.my_actions || {};
  const carried = lines.reduce((n, l) => n + Number(l.attached_count || 0), 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/asset-transfers')}>Back to Lists</button>
          {t.status === 'draft' && can('/asset-transfers', 'can_edit') && (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-transfers/${id}/edit`)}>Edit</button>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`/asset-transfers/${id}/submit`))}>Submit for Approval</button>
            </>
          )}
          {acts.can_release && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setAction('release')}>Approve Release</button>}
          {acts.can_receive && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setAction('receive')}>Approve Receipt</button>}
          {(acts.can_release || acts.can_receive) && <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setAction('reject')}>Reject</button>}
          {t.status === 'approved' && can('/asset-transfers', 'can_approve') && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`/asset-transfers/${id}/complete`), 'Complete this transfer and move the assets?')}>Complete Transfer</button>
          )}
          {!['completed', 'cancelled', 'rejected'].includes(t.status) && can('/asset-transfers', 'can_edit') && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => run(() => api.put(`/asset-transfers/${id}/cancel`), 'Cancel this transfer?')}>Cancel</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {t.status === 'approved' && (
        <div className="error-banner">
          Both custodians have approved. The assets still show at their old location until IT completes this transfer.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Asset Transfer</h1>
          <span className="estimate-no">{t.transfer_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{TRANSFER_STATUS_LABELS[t.status] || t.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Date : <span className="hi">{formatDate(t.date_created)}</span></div>
            <div>Date Needed : <span className="hi">{formatDate(t.date_needed) || '—'}</span></div>
            <div>Requested By : <span className="hi">{t.requested_by_name || '—'}</span></div>
          </div>
          <div>
            <div>From : <span className="hi">{t.from_location_name || 'Any location'}</span></div>
            <div>Releasing Custodian : <span className="hi">{t.from_custodian_name?.trim() || '—'}</span></div>
            <div>Reason : <span className="hi">{t.reason || '—'}</span></div>
          </div>
          <div>
            <div>To : <span className="hi">{t.to_location_name}</span></div>
            <div>Receiving Custodian : <span className="hi">{t.to_custodian_name?.trim() || '—'}</span></div>
            <div>Department : <span className="hi">{t.to_department_name || '—'}</span></div>
          </div>
        </div>
      </div>

      <ApprovalTrail t={t} />

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'assets' ? 'active' : ''}`} onClick={() => setTab('assets')}>Assets ({lines.length})</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'assets' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>Reference No</th><th>Asset Type</th><th>Serial</th><th>Was At</th><th>Was Held By</th><th>Remarks</th></tr>
              </thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No assets on this transfer.</td></tr>}
                {lines.map((l, i) => (
                  <tr key={l.id}>
                    <td>{i + 1}</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/assets/${l.asset_id}`)}>{l.reference_no}</button></td>
                    <td>{l.item_name}{Number(l.attached_count) > 0 ? <span className="muted"> (+{l.attached_count} attached)</span> : null}</td>
                    <td>{l.serial_no || '—'}</td>
                    <td>{l.from_location_name || '—'}</td>
                    <td>{l.from_custodian_name?.trim() || '—'}</td>
                    <td>{l.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            &quot;Was At&quot; is where each asset stood when this transfer was raised — the state both custodians are signing against.
            {carried > 0 && ` ${carried} attached asset${carried === 1 ? '' : 's'} move along with these.`}
          </p>
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

      {action === 'release' && (
        <ActionModal
          title={`Approve release — ${t.transfer_no}`} label="Remarks" confirmLabel="Approve Release"
          onClose={() => setAction(null)}
          onConfirm={async (text) => { await api.post(`/asset-transfers/${id}/release-approve`, { remarks: text }); setAction(null); await load(); }}
        />
      )}
      {action === 'receive' && (
        <ActionModal
          title={`Approve receipt — ${t.transfer_no}`} label="Remarks" confirmLabel="Approve Receipt"
          onClose={() => setAction(null)}
          onConfirm={async (text) => { await api.post(`/asset-transfers/${id}/receipt-approve`, { remarks: text }); setAction(null); await load(); }}
        />
      )}
      {action === 'reject' && (
        <ActionModal
          title={`Reject — ${t.transfer_no}`} label="Reason" requireText danger confirmLabel="Reject Transfer"
          onClose={() => setAction(null)}
          onConfirm={async (text) => { await api.post(`/asset-transfers/${id}/reject`, { reason: text }); setAction(null); await load(); }}
        />
      )}
    </div>
  );
}
