import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { AUDIT_RESULT_LABELS as RESULT_LABELS, AUDIT_STATUS_LABELS } from '../utils/assetLabels';

function formatMonth(v) {
  return v ? new Date(`${String(v).slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
}

// Marking one line. The auditor says what they SAW; the register is not touched by this -- applying
// a finding back onto the register is a separate, permissioned action on the exceptions list below.
function CountModal({ line, meta, onClose, onSaved }) {
  const [form, setForm] = useState({
    result: line.result === 'pending' ? 'verified' : line.result,
    found_location_id: line.found_location_id || line.expected_location_id || '',
    found_custodian_employee_id: line.found_custodian_employee_id || '',
    remarks: line.remarks || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    if (form.result === 'wrong_location' && !form.found_location_id) { setError('Say which location it was actually found in.'); return; }
    setError(''); setSaving(true);
    try { await api.put(`/asset-audits/${line.audit_id}/lines/${line.id}`, form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  return (
    <Modal title={`Count — ${line.reference_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        {line.item_name} · expected at <strong>{line.expected_location_name || 'no location'}</strong>
        {line.expected_custodian_name?.trim() ? <> with <strong>{line.expected_custodian_name}</strong></> : null}
      </p>
      <div className="field">
        <label>Result</label>
        <select value={form.result} onChange={(e) => set({ result: e.target.value })}>
          {Object.entries(RESULT_LABELS).filter(([k]) => k !== 'pending').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {form.result === 'wrong_location' && (
        <>
          <div className="field">
            <label>Found At *</label>
            <select value={form.found_location_id} onChange={(e) => set({ found_location_id: e.target.value })}>
              <option value="">--Select--</option>
              {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Found With</label>
            <select value={form.found_custodian_employee_id} onChange={(e) => set({ found_custodian_employee_id: e.target.value })}>
              <option value="">--None--</option>
              {meta.employees.map((e2) => <option key={e2.id} value={e2.id}>{e2.name}</option>)}
            </select>
          </div>
        </>
      )}
      <div className="field">
        <label>Remarks</label>
        <textarea rows={2} value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

export default function AssetAuditView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [s, setS] = useState(null);
  const [meta, setMeta] = useState(null);
  const [filter, setFilter] = useState('all');
  const [counting, setCounting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/asset-audits/${id}`).then(({ data }) => { setS(data); setLoading(false); }); }
  useEffect(() => { load().catch(() => setLoading(false)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get('/asset-audits/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);

  async function run(fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Action failed.'); }
    finally { setBusy(false); }
  }

  if (loading || !s) return <LoadingSpinner />;

  const summary = s.summary || {};
  const isOpen = s.status === 'open';
  const lines = (s.lines || []).filter((l) => (filter === 'all' ? true : filter === 'exceptions' ? ['wrong_location', 'not_found', 'damaged'].includes(l.result) : l.result === filter));
  const exceptions = (s.lines || []).filter((l) => ['wrong_location', 'not_found', 'damaged'].includes(l.result));

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/asset-audits')}>Back to Lists</button>
          {isOpen && can('/asset-audits', 'can_edit') && summary.pending > 0 && (
            <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put(`/asset-audits/${id}/verify-remaining`), `Mark all ${summary.pending} uncounted asset(s) as verified?`)}>
              Verify Remaining ({summary.pending})
            </button>
          )}
          {isOpen && can('/asset-audits', 'can_approve') && (
            <button className="btn btn-sm btn-primary" disabled={busy || summary.pending > 0} onClick={() => run(() => api.put(`/asset-audits/${id}/complete`), 'Close this audit?')}>Complete Audit</button>
          )}
          {isOpen && can('/asset-audits', 'can_edit') && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => run(() => api.put(`/asset-audits/${id}/cancel`), 'Cancel this audit sheet?')}>Cancel</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Asset Audit</h1>
          <span className="estimate-no">{s.audit_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{AUDIT_STATUS_LABELS[s.status] || s.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Period : <span className="hi">{formatMonth(s.period_month)}</span></div>
            <div>Location : <span className="hi">{s.location_name || 'All locations'}</span></div>
            <div>Custodian : <span className="hi">{s.custodian_name?.trim() || 'All custodians'}</span></div>
          </div>
          <div>
            <div>Generated By : <span className="hi">{s.created_by_name || '—'}</span></div>
            <div>Generated On : <span className="hi">{s.created_at ? new Date(s.created_at).toLocaleString() : '—'}</span></div>
            {s.completed_at && <div>Completed By : <span className="hi">{s.completed_by_name}</span></div>}
          </div>
          <div>
            <div>Memo : <span className="hi">{s.memo || '—'}</span></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
          {[
            ['all', 'Total', summary.total],
            ['pending', 'Not counted', summary.pending],
            ['verified', 'Verified', summary.verified],
            ['wrong_location', 'Wrong location', summary.wrong_location],
            ['exceptions', 'Exceptions', (summary.wrong_location || 0) + (summary.not_found || 0) + (summary.damaged || 0)],
          ].map(([key, label, value]) => (
            <button
              key={key} type="button"
              onClick={() => setFilter(key)}
              style={{
                padding: 12, borderRadius: 8, textAlign: 'left', cursor: 'pointer',
                border: `1px solid ${filter === key ? 'var(--primary, #2563eb)' : 'var(--border, #e2e8f0)'}`,
                background: 'transparent', color: 'inherit',
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{value ?? 0}</div>
            </button>
          ))}
        </div>
      </div>

      {exceptions.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Exceptions ({exceptions.length})</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Findings are recorded against the sheet, not applied to the register. Apply a wrong-location finding only
            once it is confirmed — it writes a correction into the asset&apos;s history.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Reference No</th><th>Asset Type</th><th>Expected</th><th>Found</th><th>Finding</th><th>Remarks</th><th /></tr>
              </thead>
              <tbody>
                {exceptions.map((l) => (
                  <tr key={l.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/assets/${l.asset_id}`)}>{l.reference_no}</button></td>
                    <td>{l.item_name}</td>
                    <td>{l.expected_location_name || '—'}{l.expected_custodian_name?.trim() ? ` · ${l.expected_custodian_name}` : ''}</td>
                    <td>{l.found_location_name || '—'}{l.found_custodian_name?.trim() ? ` · ${l.found_custodian_name}` : ''}</td>
                    <td>{RESULT_LABELS[l.result] || l.result}</td>
                    <td>{l.remarks || '—'}</td>
                    <td>
                      {l.result === 'wrong_location' && l.found_location_id && can('/asset-audits', 'can_approve') && (
                        <button
                          className="btn btn-sm btn-primary" disabled={busy}
                          onClick={() => run(() => api.post(`/asset-audits/${id}/lines/${l.id}/apply-correction`), `Move ${l.reference_no} to ${l.found_location_name} in the register?`)}
                        >
                          Apply
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Count Sheet ({lines.length})</h2>
          {filter !== 'all' && <button className="btn btn-sm" onClick={() => setFilter('all')}>Show all</button>}
        </div>
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead>
              <tr><th>#</th><th>Reference No</th><th>Asset Type</th><th>Serial</th><th>Expected Location</th><th>Expected Custodian</th><th>Now Says</th><th>Result</th><th /></tr>
            </thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing matches this filter.</td></tr>}
              {lines.map((l) => {
                // The register can move under a sheet while the count is running -- a transfer
                // completed mid-month. Flagging that is the difference between "the auditor was
                // wrong" and "the record changed after we asked".
                const drifted = String(l.current_location_id ?? '') !== String(l.expected_location_id ?? '');
                return (
                  <tr key={l.id}>
                    <td data-label="#">{l.line_no}</td>
                    <td data-label="Reference No"><button type="button" className="link-btn" onClick={() => navigate(`/assets/${l.asset_id}`)}>{l.reference_no}</button></td>
                    <td data-label="Asset Type">{l.item_name}</td>
                    <td data-label="Serial">{l.serial_no || '—'}</td>
                    <td data-label="Expected Location">{l.expected_location_name || '—'}</td>
                    <td data-label="Expected Custodian">{l.expected_custodian_name?.trim() || '—'}</td>
                    <td data-label="Now Says">
                      {drifted
                        ? <span title="The register changed after this sheet was generated">{l.current_location_name || 'Unassigned'}</span>
                        : <span className="muted">unchanged</span>}
                    </td>
                    <td data-label="Result">{RESULT_LABELS[l.result] || l.result}</td>
                    <td>
                      {isOpen && can('/asset-audits', 'can_edit') && (
                        <button className="btn btn-sm btn-primary" onClick={() => setCounting({ ...l, audit_id: id })}>
                          {l.result === 'pending' ? 'Count' : 'Edit'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {counting && meta && <CountModal line={counting} meta={meta} onClose={() => setCounting(null)} onSaved={() => { setCounting(null); load(); }} />}
    </div>
  );
}
