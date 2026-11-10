import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';

// HRD > Regularization and HRD > Salary Adjustment (2026-11-07). HR's letters to one employee on the
// company's own templates, issued from the employee record and approved by a General Manager like the
// COE and the Memo. One page for both, by `kind`; each is its own page in User Permissions.

export const LETTERS = {
  regularization: {
    title: 'Regularization', route: '/hrd/regularization', api: '/hr-regularization', noun: 'Regularization Letter',
    effectiveLabel: 'Regularized effective *',
  },
  salary_adjustment: {
    title: 'Salary Adjustment', route: '/hrd/salary-adjustment', api: '/hr-salary-adjustment', noun: 'Salary Adjustment Letter',
    effectiveLabel: 'New rate effective *',
  },
};

const STATUS = {
  for_approval: { label: 'For Approval', badge: 'badge-warning' },
  approved: { label: 'Approved', badge: 'badge-success' },
  rejected: { label: 'Rejected', badge: 'badge-danger' },
};
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const fmtDate = (v) => (v ? displayDate(String(v).slice(0, 10)) : '');
const money = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const BASIS = { monthly: 'Monthly', daily: 'Daily' };

// "Mr. Cruz" / "Ms. Cruz" from the record's sex; "Mr./Ms. Cruz" when it does not say.
function salutationFor(e) {
  const s = String(e.sex || '').trim().toLowerCase();
  const title = s.startsWith('m') ? 'Mr.' : s.startsWith('f') ? 'Ms.' : 'Mr./Ms.';
  return `${title} ${e.last_name || ''}`.trim();
}

function blankForm(approvers, preparer) {
  return {
    employee_id: null, employee_name: '', employee_address: '', salutation: '',
    letter_date: today(), effective_date: '',
    current_rate: '', current_basis: 'monthly', new_rate: '', new_basis: 'monthly',
    prepared_by_name: preparer.name || '', prepared_by_title: preparer.title || '',
    approver_user_id: approvers[0]?.id || '', remarks: '',
  };
}

