import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import Modal from '../../components/Modal';
import { displayDate, displayDateTime } from '../../utils/dates';
import { API, errorOf } from './common';

// Reschedule requests (server: routes/installationPlanner.js). A project's bar dragged on the calendar
// becomes a request with a reason, forwarded to the SBU; its dates change only once the SBU approves.
export const RESCHEDULE_LABEL = { for_approval: 'For SBU approval', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };
export const RESCHEDULE_BADGE = { for_approval: 'badge-warning', approved: 'badge-success', rejected: 'badge-danger', cancelled: 'badge-muted' };

const day10 = (v) => (v ? String(v).slice(0, 10) : '');
const spanDays = (f, t) => {
  if (!f) return 0;
  const [a, b] = [f, t || f].map((k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); });
  return Math.round((b - a) / 86400000) + 1;
};
export const rangeLabel = (f, t) => {
  if (!f) return 'No dates';
  const n = spanDays(day10(f), day10(t));
  return `${displayDate(day10(f))}${day10(t) && day10(t) !== day10(f) ? ` – ${displayDate(day10(t))}` : ''} (${n} day${n === 1 ? '' : 's'})`;
};

// After a drag: confirm the new dates, give the reason, forward to the SBU.
export function RescheduleModal({ project, newFrom, newTo, onClose, onSaved }) {
  const [reasons, setReasons] = useState(null);
  const hasPhases = (project.phases || []).length > 0;
  const [form, setForm] = useState({ new_date_from: newFrom, new_date_to: newTo, reason_id: '', remarks: '', move_phases: hasPhases });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const oldFrom = day10(project.date_from);
  const oldTo = day10(project.date_to || project.date_from);

  useEffect(() => { api.get(`${API}/reschedule-reasons`).then(({ data }) => setReasons(data)).catch((err) => setError(errorOf(err))); }, []);
  // Work phases (2026-11-11): what moving the phases and crew along would do -- by the start's shift.
  useEffect(() => {
    if (!hasPhases || !form.move_phases) { setPreview(null); return; }
    api.post(`${API}/projects/${project.id}/reschedules/preview`, { new_date_from: form.new_date_from, new_date_to: form.new_date_to })
      .then(({ data }) => setPreview(data)).catch(() => setPreview(null));
  }, [form.new_date_from, form.new_date_to, form.move_phases]); // eslint-disable-line react-hooks/exhaustive-deps

  async function forward(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`${API}/projects/${project.id}/reschedules`, form);
      onSaved();
    } catch (err) { setError(errorOf(err)); setBusy(false); }
  }

  const changed = form.new_date_from !== oldFrom || form.new_date_to !== oldTo;
  return (
    <Modal title={`Reschedule ${project.project_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ marginBottom: 10 }}>
        <strong>{project.title}</strong>
        {project.job_order_no && <span className="muted"> · {project.job_order_no}</span>}
      </div>
      <div className="card" style={{ padding: 10, marginBottom: 12, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13 }}>
        <span className="muted">Now</span><span>{rangeLabel(oldFrom, oldTo)}</span>
        <span className="muted">New</span><strong>{rangeLabel(form.new_date_from, form.new_date_to)}</strong>
      </div>
      <form onSubmit={forward}>
        <div className="filter-grid">
          <div className="field"><label>New start *</label>
            <input type="date" required value={form.new_date_from} onChange={(e) => set({ new_date_from: e.target.value })} /></div>
          <div className="field"><label>New end *</label>
            <input type="date" required min={form.new_date_from} value={form.new_date_to} onChange={(e) => set({ new_date_to: e.target.value })} /></div>
        </div>
        <div className="field">
          <label>Reason *</label>
          <select required value={form.reason_id} onChange={(e) => set({ reason_id: e.target.value })} disabled={!reasons}>
            <option value="">{reasons ? '-- Select Reason --' : 'Loading...'}</option>
            {(reasons || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {reasons && reasons.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              No reschedule reasons yet -- add them in <Link to="/lookups">Master Lists &gt; Lookups &gt; Reasons</Link> with Type <strong>Reschedule</strong>.
            </div>
          )}
        </div>
        <div className="field"><label>Remarks</label>
          <textarea rows={3} maxLength={1000} value={form.remarks} placeholder="e.g. the site is not available on the 10th"
            onChange={(e) => set({ remarks: e.target.value })} /></div>
        {hasPhases && (
          <div className="card" style={{ padding: 10, marginBottom: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.move_phases} onChange={(e) => set({ move_phases: e.target.checked })} style={{ width: 16, height: 16, minHeight: 0, flex: 'none', margin: 0 }} />
              <strong style={{ fontSize: 13 }}>Move the work phases and crew along</strong>
            </label>
            {!form.move_phases ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>The phases and crew slots keep their days -- any left outside the new dates have to be fixed on the project.</div>
            ) : preview && <ShiftPreview plan={preview} />}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12 }}>The calendar keeps the current dates until the SBU approves.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !changed || !form.reason_id}>
            {busy ? 'Forwarding...' : 'Forward to SBU for approval'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// What a delay or a drag would move (from the server's preview): the phases' new days, how many crew
// slots go with them, and the ones that cannot (that person / vehicle is busy then) and need rebooking.
export function ShiftPreview({ plan }) {
  const moves = plan.phase_moves || [];
  const slots = plan.slot_moves || [];
  const clashes = plan.clashes || [];
  if (plan.days === 0 && !moves.length) return <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>The start does not move, so the phases and crew keep their days.</div>;
  return (
    <div style={{ fontSize: 12, marginTop: 6, display: 'grid', gap: 3 }}>
      {plan.days != null && plan.days !== 0 && <div className="muted">Everything shifts {Math.abs(plan.days)} day(s) {plan.days > 0 ? 'later' : 'earlier'}.</div>}
      {moves.map((m) => (
        <div key={m.id}><strong>{m.work_type}</strong>: {rangeLabel(m.date_from, m.date_to)} → <strong>{rangeLabel(m.new_from, m.new_to)}</strong></div>
      ))}
      {moves.length === 0 && <div className="muted">No phase moves.</div>}
      <div>{slots.length ? `${slots.length} crew slot(s) move with them, same hours.` : 'No crew slots to move.'}</div>
      {clashes.length > 0 && (
        <div style={{ color: 'var(--color-danger-text, #b91c1c)' }}>
          <strong>Cannot move -- removed, rebook them:</strong>
          {clashes.map((c) => <div key={c.id}>{c.name} · {displayDate(c.date)} {c.time} → {displayDate(c.new_date)} is taken by {c.with}</div>)}
        </div>
      )}
      {(plan.outside || []).length > 0 && (
        <div style={{ color: 'var(--color-warning-text, #b45309)' }}>
          {plan.outside.map((m) => m.work_type).join(', ')} would end up outside the new dates -- widen them, or fix the phase after.
        </div>
      )}
    </div>
  );
}

// One request: its dates and reason; Approve / Reject for the SBU, Cancel for whoever asked.
export function DecisionModal({ request: r, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function act(verdict) {
    if (verdict === 'reject' && !note.trim()) { setError('Say why it is rejected.'); return; }
    if (verdict === 'cancel' && !window.confirm('Cancel this reschedule request? The project keeps its dates.')) return;
    setBusy(true);
    setError('');
    try { await api.post(`${API}/reschedules/${r.id}/${verdict}`, { note }); onDone(); } catch (err) { setError(errorOf(err)); setBusy(false); }
  }
  return (
    <Modal title={`${r.kind === 'delay' ? 'Delay' : 'Reschedule'} · ${r.project_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ marginBottom: 8 }}>
        <Link to={`/installation-planner/projects/${r.project_id}`}><strong>{r.project_title}</strong></Link>
        {r.job_order_no && <span className="muted"> · {r.job_order_no}</span>}
        <span className={`badge ${RESCHEDULE_BADGE[r.status]}`} style={{ marginLeft: 8 }}>{RESCHEDULE_LABEL[r.status]}</span>
      </div>
      <div className="card" style={{ padding: 10, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13 }}>
        <span className="muted">From</span><span>{rangeLabel(r.old_date_from, r.old_date_to)}</span>
        <span className="muted">To</span><strong>{rangeLabel(r.new_date_from, r.new_date_to)}</strong>
        {r.kind === 'delay' && (
          <>
            <span className="muted">Delayed</span>
            <span><strong>{r.work_type_name}</strong> not worked {rangeLabel(r.lost_from, r.lost_to)} · pushed back {r.shift_days} day(s), with the later phases and their crew</span>
          </>
        )}
        {r.kind !== 'delay' && r.move_phases ? <><span className="muted">Phases</span><span>The work phases and crew move along</span></> : null}
        <span className="muted">Reason</span><span>{r.reason_name}</span>
        {r.result_note && <><span className="muted">Result</span><span style={{ whiteSpace: 'pre-wrap' }}>{r.result_note}</span></>}
        {r.remarks && <><span className="muted">Remarks</span><span style={{ whiteSpace: 'pre-wrap' }}>{r.remarks}</span></>}
        <span className="muted">Asked by</span><span>{r.requested_by_name || '—'} · {displayDateTime(r.requested_at)}</span>
        {r.decided_at && <><span className="muted">{RESCHEDULE_LABEL[r.status]}</span><span>{r.decided_by_name || '—'} · {displayDateTime(r.decided_at)}{r.decision_note ? ` · ${r.decision_note}` : ''}</span></>}
      </div>
      {r.may_decide && (
        <div className="field" style={{ marginTop: 10 }}><label>Note (required to reject)</label>
          <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {r.may_decide && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('approve')}>Approve -- move the dates</button>}
        {r.may_decide && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('reject')}>Reject</button>}
        {r.may_cancel && <button type="button" className="btn" disabled={busy} onClick={() => act('cancel')}>Cancel request</button>}
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
      {r.status === 'for_approval' && !r.may_decide && (
        <p className="muted" style={{ fontSize: 12 }}>Waiting for the SBU over this job's sales division.</p>
      )}
    </Modal>
  );
}
