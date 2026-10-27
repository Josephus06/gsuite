import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';

// HRD > Memo (2026-10-27). HR's memos to employees on the company's memo template: TO / FROM / DATE /
// SUBJECT, a heading, the body (paragraphs and tables, e.g. the month's holidays), Prepared by HR and
// Approved by the General Manager. Approval and the e-signature work as on the COE.

const today = () => new Date().toISOString().slice(0, 10);
function fmtDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

const STATUS = {
  for_approval: { label: 'For Approval', badge: 'badge-warning' },
  approved: { label: 'Approved', badge: 'badge-success' },
  rejected: { label: 'Rejected', badge: 'badge-danger' },
};

const textBlock = (text = '', bold = false) => ({ type: 'text', text, bold });
// The template's holiday table, as a starting point HR overwrites.
const tableBlock = () => ({ type: 'table', columns: ['Date', 'Type of Holiday', 'Event'], rows: [['', '', '']] });

function blankForm(approvers = [], preparer = {}) {
  return {
    memo_to: 'ALL EMPLOYEES',
    memo_from: 'HR DEPARTMENT',
    memo_date: today(),
    subject: '',
    heading: 'ANNOUNCEMENT:',
    body: [textBlock(), textBlock('Please be guided accordingly.'), textBlock('Thank you!')],
    prepared_by_name: preparer.name || '',
    prepared_by_title: preparer.title || '',
    approver_user_id: approvers[0]?.id || '',
    remarks: '',
  };
}