function LetterModal({ kind, approvers, preparer, existing, onClose, onSaved }) {
  const L = LETTERS[kind];
  const [form, setForm] = useState(() => {
    const base = blankForm(approvers, preparer);
    if (!existing) return base;
    const out = { ...base };
    for (const k of Object.keys(base)) {
      if (existing[k] != null) out[k] = /date/.test(k) ? String(existing[k]).slice(0, 10) : existing[k];
    }
    return out;
  });
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const chosen = !!form.employee_name;
  const reg = kind === 'regularization';

  useEffect(() => {
    if (chosen) return undefined;
    const t = setTimeout(() => {
      setSearching(true);
      api.get(`${L.api}/employees`, { params: { search: search || undefined } })
        .then(({ data }) => setMatches(data))
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search, chosen, L.api]);

  // The letter's name, address and salutation come from the employee record; HR can still change any
  // of it before saving.
  function pickEmployee(e) {
    const mi = e.middle_initial ? ` ${String(e.middle_initial).replace(/\.?$/, '.')}` : '';
    const name = [e.first_name, mi.trim(), e.last_name].filter(Boolean).join(' ').toUpperCase();
    set({
      employee_id: e.id,
      employee_name: name,
      employee_address: e.address || '',
      salutation: salutationFor(e),
      effective_date: form.effective_date || (reg && e.date_regularized ? String(e.date_regularized).slice(0, 10) : ''),
    });
  }

  async function save() {
    setError(''); setSaving(true);
    try {
      const { data } = existing ? await api.put(`${L.api}/${existing.id}`, form) : await api.post(L.api, form);
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the letter.');
      setSaving(false);
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.letter_no}` : `New ${L.noun}`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}

      <div className="field">
        <label>Employee *</label>
        {chosen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>{form.employee_name}</strong>
            <button type="button" className="btn btn-sm" onClick={() => { set({ employee_id: null, employee_name: '' }); setMatches([]); }}>Change</button>
          </div>
        ) : (
          <>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a name, employee code, department or position" />
            <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6 }}>
              <table>
                <tbody>
                  {searching && <tr><td className="muted" style={{ padding: 10 }}>Searching...</td></tr>}
                  {!searching && matches.length === 0 && <tr><td className="muted" style={{ padding: 10 }}>No employee matches that.</td></tr>}
                  {!searching && matches.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <button type="button" className="link-btn" onClick={() => pickEmployee(m)}>{m.employee_name}</button>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {m.employee_code || '—'} · {m.department_name || 'No department'}
                          {m.position_title ? ` · ${m.position_title}` : ''}
                          {m.employment_status ? ` · ${m.employment_status}` : ''}
                          {m.date_hired ? ` · hired ${fmtDate(m.date_hired)}` : ''}
                          {!m.is_active && <span style={{ color: '#b45309' }}> · separated</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {chosen && (
        <>
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div className="field">
              <label>Name as printed *</label>
              <input value={form.employee_name} maxLength={200} onChange={(e) => set({ employee_name: e.target.value })} />
            </div>
            {reg && (
              <div className="field">
                <label>Dear (salutation)</label>
                <input value={form.salutation} maxLength={120} placeholder="e.g. Mr. Cruz" onChange={(e) => set({ salutation: e.target.value })} />
              </div>
            )}
            {reg && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Address</label>
                <input value={form.employee_address} maxLength={300} onChange={(e) => set({ employee_address: e.target.value })} />
              </div>
            )}
            <div className="field">
              <label>Date of the letter *</label>
              <input type="date" value={form.letter_date} onChange={(e) => set({ letter_date: e.target.value })} />
            </div>
            <div className="field">
              <label>{L.effectiveLabel}</label>
              <input type="date" value={form.effective_date} onChange={(e) => set({ effective_date: e.target.value })} />
            </div>
          </div>

          {!reg && (
            <>
              <h3 style={{ margin: '12px 0 6px', fontSize: 14 }}>Basic salary</h3>
              <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                {[['current', 'Current rate'], ['new', 'New salary rate *']].map(([p, label]) => (
                  <div className="field" key={p}>
                    <label>{label}</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input type="number" min="0" step="0.01" style={{ flex: 1 }} value={form[`${p}_rate`]}
                        placeholder="Php" onChange={(e) => set({ [`${p}_rate`]: e.target.value })} />
                      <select style={{ width: 110 }} value={form[`${p}_basis`]} onChange={(e) => set({ [`${p}_basis`]: e.target.value })}>
                        {Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div className="field">
              <label>{reg ? 'Sincerely yours' : 'Yours truly'} (name as printed)</label>
              <input value={form.prepared_by_name} maxLength={150} onChange={(e) => set({ prepared_by_name: e.target.value })} />
            </div>
            <div className="field">
              <label>Position</label>
              <input value={form.prepared_by_title} maxLength={150} placeholder="e.g. Human Resources Assistant" onChange={(e) => set({ prepared_by_title: e.target.value })} />
            </div>
          </div>

          {/* The General Manager who approves -- and whose name the letter is signed in. */}
          <div className="field">
            <label>Approver (General Manager) *</label>
            <select value={form.approver_user_id} onChange={(e) => set({ approver_user_id: e.target.value })}>
              {approvers.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {existing?.status === 'approved'
                ? 'Saving changes sends it back to the approver; it prints unsigned until approved again.'
                : 'The letter is signed in the name of the General Manager who approves it.'}
            </div>
          </div>
          <div className="field">
            <label>Internal remarks (not printed)</label>
            <input value={form.remarks || ''} maxLength={500} onChange={(e) => set({ remarks: e.target.value })} />
          </div>
        </>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !chosen} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

// The approver's decision. Approving confirms the name printed above "General Manager".
function DecisionModal({ kind, letter, approve, signAs, onClose, onDone }) {
  const L = LETTERS[kind];
  const [name, setName] = useState(signAs || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true); setError('');
    try {
      const { data } = approve
        ? await api.put(`${L.api}/${letter.id}/approve`, { signatory_name: name })
        : await api.put(`${L.api}/${letter.id}/reject`, { reason });
      onDone(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save your decision.');
      setBusy(false);
    }
  }

  return (
    <Modal title={`${approve ? 'Approve' : 'Reject'} ${letter.letter_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p style={{ marginTop: 0 }}>
        {L.noun} for <strong>{letter.employee_name}</strong>.{' '}
        <a href={`${L.route}/${letter.id}/print`} target="_blank" rel="noreferrer">Preview</a>
      </p>
      {approve ? (
        <div className="field">
          <label>General Manager&rsquo;s name as printed on the letter *</label>
          <input autoFocus value={name} maxLength={150} onChange={(e) => setName(e.target.value)} placeholder="e.g. JIMMY W. WU" />
        </div>
      ) : (
        <div className="field">
          <label>Reason *</label>
          <textarea autoFocus rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${approve ? 'btn-primary' : 'btn-danger'}`} disabled={busy || (approve ? !name.trim() : !reason.trim())} onClick={submit}>
          {busy ? 'Saving...' : approve ? 'Approve' : 'Reject'}
        </button>
      </div>
    </Modal>
  );
}

export default function HrPersonnelLetters({ kind }) {
  const L = LETTERS[kind];
  const { can, user } = useAuth();
  const [rows, setRows] = useState([]);
  const [approvers, setApprovers] = useState([]);
  const [preparer, setPreparer] = useState({});
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null = closed, {} = new, row = edit
  const [deciding, setDeciding] = useState(null); // { letter, approve }
  const [viewing, setViewing] = useState(null); // the letter shown as it will print (View)

  const canAdd = can(L.route, 'can_add');
  const canEdit = can(L.route, 'can_edit');
  const canDelete = can(L.route, 'can_delete');
  const canPrint = can(L.route, 'can_print');
  const isAdmin = user?.account_type === 'System Admin';
  const canDecide = (r) => r.status === 'for_approval' && (isAdmin || Number(r.approver_user_id) === Number(user?.id));
  const signAsFor = (r) => approvers.find((a) => Number(a.id) === Number(r.approver_user_id))?.sign_as || '';

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get(L.api, { params: { status: status || undefined, search: search || undefined } });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the letters.'); }
    setLoading(false);
  }, [L.api, status, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get(`${L.api}/meta`)
      .then(({ data }) => { setApprovers(data.approvers || []); setPreparer(data.preparer || {}); setMetaLoaded(true); })
      .catch(() => setMetaLoaded(true));
  }, [L.api]);

  async function remove(r) {
    if (!confirm(`Delete ${r.letter_no} (${r.employee_name})?`)) return;
    try { await api.delete(`${L.api}/${r.id}`); await load(); } catch (e) { setError(e.response?.data?.error || 'Could not delete that letter.'); }
  }

  const reg = kind === 'regularization';

  return (
    <div>
      <div className="page-header">
        <h1>{L.title}</h1>
        {canAdd && metaLoaded && <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>New Letter</button>}
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input style={{ flex: '1 1 240px' }} placeholder={`Search ${reg ? 'REG' : 'SAL'} #, employee or employee code`} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={{ flex: '0 0 180px', width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every status</option>
          {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Letter #</th><th>Employee</th><th>Date</th><th>Effective</th>
                {!reg && <><th style={{ textAlign: 'right' }}>Current Rate</th><th style={{ textAlign: 'right' }}>New Rate</th></>}
                <th>By</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={reg ? 7 : 9} className="muted" style={{ padding: 16, textAlign: 'center' }}>No letters yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.letter_no}</td>
                  <td>{r.employee_name}{r.employee_code ? <div className="muted" style={{ fontSize: 11 }}>{r.employee_code}</div> : null}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.letter_date)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.effective_date)}</td>
                  {!reg && (
                    <>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{r.current_rate != null ? `${money(r.current_rate)} / ${BASIS[r.current_basis] || ''}` : '—'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(r.new_rate)} / {BASIS[r.new_basis] || ''}</td>
                    </>
                  )}
                  <td>{r.created_by_name}</td>
                  <td>
                    <span className={`badge ${STATUS[r.status]?.badge || 'badge-muted'}`}>{STATUS[r.status]?.label || r.status}</span>
                    <div className="muted" style={{ fontSize: 11 }}>{r.status === 'approved' ? r.signatory_name : r.approver_name}</div>
                    {r.status === 'rejected' && r.rejected_reason && <div style={{ fontSize: 11, color: '#b91c1c' }}>{r.rejected_reason}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {/* View: the letter as it will print, to review before approving (asked 2026-11-10). */}
                    <button type="button" className="btn btn-sm" onClick={() => setViewing(r)}>View</button>{' '}
                    {canDecide(r) && (
                      <>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDeciding({ letter: r, approve: true })}>Approve</button>{' '}
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeciding({ letter: r, approve: false })}>Reject</button>{' '}
                      </>
                    )}
                    {canPrint && <button type="button" className="btn btn-sm" onClick={() => window.open(`${L.route}/${r.id}/print`, '_blank')}>Print</button>}{' '}
                    {canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>}{' '}
                    {canDelete && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(r)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <LetterModal kind={kind} approvers={approvers} preparer={preparer} existing={editing.id ? editing : null}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {viewing && (
        <Modal title={`${viewing.letter_no} · ${viewing.employee_name}`} onClose={() => setViewing(null)} xl>
          <iframe title="Letter" src={`${L.route}/${viewing.id}/print?view=1`}
            style={{ width: '100%', height: '75vh', border: '1px solid var(--border)', borderRadius: 6, background: '#f1f5f9' }} />
          {canDecide(viewing) && (
            <div className="modal-actions">
              <button type="button" className="btn btn-danger" onClick={() => { setDeciding({ letter: viewing, approve: false }); setViewing(null); }}>Reject</button>
              <button type="button" className="btn btn-primary" onClick={() => { setDeciding({ letter: viewing, approve: true }); setViewing(null); }}>Approve</button>
            </div>
          )}
        </Modal>
      )}
      {deciding && (
        <DecisionModal kind={kind} letter={deciding.letter} approve={deciding.approve} signAs={signAsFor(deciding.letter)}
          onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); load(); }} />
      )}
    </div>
  );
}
