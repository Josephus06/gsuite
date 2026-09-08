import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { CONDITION_LABELS, MOVEMENT_LABELS, STATUS_LABELS } from '../utils/assetLabels';

function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }
function formatDateTime(v) { return v ? new Date(v).toLocaleString() : ''; }

// Correcting the register: the asset is not where the system says, and this is an error being
// fixed rather than equipment changing hands. Kept deliberately separate from a transfer -- it
// takes a reason, it is gated on approval rights, and it lands in the ledger labelled as a
// correction so it can never be mistaken for a signed-off move.
function RelocateModal({ asset, meta, onClose, onSaved }) {
  const [form, setForm] = useState({ location_id: asset.effective_location_id || '', custodian_employee_id: asset.effective_custodian_employee_id || '', reason: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!form.location_id) { setError('A location is required.'); return; }
    if (!form.reason.trim()) { setError('A reason is required for a correction.'); return; }
    setError(''); setSaving(true);
    try { await api.put(`/assets/${asset.id}/relocate`, form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Correction failed.'); setSaving(false); }
  }

  return (
    <Modal title={`Correct location — ${asset.reference_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        Use this only to fix a record that is wrong. To move equipment between people, raise an asset transfer so
        both custodians sign for it.
      </p>
      <div className="field">
        <label>Location *</label>
        <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
          <option value="">--Select--</option>
          {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Custodian</label>
        <select value={form.custodian_employee_id} onChange={(e) => setForm({ ...form, custodian_employee_id: e.target.value })}>
          <option value="">--None--</option>
          {meta.employees.map((e2) => <option key={e2.id} value={e2.id}>{e2.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Reason *</label>
        <textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Why the register was wrong" />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Apply Correction'}</button>
      </div>
    </Modal>
  );
}

function StatusModal({ asset, onClose, onSaved }) {
  const [status, setStatus] = useState(asset.status);
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setError(''); setSaving(true);
    try { await api.put(`/assets/${asset.id}/status`, { status, remarks }); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Update failed.'); setSaving(false); }
  }

  return (
    <Modal title={`Change status — ${asset.reference_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Remarks</label>
        <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

export default function AssetView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [a, setA] = useState(null);
  const [meta, setMeta] = useState(null);
  const [tab, setTab] = useState('details');
  const [auditLogs, setAuditLogs] = useState([]);
  const [showRelocate, setShowRelocate] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function load() { return api.get(`/assets/${id}`).then(({ data }) => { setA(data); setLoading(false); }); }
  useEffect(() => { load().catch(() => setLoading(false)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get('/assets/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'system') api.get(`/assets/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function remove() {
    if (!confirm('Delete this asset? Retire or dispose it instead if it ever existed.')) return;
    setError('');
    try { await api.delete(`/assets/${id}`); navigate('/assets'); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed.'); }
  }

  if (loading || !a) return <LoadingSpinner />;

  const movements = a.movements || [];
  const attached = a.attached_assets || [];
  const openTransfers = a.open_transfers || [];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/assets')}>Back to Lists</button>
          {can('/assets', 'can_edit') && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/assets/${id}/edit`)}>Edit</button>}
          {can('/assets', 'can_edit') && <button className="btn btn-sm" onClick={() => setShowStatus(true)}>Change Status</button>}
          {can('/assets', 'can_approve') && !a.parent_asset_id && <button className="btn btn-sm" onClick={() => setShowRelocate(true)}>Correct Location</button>}
          {can('/asset-transfers', 'can_add') && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-transfers/new?asset_id=${a.id}`)}>Transfer</button>}
          {can('/assets', 'can_delete') && <button className="btn btn-sm btn-warning" onClick={remove}>Delete</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {openTransfers.length > 0 && (
        <div className="error-banner">
          This asset is on transfer{' '}
          {openTransfers.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ', '}
              <button type="button" className="link-btn" onClick={() => navigate(`/asset-transfers/${t.id}`)}>{t.transfer_no}</button>
              {' '}({t.status.replace('_', ' ')})
            </span>
          ))}
          , which has not finished yet.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{a.item_name}</h1>
          <span className="estimate-no">{a.reference_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{STATUS_LABELS[a.status] || a.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Location : <span className="hi">{a.location_name || 'Unassigned'}</span></div>
            <div>Custodian : <span className="hi">{a.custodian_name?.trim() || '—'}</span></div>
            <div>Department : <span className="hi">{a.department_name || '—'}</span></div>
          </div>
          <div>
            <div>Serial No : <span className="hi">{a.serial_no || '—'}</span></div>
            <div>Tag No : <span className="hi">{a.tag_no || '—'}</span></div>
            <div>Condition : <span className="hi">{CONDITION_LABELS[a.asset_condition] || a.asset_condition}</span></div>
          </div>
          <div>
            <div>Category : <span className="hi">{a.category || '—'}</span></div>
            <div>Brand / Model : <span className="hi">{[a.brand, a.model].filter(Boolean).join(' ') || '—'}</span></div>
            <div>Acquired : <span className="hi">{formatDate(a.acquired_date) || '—'}</span></div>
          </div>
        </div>
      </div>

      {a.is_attached && (
        <div className="card" style={{ marginTop: 16 }}>
          <strong>Attached to {a.parent_item_name} · {a.parent_reference_no}</strong>
          <div className="muted" style={{ marginTop: 4 }}>
            This unit is reported wherever its host is. The custody chain reads:{' '}
            {(a.custody_chain || []).map((c, i) => (
              <span key={c.id}>
                {i > 0 && ' → '}
                <button type="button" className="link-btn" onClick={() => navigate(`/assets/${c.id}`)}>{c.item_name} {c.reference_no}</button>
              </span>
            ))}
            {a.location_name ? ` → ${a.location_name}` : ''}
          </div>
        </div>
      )}

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>Details</button>
        <button className={`status-tab ${tab === 'attached' ? 'active' : ''}`} onClick={() => setTab('attached')}>Attached Assets ({attached.length})</button>
        <button className={`status-tab ${tab === 'movements' ? 'active' : ''}`} onClick={() => setTab('movements')}>Movement History ({movements.length})</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'details' && (
        <div className="card">
          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div>
              <div>Asset Type : <span className="hi">{a.item_code} — {a.item_name}</span></div>
              <div>Specification : <span className="hi">{a.specification || '—'}</span></div>
              <div>Acquisition Cost : <span className="hi">{a.acquisition_cost == null ? '—' : Number(a.acquisition_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></div>
            </div>
            <div>
              <div>Registered By : <span className="hi">{a.created_by_name || '—'}</span></div>
              <div>Registered On : <span className="hi">{formatDateTime(a.created_at)}</span></div>
              <div>Remarks : <span className="hi">{a.remarks || '—'}</span></div>
            </div>
          </div>
        </div>
      )}

      {tab === 'attached' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Reference No</th><th>Asset Type</th><th>Serial</th><th>Status</th></tr></thead>
              <tbody>
                {attached.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing is attached to this asset.</td></tr>}
                {attached.map((c) => (
                  <tr key={c.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/assets/${c.id}`)}>{c.reference_no}</button></td>
                    <td>{c.item_name}</td>
                    <td>{c.serial_no || '—'}</td>
                    <td>{STATUS_LABELS[c.status] || c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {attached.length > 0 && (
            <p className="muted" style={{ marginTop: 12 }}>
              These move with this asset. Transferring this one carries them along, and each gets its own history entry.
            </p>
          )}
        </div>
      )}

      {tab === 'movements' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Type</th><th>From</th><th>To</th><th>Document</th><th>By</th><th>Remarks</th></tr>
              </thead>
              <tbody>
                {movements.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No movement history.</td></tr>}
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td>{formatDateTime(m.moved_at)}</td>
                    <td>{MOVEMENT_LABELS[m.movement_type] || m.movement_type}</td>
                    <td>{m.from_location_name || '—'}{m.from_custodian_name?.trim() ? ` · ${m.from_custodian_name}` : ''}</td>
                    <td>{m.to_location_name || '—'}{m.to_custodian_name?.trim() ? ` · ${m.to_custodian_name}` : ''}</td>
                    <td>
                      {m.transfer_no
                        ? <button type="button" className="link-btn" onClick={() => navigate(`/asset-transfers/${m.transfer_id}`)}>{m.transfer_no}</button>
                        : '—'}
                    </td>
                    <td>{m.moved_by_name || '—'}</td>
                    <td>{m.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
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

      {showRelocate && meta && <RelocateModal asset={a} meta={meta} onClose={() => setShowRelocate(false)} onSaved={() => { setShowRelocate(false); load(); }} />}
      {showStatus && <StatusModal asset={a} onClose={() => setShowStatus(false)} onSaved={() => { setShowStatus(false); load(); }} />}
    </div>
  );
}
