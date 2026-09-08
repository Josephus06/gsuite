import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { DEPRECIATION_STATUS_LABELS, formatMoney, formatMonth } from '../utils/assetLabels';

function VoidModal({ run, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    if (!reason.trim()) { setError('A reason is required.'); return; }
    setError(''); setSaving(true);
    try { await api.post(`/asset-depreciation/${run.id}/void`, { reason: reason.trim() }); onDone(); }
    catch (e) { setError(e.response?.data?.error || 'Void failed.'); setSaving(false); }
  }

  return (
    <Modal title={`Void ${run.run_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        Voiding removes this month&apos;s depreciation from the ledger. Nothing has to be unwound — accumulated
        depreciation is summed from posted runs, so it simply stops counting this one.
      </p>
      <div className="field">
        <label>Reason *</label>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-warning" disabled={saving} onClick={go}>{saving ? 'Voiding...' : 'Void Run'}</button>
      </div>
    </Modal>
  );
}

export default function AssetDepreciationView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [run, setRun] = useState(null);
  const [tab, setTab] = useState('lines');
  const [auditLogs, setAuditLogs] = useState([]);
  const [showVoid, setShowVoid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/asset-depreciation/${id}`).then(({ data }) => { setRun(data); setLoading(false); }); }
  useEffect(() => { load().catch(() => setLoading(false)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/asset-depreciation/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function act(fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Action failed.'); }
    finally { setBusy(false); }
  }

  if (loading || !run) return <LoadingSpinner />;
  const lines = run.lines || [];
  const isDraft = run.status === 'draft';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/asset-depreciation')}>Back to Lists</button>
          {isDraft && can('/asset-depreciation', 'can_edit') && (
            <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api.post(`/asset-depreciation/${id}/recalculate`))}>Recalculate</button>
          )}
          {isDraft && can('/asset-depreciation', 'can_approve') && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={() => act(() => api.post(`/asset-depreciation/${id}/post`), `Post ${run.run_no} to the general ledger?`)}>Post to Ledger</button>
          )}
          {run.status === 'posted' && can('/asset-depreciation', 'can_approve') && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setShowVoid(true)}>Void</button>
          )}
          {isDraft && can('/asset-depreciation', 'can_delete') && (
            <button className="btn btn-sm btn-warning" disabled={busy}
              onClick={() => act(async () => { await api.delete(`/asset-depreciation/${id}`); navigate('/asset-depreciation'); }, 'Delete this draft run?')}>Delete</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {isDraft && (
        <div className="error-banner">
          This run is a draft — nothing has reached the ledger yet. Recalculate to pick up assets capitalised since it
          was created, then post it.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Depreciation Run</h1>
          <span className="estimate-no">{run.run_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{DEPRECIATION_STATUS_LABELS[run.status] || run.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Period : <span className="hi">{formatMonth(run.period_month)}</span></div>
            <div>Assets : <span className="hi">{run.asset_count}</span></div>
            <div>Total : <span className="hi">{formatMoney(run.total_amount)}</span></div>
          </div>
          <div>
            <div>Created By : <span className="hi">{run.created_by_name || '—'}</span></div>
            <div>Posted By : <span className="hi">{run.posted_by_name || '—'}</span></div>
            {run.posted_at && <div>Posted : <span className="hi">{new Date(run.posted_at).toLocaleString()}</span></div>}
          </div>
          <div>
            <div>Memo : <span className="hi">{run.memo || '—'}</span></div>
            {run.status === 'voided' && <div>Voided By : <span className="hi">{run.voided_by_name} — {run.void_reason}</span></div>}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'lines' ? 'active' : ''}`} onClick={() => setTab('lines')}>Assets ({lines.length})</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'lines' && (
        <div className="card">
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>#</th><th>Reference No</th><th>Asset</th><th>Class</th>
                  <th style={{ textAlign: 'right' }}>Depreciable Base</th>
                  <th style={{ textAlign: 'right' }}>Opening</th>
                  <th style={{ textAlign: 'right' }}>This Month</th>
                  <th style={{ textAlign: 'right' }}>Closing</th>
                  <th style={{ textAlign: 'right' }}>Months Left</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No lines.</td></tr>}
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td data-label="#">{l.line_no}</td>
                    <td data-label="Reference No"><button type="button" className="link-btn" onClick={() => navigate(`/assets/${l.asset_id}`)}>{l.reference_no}</button></td>
                    <td data-label="Asset">{l.item_name}</td>
                    <td data-label="Class">{l.class_name}</td>
                    <td data-label="Base" style={{ textAlign: 'right' }}>{formatMoney(l.depreciable_base)}</td>
                    <td data-label="Opening" style={{ textAlign: 'right' }}>{formatMoney(l.opening_accumulated)}</td>
                    <td data-label="This Month" style={{ textAlign: 'right' }}><strong>{formatMoney(l.amount)}</strong></td>
                    <td data-label="Closing" style={{ textAlign: 'right' }}>{formatMoney(l.closing_accumulated)}</td>
                    <td data-label="Months Left" style={{ textAlign: 'right' }}>{l.remaining_life_months}</td>
                  </tr>
                ))}
              </tbody>
              {lines.length > 0 && (
                <tfoot>
                  <tr>
                    <th colSpan={6} style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>{formatMoney(run.total_amount)}</th>
                    <th colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            The journal entry this run produces{run.status === 'posted' ? '' : ' once posted'}. Assets sharing a class post
            to the same account pair, so the ledger carries the period total rather than a row per machine.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th><th style={{ textAlign: 'right' }}>Assets</th></tr></thead>
              <tbody>
                {(run.summary || []).map((s) => (
                  <Fragment key={`${s.expense_account_code}|${s.accumulated_account_code}`}>
                    <tr>
                      <td>{s.expense_account_code} — Depreciation Expense</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(s.amount)}</td>
                      <td style={{ textAlign: 'right' }} />
                      <td style={{ textAlign: 'right' }}>{s.asset_count}</td>
                    </tr>
                    <tr>
                      <td style={{ paddingLeft: 28 }}>{s.accumulated_account_code} — Accumulated Depreciation</td>
                      <td style={{ textAlign: 'right' }} />
                      <td style={{ textAlign: 'right' }}>{formatMoney(s.amount)}</td>
                      <td />
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>{formatMoney(run.total_amount)}</th>
                  <th style={{ textAlign: 'right' }}>{formatMoney(run.total_amount)}</th>
                  <th />
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

      {showVoid && <VoidModal run={run} onClose={() => setShowVoid(false)} onDone={() => { setShowVoid(false); load(); }} />}
    </div>
  );
}
