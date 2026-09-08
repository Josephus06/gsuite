import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import {
  ENTRY_TYPE_LABELS, ARCHIVE_STATUS_LABELS, BILLING_CYCLE_LABELS,
  ACCESS_ACTION_LABELS, ACCESS_OUTCOME_LABELS, formatDate, formatDateTime,
} from '../utils/archiverLabels';

// How long a revealed secret stays on screen. Long enough to read or copy, short enough that a
// walked-away desk does not leave a password sitting in a browser tab.
const HIDE_AFTER_SECONDS = 45;

// The reveal: request a code, type it back, get the secret.
//
// The secret lives in this component's state and nowhere else -- never in localStorage, never in
// the URL, never in a parent that outlives the dialog. Closing the dialog drops it, and it clears
// itself after HIDE_AFTER_SECONDS regardless.
function RevealModal({ entry, meta, onClose, onRevealed }) {
  const [stage, setStage] = useState('idle'); // idle -> sent -> shown
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [copied, setCopied] = useState('');
  const timerRef = useRef(null);

  // Clear the secret from memory when this component goes away, whatever the reason.
  useEffect(() => () => { setSecret(null); if (timerRef.current) clearInterval(timerRef.current); }, []);

  useEffect(() => {
    if (stage !== 'shown') return undefined;
    setCountdown(HIDE_AFTER_SECONDS);
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { setSecret(null); setStage('idle'); clearInterval(timerRef.current); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [stage]);

  async function requestCode() {
    setError(''); setBusy(true);
    try { await api.post(`/archiver/credentials/${entry.id}/request-code`); setStage('sent'); }
    catch (e) { setError(e.response?.data?.error || 'Could not send a code.'); }
    finally { setBusy(false); }
  }

  async function submitCode() {
    if (!/^\d{6}$/.test(code.trim())) { setError('Enter the 6-digit code.'); return; }
    setError(''); setBusy(true);
    try {
      const { data } = await api.post(`/archiver/credentials/${entry.id}/reveal`, { code: code.trim() });
      setSecret(data.secret);
      setStage('shown');
      setCode('');
      onRevealed?.();
    } catch (e) {
      const d = e.response?.data;
      setError(d?.error + (d?.attempts_left != null ? ` ${d.attempts_left} attempt(s) left.` : ''));
    } finally { setBusy(false); }
  }

  async function copy(value, what) {
    try { await navigator.clipboard.writeText(value); setCopied(what); setTimeout(() => setCopied(''), 2000); }
    catch { setError('Could not copy — your browser blocked clipboard access. Select the text instead.'); }
  }

  return (
    <Modal title={`Reveal — ${entry.title}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}

      {stage === 'idle' && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Revealing a stored password needs a verification code. We will email one to
            {' '}<strong>{meta?.my_email_hint || 'your registered address'}</strong>. It expires in
            {' '}{meta?.code_ttl_minutes || 5} minutes and works once.
          </p>
          <p className="muted">This reveal will be recorded against your name in the entry&apos;s access log.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={requestCode}>
              {busy ? 'Sending...' : 'Email me a code'}
            </button>
          </div>
        </>
      )}

      {stage === 'sent' && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Code sent to <strong>{meta?.my_email_hint}</strong>. Enter it below.
          </p>
          <div className="field">
            <label>Verification code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && submitCode()}
              inputMode="numeric" autoComplete="one-time-code" autoFocus
              placeholder="000000"
              style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={requestCode}>Resend</button>
            <button type="button" className="btn btn-primary" disabled={busy || code.length !== 6} onClick={submitCode}>
              {busy ? 'Checking...' : 'Reveal'}
            </button>
          </div>
        </>
      )}

      {stage === 'shown' && (
        <>
          <div className="field">
            <label>Username</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={entry.username || ''} style={{ flex: 1, fontFamily: 'monospace' }} />
              {entry.username && <button type="button" className="btn btn-sm" onClick={() => copy(entry.username, 'username')}>Copy</button>}
            </div>
          </div>
          <div className="field">
            <label>Password / Secret</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={secret ?? ''} style={{ flex: 1, fontFamily: 'monospace' }} />
              <button type="button" className="btn btn-sm btn-primary" onClick={() => copy(secret ?? '', 'secret')}>Copy</button>
            </div>
            {secret == null && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>No password is stored on this entry.</div>}
          </div>
          {copied && <p className="muted" style={{ fontSize: 12 }}>Copied {copied} to the clipboard.</p>}
          <p className="muted" style={{ fontSize: 12 }}>
            Hiding automatically in {countdown}s. Clear your clipboard when you are done.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ShareModal({ entry, meta, onClose, onSaved }) {
  const [userId, setUserId] = useState('');
  const [canReveal, setCanReveal] = useState(true);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const already = new Set([String(entry.owner_user_id), ...(entry.shares || []).map((s) => String(s.user_id))]);
  const available = (meta?.users || []).filter((u) => !already.has(String(u.id)));

  async function save() {
    if (!userId) { setError('Choose someone to share with.'); return; }
    setError(''); setSaving(true);
    try { await api.post(`/archiver/credentials/${entry.id}/shares`, { user_id: userId, can_reveal: canReveal, can_edit: canEdit }); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Could not share.'); setSaving(false); }
  }

  return (
    <Modal title={`Share — ${entry.title}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>User *</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">--Select--</option>
          {available.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={canReveal} onChange={(e) => setCanReveal(e.target.checked)} />
          Can reveal the password
        </label>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Unticked, they see the entry and its renewal dates but can never open the secret.
        </div>
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={canEdit} onChange={(e) => setCanEdit(e.target.checked)} />
          Can edit the entry
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Sharing...' : 'Share'}</button>
      </div>
    </Modal>
  );
}

export default function ArchiverEntryView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [entry, setEntry] = useState(null);
  const [meta, setMeta] = useState(null);
  const [logs, setLogs] = useState([]);
  const [tab, setTab] = useState('details');
  const [showReveal, setShowReveal] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.get(`/archiver/credentials/${id}`).then(({ data }) => { setEntry(data); setLoading(false); }), [id]);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);
  useEffect(() => { api.get('/archiver/credentials/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);
  const loadLogs = useCallback(() => api.get(`/archiver/credentials/${id}/access-logs`).then(({ data }) => setLogs(data)), [id]);
  useEffect(() => { if (tab === 'log') loadLogs(); }, [tab, loadLogs]);

  async function removeShare(userId, name) {
    if (!confirm(`Remove ${name}'s access to this entry?`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/archiver/credentials/${id}/shares/${userId}`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not remove access.'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm('Delete this entry? The stored password is destroyed and cannot be recovered.')) return;
    setBusy(true); setError('');
    try { await api.delete(`/archiver/credentials/${id}`); navigate('/archiver/credentials'); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed.'); setBusy(false); }
  }

  if (loading || !entry) return <LoadingSpinner />;
  const mine = entry.my_access || {};

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/archiver/credentials')}>Back to Lists</button>
          {mine.can_edit && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/archiver/credentials/${id}/edit`)}>Edit</button>}
          {mine.can_edit && meta && <button className="btn btn-sm" onClick={() => setShowShare(true)}>Share</button>}
          {entry.has_secret && mine.can_reveal && (
            <button className="btn btn-sm btn-primary" onClick={() => setShowReveal(true)}>Reveal Password</button>
          )}
          {can('/archiver/credentials', 'can_delete') && mine.via !== 'share' && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={remove}>Delete</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {entry.has_secret && !mine.can_reveal && (
        <div className="error-banner">
          You can see this entry but not open its password. Ask {entry.owner_name || 'its owner'} for reveal access.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{entry.title}</h1>
          <span className="estimate-no">{entry.entry_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{ARCHIVE_STATUS_LABELS[entry.status] || entry.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Vendor : <span className="hi">{entry.vendor || '—'}</span></div>
            <div>Type : <span className="hi">{ENTRY_TYPE_LABELS[entry.entry_type] || entry.entry_type}</span></div>
            <div>Category : <span className="hi">{entry.category_name || '—'}</span></div>
          </div>
          <div>
            <div>Username : <span className="hi">{entry.username || '—'}</span></div>
            <div>Password : <span className="hi">{entry.has_secret ? '•••••• (stored)' : 'none stored'}</span></div>
            <div>Reference : <span className="hi">{entry.account_reference || '—'}</span></div>
          </div>
          <div>
            <div>Owner : <span className="hi">{entry.owner_name || '—'}</span></div>
            <div>Renews : <span className="hi">{formatDate(entry.renews_on)}</span></div>
            <div>Expires : <span className="hi">{formatDate(entry.expires_on)}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>Details</button>
        <button className={`status-tab ${tab === 'shares' ? 'active' : ''}`} onClick={() => setTab('shares')}>Access ({(entry.shares || []).length + 1})</button>
        <button className={`status-tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>Access Log</button>
      </div>

      {tab === 'details' && (
        <div className="card">
          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div>
              <div>URL : <span className="hi">
                {entry.url ? <a href={entry.url} target="_blank" rel="noreferrer noopener">{entry.url}</a> : '—'}
              </span></div>
              <div>Cost : <span className="hi">
                {entry.cost == null ? '—' : Number(entry.cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                {entry.billing_cycle ? ` / ${BILLING_CYCLE_LABELS[entry.billing_cycle] || entry.billing_cycle}` : ''}
              </span></div>
              <div>Department : <span className="hi">{entry.department_name || '—'}</span></div>
            </div>
            <div>
              <div>Created : <span className="hi">{entry.created_by_name || '—'}, {formatDateTime(entry.created_at)}</span></div>
              <div>Last edited : <span className="hi">{entry.updated_by_name ? `${entry.updated_by_name}, ${formatDateTime(entry.updated_at)}` : '—'}</span></div>
              <div>Password changed : <span className="hi">{formatDateTime(entry.secret_updated_at)}</span></div>
            </div>
          </div>
          {entry.notes && (
            <>
              <h3 style={{ margin: '18px 0 6px', fontSize: 14, color: '#334155' }}>Notes</h3>
              <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{entry.notes}</p>
            </>
          )}
        </div>
      )}

      {tab === 'shares' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Access</th><th>Can reveal</th><th>Can edit</th><th>Granted by</th><th /></tr></thead>
              <tbody>
                <tr>
                  <td><strong>{entry.owner_name || '—'}</strong></td>
                  <td>Owner</td><td>Yes</td><td>Yes</td><td>—</td><td />
                </tr>
                {(entry.shares || []).map((s) => (
                  <tr key={s.user_id}>
                    <td>{s.display_name}</td>
                    <td>Shared</td>
                    <td>{s.can_reveal ? 'Yes' : <span className="muted">No</span>}</td>
                    <td>{s.can_edit ? 'Yes' : <span className="muted">No</span>}</td>
                    <td>{s.granted_by_name || '—'}</td>
                    <td>
                      {mine.can_edit && (
                        <button className="btn btn-sm btn-warning" disabled={busy}
                          onClick={() => removeShare(s.user_id, s.display_name)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            Only these people can see this entry at all. System Admins can see every entry.
          </p>
        </div>
      )}

      {tab === 'log' && (
        <div className="card">
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Outcome</th><th>Detail</th></tr></thead>
              <tbody>
                {logs.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No activity yet.</td></tr>}
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td data-label="When">{formatDateTime(l.created_at)}</td>
                    <td data-label="Who">{l.user_name || '—'}</td>
                    <td data-label="Action">{ACCESS_ACTION_LABELS[l.action] || l.action}</td>
                    <td data-label="Outcome" style={{ color: l.outcome !== 'success' ? '#b91c1c' : undefined }}>
                      {ACCESS_OUTCOME_LABELS[l.outcome] || l.outcome}
                    </td>
                    <td data-label="Detail">{l.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showReveal && (
        <RevealModal entry={entry} meta={meta} onClose={() => setShowReveal(false)}
          onRevealed={() => { if (tab === 'log') loadLogs(); }} />
      )}
      {showShare && meta && <ShareModal entry={entry} meta={meta} onClose={() => setShowShare(false)} onSaved={() => { setShowShare(false); load(); }} />}
    </div>
  );
}