function TableEditor({ block, onChange }) {
  const setCol = (i, v) => onChange({ ...block, columns: block.columns.map((c, j) => (j === i ? v : c)) });
  const setCell = (r, i, v) => onChange({ ...block, rows: block.rows.map((row, k) => (k === r ? row.map((c, j) => (j === i ? v : c)) : row)) });
  const addCol = () => onChange({ columns: [...block.columns, ''], rows: block.rows.map((r) => [...r, '']), type: 'table' });
  const removeCol = (i) => onChange({ ...block, columns: block.columns.filter((_, j) => j !== i), rows: block.rows.map((r) => r.filter((_, j) => j !== i)) });
  const addRow = () => onChange({ ...block, rows: [...block.rows, block.columns.map(() => '')] });
  const removeRow = (r) => onChange({ ...block, rows: block.rows.filter((_, k) => k !== r) });
  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {block.columns.map((c, i) => (
                <th key={i} style={{ padding: 4 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input value={c} maxLength={300} placeholder="Column" onChange={(e) => setCol(i, e.target.value)} style={{ fontWeight: 700 }} />
                    {block.columns.length > 1 && (
                      <button type="button" className="btn btn-sm" title="Remove column" onClick={() => removeCol(i)}>×</button>
                    )}
                  </div>
                </th>
              ))}
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((c, i) => (
                  <td key={i} style={{ padding: 4 }}>
                    <input value={c} maxLength={300} onChange={(e) => setCell(r, i, e.target.value)} />
                  </td>
                ))}
                <td style={{ padding: 4 }}>
                  <button type="button" className="btn btn-sm" title="Remove row" onClick={() => removeRow(r)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" className="btn btn-sm" onClick={addRow}>+ Row</button>
        {block.columns.length < 8 && <button type="button" className="btn btn-sm" onClick={addCol}>+ Column</button>}
      </div>
    </div>
  );
}

function MemoModal({ approvers, preparer, existing, copyOf, onClose, onSaved }) {
  const [form, setForm] = useState(() => {
    const base = blankForm(approvers, preparer);
    const from = existing || copyOf;
    if (!from) return base;
    const pick = (k) => (from[k] == null ? base[k] : k === 'memo_date' ? String(from[k]).slice(0, 10) : from[k]);
    const out = { ...base, ...Object.fromEntries(Object.keys(base).map((k) => [k, pick(k)])) };
    // A copy is a new memo: dated today, prepared by whoever is writing it.
    if (copyOf) Object.assign(out, { memo_date: today(), prepared_by_name: base.prepared_by_name, prepared_by_title: base.prepared_by_title, remarks: '' });
    if (!out.body?.length) out.body = base.body;
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setBlock = (i, b) => setForm((f) => ({ ...f, body: f.body.map((x, j) => (j === i ? b : x)) }));
  const removeBlock = (i) => setForm((f) => ({ ...f, body: f.body.filter((_, j) => j !== i) }));
  const moveBlock = (i, d) => setForm((f) => {
    const body = [...f.body];
    const j = i + d;
    if (j < 0 || j >= body.length) return f;
    [body[i], body[j]] = [body[j], body[i]];
    return { ...f, body };
  });
  // New blocks go in after the one the button belongs to; the bottom buttons append.
  const insertAfter = (i, b) => setForm((f) => ({ ...f, body: [...f.body.slice(0, i + 1), b, ...f.body.slice(i + 1)] }));

  async function save() {
    setError(''); setSaving(true);
    try {
      const { data } = existing
        ? await api.put(`/hr-memos/${existing.id}`, form)
        : await api.post('/hr-memos', form);
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the memo.');
      setSaving(false);
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.memo_no}` : 'New Memo'} onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}

      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="field">
          <label>To *</label>
          <input value={form.memo_to} maxLength={200} onChange={(e) => set({ memo_to: e.target.value })} />
        </div>
        <div className="field">
          <label>From *</label>
          <input value={form.memo_from} maxLength={200} onChange={(e) => set({ memo_from: e.target.value })} />
        </div>
        <div className="field">
          <label>Date *</label>
          <input type="date" value={form.memo_date} onChange={(e) => set({ memo_date: e.target.value })} />
        </div>
        <div className="field">
          <label>Subject *</label>
          <input value={form.subject} maxLength={250} placeholder="e.g. NOVEMBER HOLIDAYS" onChange={(e) => set({ subject: e.target.value })} />
        </div>
        <div className="field">
          <label>Heading</label>
          <input value={form.heading || ''} maxLength={150} placeholder="e.g. ANNOUNCEMENT:" onChange={(e) => set({ heading: e.target.value })} />
        </div>
      </div>

      <h3 style={{ margin: '12px 0 6px', fontSize: 14 }}>Body</h3>
      {form.body.map((b, i) => (
        <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: 12, marginRight: 'auto' }}>{b.type === 'table' ? 'Table' : 'Paragraph'} {i + 1}</span>
            {b.type === 'text' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 400 }}>
                <input type="checkbox" checked={!!b.bold} onChange={(e) => setBlock(i, { ...b, bold: e.target.checked })} /> Bold
              </label>
            )}
            <button type="button" className="btn btn-sm" disabled={i === 0} title="Move up" onClick={() => moveBlock(i, -1)}>↑</button>
            <button type="button" className="btn btn-sm" disabled={i === form.body.length - 1} title="Move down" onClick={() => moveBlock(i, 1)}>↓</button>
            <button type="button" className="btn btn-sm" title="Add a paragraph below" onClick={() => insertAfter(i, textBlock())}>+ Paragraph</button>
            <button type="button" className="btn btn-sm" title="Add a table below" onClick={() => insertAfter(i, tableBlock())}>+ Table</button>
            <button type="button" className="btn btn-sm btn-danger" title="Remove" onClick={() => removeBlock(i)}>×</button>
          </div>
          {b.type === 'table'
            ? <TableEditor block={b} onChange={(nb) => setBlock(i, nb)} />
            : (
              <textarea rows={Math.min(8, Math.max(2, String(b.text || '').split('\n').length + 1))} value={b.text} maxLength={5000}
                style={{ fontWeight: b.bold ? 700 : 400 }} onChange={(e) => setBlock(i, { ...b, text: e.target.value })} />
            )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button type="button" className="btn btn-sm" onClick={() => insertAfter(form.body.length - 1, textBlock())}>+ Paragraph</button>
        <button type="button" className="btn btn-sm" onClick={() => insertAfter(form.body.length - 1, tableBlock())}>+ Table</button>
      </div>

      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="field">
          <label>Prepared by (name as printed)</label>
          <input value={form.prepared_by_name || ''} maxLength={150} onChange={(e) => set({ prepared_by_name: e.target.value })} />
        </div>
        <div className="field">
          <label>Prepared by (position)</label>
          <input value={form.prepared_by_title || ''} maxLength={150} placeholder="e.g. Human Resource Assistant"
            onChange={(e) => set({ prepared_by_title: e.target.value })} />
        </div>
        {/* The General Manager who approves -- and whose name the memo is signed in. */}
        <div className="field">
          <label>Approved by (General Manager) *</label>
          <select value={form.approver_user_id} onChange={(e) => set({ approver_user_id: e.target.value })}>
            {approvers.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {existing?.status === 'approved'
              ? 'Saving changes sends it back to the approver; it prints unsigned until approved again.'
              : 'The memo is signed in the name of the General Manager who approves it.'}
          </div>
        </div>
        <div className="field">
          <label>Internal remarks (not printed)</label>
          <input value={form.remarks || ''} maxLength={500} onChange={(e) => set({ remarks: e.target.value })} />
        </div>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !form.subject.trim()} onClick={save}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// The approver's decision. Approving confirms the name printed above "General Manager" -- it starts
// as the name they signed with last time (or their employee record), so it is typed once.
function DecisionModal({ memo, approve, signAs, onClose, onDone }) {
  const [name, setName] = useState(signAs || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true); setError('');
    try {
      const { data } = approve
        ? await api.put(`/hr-memos/${memo.id}/approve`, { signatory_name: name })
        : await api.put(`/hr-memos/${memo.id}/reject`, { reason });
      onDone(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save your decision.');
      setBusy(false);
    }
  }

  return (
    <Modal title={`${approve ? 'Approve' : 'Reject'} ${memo.memo_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p style={{ marginTop: 0 }}>
        <strong>{memo.subject}</strong> to {memo.memo_to}.{' '}
        <a href={`/hrd/memo/${memo.id}/print`} target="_blank" rel="noreferrer">Preview</a>
      </p>
      {approve ? (
        <div className="field">
          <label>General Manager&apos;s name as printed on the memo *</label>
          <input autoFocus value={name} maxLength={150} onChange={(e) => setName(e.target.value)} placeholder="e.g. JIMMY W. WU" />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Printed under &ldquo;Approved by&rdquo;.</div>
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

export default function HrMemos() {
  const { can, user } = useAuth();
  const [rows, setRows] = useState([]);
  const [approvers, setApprovers] = useState([]);
  const [preparer, setPreparer] = useState({});
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [deciding, setDeciding] = useState(null); // { memo, approve }
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null = closed, { existing } / { copyOf } / {}

  const canAdd = can('/hrd/memo', 'can_add');
  const canEdit = can('/hrd/memo', 'can_edit');
  const canDelete = can('/hrd/memo', 'can_delete');
  const canPrint = can('/hrd/memo', 'can_print');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/hr-memos', { params: { status: status || undefined, search: search || undefined } });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load memos.'); }
    setLoading(false);
  }, [status, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/hr-memos/meta')
      .then(({ data }) => { setApprovers(data.approvers || []); setPreparer(data.preparer || {}); setMetaLoaded(true); })
      .catch(() => {});
  }, []);
  // The chosen General Manager decides; a System Admin can too, on the GM's behalf.
  const isAdmin = user?.account_type === 'System Admin';
  const canDecide = (r) => r.status === 'for_approval' && (isAdmin || Number(r.approver_user_id) === Number(user?.id));
  const signAsFor = (r) => approvers.find((a) => Number(a.id) === Number(r.approver_user_id))?.sign_as || '';

  const print = (r) => window.open(`/hrd/memo/${r.id}/print`, '_blank');

  async function remove(r) {
    if (!confirm(`Delete ${r.memo_no} (${r.subject})?`)) return;
    try { await api.delete(`/hr-memos/${r.id}`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not delete that memo.'); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Memo</h1>
        {canAdd && metaLoaded && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>New Memo</button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input style={{ flex: '1 1 240px' }} placeholder="Search memo #, subject, to or from"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={{ flex: '0 0 180px', width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every status</option>
          {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Memo #</th><th>Date</th><th>Subject</th><th>To</th><th>From</th><th>By</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} className="muted" style={{ padding: 16, textAlign: 'center' }}>No memos yet.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.memo_no}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.memo_date)}</td>
                  <td>{r.subject}</td>
                  <td>{r.memo_to}</td>
                  <td>{r.memo_from}</td>
                  <td>{r.created_by_name}</td>
                  <td>
                    <span className={`badge ${STATUS[r.status]?.badge || 'badge-muted'}`}>{STATUS[r.status]?.label || r.status}</span>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {r.status === 'approved' ? r.signatory_name : r.approver_name}
                    </div>
                    {r.status === 'rejected' && r.rejected_reason && (
                      <div style={{ fontSize: 11, color: '#b91c1c' }}>{r.rejected_reason}</div>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {canDecide(r) && (
                      <>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDeciding({ memo: r, approve: true })}>Approve</button>{' '}
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeciding({ memo: r, approve: false })}>Reject</button>{' '}
                      </>
                    )}
                    {canPrint && <button type="button" className="btn btn-sm" onClick={() => print(r)}>Print</button>}{' '}
                    {canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing({ existing: r })}>Edit</button>}{' '}
                    {canAdd && metaLoaded && (
                      <button type="button" className="btn btn-sm" title="Start a new memo from this one" onClick={() => setEditing({ copyOf: r })}>Copy</button>
                    )}{' '}
                    {canDelete && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(r)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <MemoModal
          approvers={approvers}
          preparer={preparer}
          existing={editing.existing || null}
          copyOf={editing.copyOf || null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {deciding && (
        <DecisionModal
          memo={deciding.memo}
          approve={deciding.approve}
          signAs={signAsFor(deciding.memo)}
          onClose={() => setDeciding(null)}
          onDone={() => { setDeciding(null); load(); }}
        />
      )}
    </div>
  );
}
