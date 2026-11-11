import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { displayDate, displayDateTime } from '../utils/dates';
import {
  API, BOM_LABEL, BlobImage, Check, ProgressBar, RESOURCES, StatusBadge, WorkChip, resourceList, resourceName, errorOf, filePayload, openBlob, personName, slotHours, timeText, vehicleLabel,
} from './installation/common';
import { DecisionModal, RESCHEDULE_BADGE, RESCHEDULE_LABEL, ShiftPreview, rangeLabel } from './installation/reschedule';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ROLE_BADGE = { installer: 'badge-info', subcon: 'badge-warning', driver: 'badge-success', vehicle: 'badge-muted' };
const day10 = (v) => (v ? String(v).slice(0, 10) : '');
// Every day from `from` to `to`, as YYYY-MM-DD.
function daysBetween(from, to) {
  if (!from) return [];
  const out = [];
  const [y, m, d] = from.split('-').map(Number);
  for (let i = 0; i < 366; i += 1) {
    const dt = new Date(y, m - 1, d + i);
    const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    if (k > (to || from)) break;
    out.push(k);
  }
  return out;
}
const weekday = (k) => { const [y, m, d] = k.split('-').map(Number); return WEEKDAYS[new Date(y, m - 1, d).getDay()]; };
const hoursText = (h) => `${Number.isInteger(h) ? h : h.toFixed(1)} hr${h === 1 ? '' : 's'}`;

// Production > Installation Planner > a project -- PLANNER's project page: picture, status and progress,
// details and team on the left; the category's quality checklist, the BOM lines, Update Progress and the
// update history on the right.
export default function InstallationProjectView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // 'bom-add' | 'bom-import'

  function load() {
    return api.get(`${API}/projects/${id}`).then(({ data }) => { setP(data); setError(''); }).catch((err) => setError(errorOf(err)));
  }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function call(fn) {
    setBusy(true);
    setError('');
    try { await fn(); await load(); } catch (err) { setError(errorOf(err)); } finally { setBusy(false); }
  }
  const view = async (path) => { const m = await openBlob(path); if (m) setError(m); };

  async function remove() {
    if (!window.confirm(`Delete project ${p.project_no}? Its checklist, BOM, files and updates go with it.`)) return;
    try { await api.delete(`${API}/projects/${id}`); navigate('/installation-planner/projects'); } catch (err) { setError(errorOf(err)); }
  }

  if (!p) return <div className="page">{error ? <div className="error-banner">{error}</div> : <LoadingSpinner />}</div>;
  const r = p.rights || {};
  const files = p.files || {};

  return (
    <div className="page">
      <div className="page-header" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{p.title}</h1>
          <div className="muted">
            {p.project_no} · {p.date_from ? `${displayDate(p.date_from)} – ${displayDate(p.date_to || p.date_from)}` : 'No timeline set'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.can_edit && <Link className="btn" to={`/installation-planner/projects/${id}/edit`}>Edit</Link>}
          {r.can_delete && <button type="button" className="btn btn-danger" onClick={remove}>Delete</button>}
          <Link className="btn" to="/installation-planner/projects">Back</Link>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        {/* LEFT */}
        <div style={{ display: 'grid', gap: 12, flex: '1 1 300px', minWidth: 0 }}>
          <div className="card" style={{ textAlign: 'center' }}>
            {files.image ? <BlobImage path={`${API}/projects/${id}/files/image`} style={{ width: '100%', maxHeight: 260, marginBottom: 12 }} />
              : <div className="muted" style={{ marginBottom: 12 }}>No image</div>}
            <div style={{ marginBottom: 10 }}>Status: <StatusBadge status={p.status} /></div>
            <ProgressBar value={p.progress} />
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Details</h3>
            <Row label="Job Order">
              {p.job_order_id ? <Link to={`/job-orders/${p.job_order_id}`}>{p.job_order_no}</Link> : '—'}
              {p.customer_name && <div className="muted" style={{ fontSize: 12 }}>{p.customer_name}</div>}
            </Row>
            <Row label="Category">{p.category_name || '—'}</Row>
            <Row label="Site Address">{p.site_address || '—'}</Row>
            <Row label="Vehicle(s)">{p.vehicles.length ? p.vehicles.map(vehicleLabel).join(', ') : '—'}</Row>
            <Row label="Permit Needed">
              {p.needs_permit ? <span className="badge badge-warning">YES</span> : <span className="badge badge-muted">NO</span>}
              {p.needs_permit ? (files.permit
                ? <> <button type="button" className="btn btn-sm" onClick={() => view(`${API}/projects/${id}/files/permit`)}>View / Download</button></>
                : <span className="muted"> — no file attached</span>) : null}
            </Row>
            <Row label="BOM PDF">
              {files.bom ? <button type="button" className="btn btn-sm" onClick={() => view(`${API}/projects/${id}/files/bom`)}>View / Download</button> : '—'}
            </Row>
            <Row label="Safety Officer">{p.needs_safety_officer ? (p.safety_officer_name || '—') : <span className="muted">Not required</span>}</Row>
            {p.description && <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{p.description}</div>}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Team</h3>
            <Row label="Planner">{p.planner_name || '—'}</Row>
            <Row label="Driver">{p.driver_name || '—'}</Row>
            <Row label="Installers">{p.installers.length ? p.installers.map(personName).join(', ') : '—'}</Row>
            <Row label="Subcons">
              {p.subcons.length || (p.subcon_suppliers || []).length
                ? [...p.subcons.map(personName), ...(p.subcon_suppliers || []).map((x) => `${x.name} (supplier)`)].join(', ')
                : '—'}
            </Row>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ display: 'grid', gap: 12, flex: '2 1 480px', minWidth: 0 }}>
          {(p.reschedules || []).length > 0 && <Reschedules list={p.reschedules} onOpen={(request) => setModal({ kind: 'decision', request })} />}
          <WorkPhases p={p} busy={busy} canEdit={r.can_edit} call={call}
            onAdd={() => setModal({ kind: 'phase' })} onEdit={(phase) => setModal({ kind: 'phase', phase })}
            onDelay={(phase) => setModal({ kind: 'delay', phase })} />
          <CrewSchedule p={p} busy={busy} canEdit={r.can_edit} call={call}
            onAdd={(day) => setModal({ kind: 'slot', day })} onEdit={(slot) => setModal({ kind: 'slot', slot })} />
          <Checklist p={p} busy={busy} canTick={r.can_update} call={call} />
          <Bom p={p} busy={busy} rights={r} call={call} onAdd={() => setModal('bom-add')} onImport={() => setModal('bom-import')} onView={view} />
          {r.can_update && <UpdateProgress id={id} onSaved={load} onError={setError} />}
          <History p={p} onView={view} />
        </div>
      </div>

      {modal?.kind === 'decision' && (
        <DecisionModal request={modal.request} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />
      )}
      {modal?.kind === 'phase' && (
        <PhaseModal p={p} phase={modal.phase} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
      {modal?.kind === 'delay' && (
        <DelayModal p={p} phase={modal.phase} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
      {modal?.kind === 'slot' && (
        <SlotModal p={p} slot={modal.slot} day={modal.day} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
      {modal === 'bom-add' && <BomAddModal id={id} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'bom-import' && <BomImportModal id={id} hasItems={p.bom_items.length > 0} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
      <strong style={{ minWidth: 120 }}>{label}:</strong>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// The project's reschedule requests (dragged on the planner calendar), newest first; a waiting one on top
// is what the SBU still has to decide.
function Reschedules({ list, onOpen }) {
  const waiting = list.find((x) => x.status === 'for_approval');
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Reschedules &amp; Delays</h3>
        {waiting && <span className={`badge ${waiting.may_decide ? 'badge-danger' : 'badge-warning'}`}>{waiting.may_decide ? 'Waiting on you' : 'Waiting for the SBU'}</span>}
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th>Asked</th><th>From</th><th>To</th><th>Reason</th><th>Status</th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id} onClick={() => onOpen(x)} style={{ cursor: 'pointer' }}>
                <td style={{ whiteSpace: 'nowrap' }}>{displayDateTime(x.requested_at)}<div className="muted" style={{ fontSize: 12 }}>{x.requested_by_name}</div></td>
                <td>{rangeLabel(x.old_date_from, x.old_date_to)}</td>
                <td><strong>{rangeLabel(x.new_date_from, x.new_date_to)}</strong></td>
                <td>
                  {x.kind === 'delay' && <div><span className="badge badge-warning">Delay</span> <strong>{x.work_type_name}</strong> not worked {rangeLabel(x.lost_from, x.lost_to)}</div>}
                  {x.reason_name}{x.remarks && <div className="muted" style={{ fontSize: 12 }}>{x.remarks}</div>}
                  {x.result_note && <div className="muted" style={{ fontSize: 12 }}>{x.result_note}</div>}
                </td>
                <td>
                  <span className={`badge ${RESCHEDULE_BADGE[x.status]}`}>{RESCHEDULE_LABEL[x.status]}</span>
                  {x.decided_by_name && <div className="muted" style={{ fontSize: 12 }}>{x.decided_by_name}{x.decision_note ? ` · ${x.decision_note}` : ''}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Work Phases (asked 2026-11-11): the timeline split into the kinds of work, e.g. Nov 11-14 -> Assembling
// Nov 11-13, Installation Nov 12-14. Overlaps are fine; the crew slots then say which phase they work.
// A bar per phase over the project's days, then the list.
function WorkPhases({ p, busy, canEdit, call, onAdd, onEdit, onDelay }) {
  const days = daysBetween(day10(p.date_from), day10(p.date_to));
  const phases = p.phases || [];
  const types = p.work_types || [];
  const unused = types.filter((t) => t.is_active && !phases.some((x) => Number(x.work_type_id) === Number(t.id)));
  const outside = (x) => days.length && (day10(x.date_from) < days[0] || day10(x.date_to) > days[days.length - 1]);
  const remove = (x) => window.confirm(`Remove the ${x.work_type} phase (${rangeLabel(x.date_from, x.date_to)})?`)
    && call(() => api.delete(`${API}/projects/${p.id}/phases/${x.id}`));
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Work Phases <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>what work is done on which days</span></h3>
        {canEdit && days.length > 0 && unused.length > 0 && <button type="button" className="btn btn-sm btn-primary" onClick={onAdd}>+ Add Phase</button>}
      </div>
      {days.length === 0 ? <p className="muted">Set the project's Timeline From / To (Edit) first.</p>
        : phases.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No phases yet -- the crew is booked without saying the work.{' '}
            {types.length ? `Add ${types.map((t) => t.name).join(' / ')} to split the timeline.` : "This project's category has no work types -- add them on Installation Categories."}
          </p>
        ) : (
          <>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table style={{ tableLayout: 'fixed', minWidth: 140 + days.length * 44 }}>
                <thead>
                  <tr>
                    <th style={{ width: 140 }} />
                    {days.map((k) => <th key={k} style={{ textAlign: 'center', fontSize: 11, padding: 4 }}>{weekday(k)}<div style={{ fontWeight: 400 }}>{displayDate(k).replace(/,?\s*\d{4}$/, '')}</div></th>)}
                  </tr>
                </thead>
                <tbody>
                  {phases.map((x) => (
                    <tr key={x.id}>
                      <td><WorkChip name={x.work_type} color={x.work_color} /></td>
                      {days.map((k) => {
                        const on = k >= day10(x.date_from) && k <= day10(x.date_to);
                        return <td key={k} style={{ padding: 2 }}><div style={{ height: 18, borderRadius: 3, background: on ? x.work_color : 'transparent', border: on ? '1px solid rgba(0,0,0,0.15)' : 'none' }} /></td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Work</th><th>Days</th><th>Crew Slots</th><th>Note</th>{canEdit && <th />}</tr></thead>
                <tbody>
                  {phases.map((x) => (
                    <tr key={x.id}>
                      <td><WorkChip name={x.work_type} color={x.work_color} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {rangeLabel(x.date_from, x.date_to)}
                        {outside(x) && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Outside the timeline -- Edit it</span>}
                      </td>
                      <td>{Number(x.slot_count) || <span className="muted">0</span>}</td>
                      <td>{x.note || ''}</td>
                      {canEdit && (
                        <td style={{ whiteSpace: 'nowrap', width: 180 }}>
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onDelay(x)} title="Not worked on a day (weather, site not ready...) -- push it back">Delay</button>{' '}
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onEdit(x)}>Edit</button>{' '}
                          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(x)}>✕</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </div>
  );
}

function PhaseModal({ p, phase, onClose, onSaved }) {
  const days = daysBetween(day10(p.date_from), day10(p.date_to));
  const taken = new Set((p.phases || []).filter((x) => x.id !== phase?.id).map((x) => Number(x.work_type_id)));
  const types = (p.work_types || []).filter((t) => !taken.has(Number(t.id)) && (t.is_active || Number(t.id) === Number(phase?.work_type_id)));
  const [form, setForm] = useState({
    work_type_id: phase ? String(phase.work_type_id) : String(types[0]?.id || ''),
    date_from: phase ? day10(phase.date_from) : days[0],
    date_to: phase ? day10(phase.date_to) : days[days.length - 1],
    note: phase?.note || '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (phase) await api.put(`${API}/projects/${p.id}/phases/${phase.id}`, form);
      else await api.post(`${API}/projects/${p.id}/phases`, form);
      onSaved();
    } catch (err) { setError(errorOf(err)); setBusy(false); }
  }
  return (
    <Modal title={phase ? `Change ${phase.work_type}` : 'Add Work Phase'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <form onSubmit={save}>
        <div className="field">
          <label>Work *</label>
          <select required value={form.work_type_id} onChange={(e) => set({ work_type_id: e.target.value })}>
            <option value="">-- Select --</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="muted" style={{ fontSize: 12 }}>From the category's work types (Installation Categories). A later one in the order cannot start before an earlier one starts.</div>
        </div>
        <div className="filter-grid">
          <div className="field">
            <label>From *</label>
            <select value={form.date_from} onChange={(e) => set({ date_from: e.target.value, date_to: form.date_to < e.target.value ? e.target.value : form.date_to })}>
              {days.map((k) => <option key={k} value={k}>{weekday(k)}, {displayDate(k)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>To *</label>
            <select value={form.date_to} onChange={(e) => set({ date_to: e.target.value })}>
              {days.filter((k) => k >= form.date_from).map((k) => <option key={k} value={k}>{weekday(k)}, {displayDate(k)}</option>)}
            </select>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Within the project's timeline, {rangeLabel(p.date_from, p.date_to)}. Phases may overlap.</div>
        <div className="field"><label>Note</label><input maxLength={500} value={form.note} onChange={(e) => set({ note: e.target.value })} /></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// Delay a phase (asked 2026-11-11): it could not be worked on a day -- bad weather, site not ready. The
// day(s) lost and the reason are recorded; the phase from that day on, every later phase and their crew
// slots move back N days (same hours). Inside the timeline it applies at once; past the end date it goes
// to the SBU, like a reschedule. The preview shows what moves and who must be rebooked.
function DelayModal({ p, phase, onClose, onSaved }) {
  const phaseDays = daysBetween(day10(phase.date_from), day10(phase.date_to));
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const first = phaseDays.includes(todayKey) ? todayKey : phaseDays[0];
  const [form, setForm] = useState({ lost_from: first, lost_to: first, shift_days: 1, reason_id: '', remarks: '' });
  const [shiftTouched, setShiftTouched] = useState(false);
  const [reasons, setReasons] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const lostCount = daysBetween(form.lost_from, form.lost_to).length;

  useEffect(() => { api.get(`${API}/reschedule-reasons`).then(({ data }) => setReasons(data)).catch((err) => setError(errorOf(err))); }, []);
  // Push back by the days lost unless the planner set it.
  useEffect(() => { if (!shiftTouched) set({ shift_days: lostCount }); }, [lostCount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const body = { phase_id: phase.id, lost_from: form.lost_from, lost_to: form.lost_to, shift_days: form.shift_days };
    api.post(`${API}/projects/${p.id}/delays/preview`, body)
      .then(({ data }) => { setPreview(data); setError(''); })
      .catch((err) => { setPreview(null); setError(errorOf(err)); });
  }, [form.lost_from, form.lost_to, form.shift_days]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`${API}/projects/${p.id}/delays`, { ...form, phase_id: phase.id });
      if (data.applied && data.result_note) window.alert(`Delay applied.\n\n${data.result_note}`);
      onSaved();
    } catch (err) { setError(errorOf(err)); setBusy(false); }
  }

  return (
    <Modal title={`Delay ${phase.work_type}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        <WorkChip name={phase.work_type} color={phase.work_color} /> {rangeLabel(phase.date_from, phase.date_to)} · project {rangeLabel(p.date_from, p.date_to)}
      </div>
      <form onSubmit={save}>
        <div className="filter-grid">
          <div className="field">
            <label>Not worked from *</label>
            <select value={form.lost_from} onChange={(e) => set({ lost_from: e.target.value, lost_to: form.lost_to < e.target.value ? e.target.value : form.lost_to })}>
              {phaseDays.map((k) => <option key={k} value={k}>{weekday(k)}, {displayDate(k)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>to *</label>
            <select value={form.lost_to} onChange={(e) => set({ lost_to: e.target.value })}>
              {phaseDays.filter((k) => k >= form.lost_from).map((k) => <option key={k} value={k}>{weekday(k)}, {displayDate(k)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Push back by (days) *</label>
            <input type="number" min={1} max={90} required value={form.shift_days}
              onChange={(e) => { setShiftTouched(true); set({ shift_days: e.target.value === '' ? '' : Number(e.target.value) }); }} />
          </div>
        </div>
        <div className="field">
          <label>Reason *</label>
          <select required value={form.reason_id} onChange={(e) => set({ reason_id: e.target.value })} disabled={!reasons}>
            <option value="">{reasons ? '-- Select Reason --' : 'Loading...'}</option>
            {(reasons || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {reasons && reasons.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>No reasons yet -- add them in <Link to="/lookups">Lookups &gt; Reasons</Link> with Type <strong>Reschedule</strong> (e.g. Bad weather).</div>
          )}
        </div>
        <div className="field"><label>Remarks</label>
          <textarea rows={2} maxLength={1000} value={form.remarks} placeholder="e.g. heavy rain all morning, the site was flooded" onChange={(e) => set({ remarks: e.target.value })} /></div>

        {preview && (
          <div className="card" style={{ padding: 10, marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>What happens</strong>
            <ShiftPreview plan={preview} />
            <div style={{ fontSize: 12, marginTop: 6 }}>
              Timeline: {rangeLabel(preview.old_date_from, preview.old_date_to)}
              {preview.new_date_to !== preview.old_date_to ? <> → <strong>{rangeLabel(preview.new_date_from, preview.new_date_to)}</strong></> : ' (unchanged)'}
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {preview.needs_approval
                ? <span className="badge badge-warning">The end date moves -- needs SBU approval; nothing moves until then</span>
                : <span className="badge badge-success">Fits inside the timeline -- applied now</span>}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !preview || !form.reason_id}>
            {busy ? 'Saving...' : preview?.needs_approval ? 'Forward to SBU for approval' : 'Apply delay'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// Crew & Vehicle Schedule: the project's days, each with who -- installers, subcons, drivers -- and
// which vehicles are on it, from what time to what time. Any of them can be on another project the same
// day at other hours; the server refuses overlaps.
function CrewSchedule({ p, busy, canEdit, call, onAdd, onEdit }) {
  const days = daysBetween(day10(p.date_from), day10(p.date_to));
  const slots = p.crew_slots || [];
  const byDay = new Map(days.map((k) => [k, []]));
  const outside = [];
  for (const s of slots) (byDay.get(day10(s.work_date)) || outside).push(s);
  // Hours per person / vehicle across the project.
  const totals = new Map();
  for (const s of slots) {
    const name = resourceName(s);
    totals.set(name, (totals.get(name) || 0) + slotHours(s));
  }
  const remove = (s) => window.confirm(`Remove ${resourceName(s)} from ${day10(s.work_date)}, ${timeText(s.start_time)} – ${timeText(s.end_time)}?`)
    && call(() => api.delete(`${API}/projects/${p.id}/crew/${s.id}`));
  const row = (s, flag) => (
    <tr key={s.id}>
      <td><span className={`badge ${ROLE_BADGE[s.role] || 'badge-muted'}`}>{RESOURCES[s.role]?.one || s.role}</span></td>
      <td><strong>{resourceName(s)}</strong>{flag && <span className="badge badge-danger" style={{ marginLeft: 6 }}>{flag}</span>}</td>
      <td><WorkChip name={s.work_type} color={s.work_color} /></td>
      <td style={{ whiteSpace: 'nowrap' }}>{timeText(s.start_time)} – {timeText(s.end_time)}</td>
      <td style={{ whiteSpace: 'nowrap' }}>{hoursText(slotHours(s))}</td>
      <td>{s.note || ''}</td>
      {canEdit && (
        <td style={{ whiteSpace: 'nowrap', width: 120 }}>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onEdit(s)}>Edit</button>{' '}
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(s)}>✕</button>
        </td>
      )}
    </tr>
  );
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Crew &amp; Vehicle Schedule <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{days.length} day(s) · {slots.length} slot(s)</span></h3>
        {canEdit && days.length > 0 && <button type="button" className="btn btn-sm btn-primary" onClick={() => onAdd(days[0])}>+ Assign</button>}
      </div>
      {days.length === 0 ? <p className="muted">Set the project's Timeline From / To (Edit) to schedule the crew and vehicles on its days.</p> : (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>As</th><th>Who / What</th><th>Work</th><th>Time</th><th>Hours</th><th>Note</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {days.map((k) => [
                <tr key={k}>
                  <th colSpan={canEdit ? 7 : 6} style={{ background: 'var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span>{weekday(k)}, {displayDate(k)}</span>
                      {canEdit && <button type="button" className="btn btn-sm" onClick={() => onAdd(k)}>+ Add</button>}
                    </div>
                  </th>
                </tr>,
                ...(byDay.get(k).length ? byDay.get(k).map((s) => row(s)) : [
                  <tr key={`${k}-none`}><td colSpan={canEdit ? 7 : 6} className="muted">Nobody scheduled.</td></tr>,
                ]),
              ])}
              {outside.length > 0 && [
                <tr key="outside"><th colSpan={canEdit ? 7 : 6} style={{ background: 'var(--border)' }}>Outside the timeline (the dates were changed)</th></tr>,
                ...outside.map((s) => row(s, displayDate(s.work_date))),
              ]}
            </tbody>
          </table>
        </div>
      )}
      {totals.size > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {[...totals].map(([name, h]) => `${name}: ${hoursText(h)}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

// Assign (or change) the hours of one installer, subcon, driver or vehicle. A new assignment can repeat the same hours on several of the
// project's days at once (e.g. Nov 8-10, 8:00 AM - 11:30 AM). Shows what the installer already has on
// the day, on every project, so a free window is easy to see.
function SlotModal({ p, slot, day, onClose, onSaved }) {
  const timeline = daysBetween(day10(p.date_from), day10(p.date_to));
  // Work phases (2026-11-11): with phases on the project the slot says which work it is, and only that
  // phase's days are offered. The first phase running on the day it was opened from is the default.
  const phases = p.phases || [];
  const startDay = slot ? day10(slot.work_date) : day;
  const covers = (x, k) => k >= day10(x.date_from) && k <= day10(x.date_to);
  const [phaseId, setPhaseId] = useState(String(slot?.phase_id || phases.find((x) => covers(x, startDay))?.id || ''));
  const phase = phases.find((x) => String(x.id) === phaseId);
  const days = phase ? timeline.filter((k) => covers(phase, k)) : timeline;
  const [meta, setMeta] = useState(null);
  const [role, setRole] = useState(slot?.role || 'installer');
  const [form, setForm] = useState({
    who: slot ? String(slot.role === 'vehicle' ? slot.asset_id : slot.employee_id) : '',
    start_time: slot ? String(slot.start_time).slice(0, 5) : '08:00',
    end_time: slot ? String(slot.end_time).slice(0, 5) : '11:30',
    note: slot?.note || '',
  });
  const [picked, setPicked] = useState(slot ? [day10(slot.work_date)] : [day]);
  const [taken, setTaken] = useState([]);
  const [savedSome, setSavedSome] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => { api.get(`${API}/meta`).then(({ data }) => setMeta(data)).catch((err) => setError(errorOf(err))); }, []);
  const isVehicle = role === 'vehicle';
  // Their slots on the chosen days, on every project and in any role -- a person is one person.
  useEffect(() => {
    if (!form.who || !picked.length) { setTaken([]); return; }
    const sorted = [...picked].sort();
    api.get(`${API}/crew`, { params: { from: sorted[0], to: sorted[sorted.length - 1], [isVehicle ? 'asset_id' : 'employee_id']: form.who } })
      .then(({ data }) => setTaken(data.filter((s) => picked.includes(day10(s.work_date)) && s.id !== slot?.id)))
      .catch(() => {});
  }, [form.who, role, picked.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Already on this project in that role: ★, and listed first.
  const onProject = new Set((role === 'installer' ? p.installers : role === 'subcon' ? p.subcons : role === 'vehicle' ? p.vehicles
    : (p.driver_employee_id ? [{ id: p.driver_employee_id }] : [])).map((x) => Number(x.id)));
  // Everyone of that kind, plus anyone already on the project who no longer has the Position Code (so an
  // older slot can still be edited); the project's own first.
  let options = [];
  if (meta) {
    options = resourceList(role, meta);
    const onProjectRows = role === 'installer' ? p.installers : role === 'subcon' ? p.subcons : role === 'vehicle' ? p.vehicles : [];
    for (const x of onProjectRows) {
      if (!options.some((o) => Number(o.id) === Number(x.id))) {
        options.push({ id: x.id, name: role === 'vehicle' ? vehicleLabel(x) : personName(x) });
      }
    }
    options.sort((a, b) => onProject.has(Number(b.id)) - onProject.has(Number(a.id)) || a.name.localeCompare(b.name));
  }
  const R = RESOURCES[role];
  const overlaps = (s) => String(s.start_time).slice(0, 5) < form.end_time && String(s.end_time).slice(0, 5) > form.start_time;

  async function save(e) {
    e.preventDefault();
    if (!picked.length) { setError('Pick at least one day.'); return; }
    setBusy(true);
    setError('');
    const body = (work_date) => ({
      role, start_time: form.start_time, end_time: form.end_time, note: form.note, work_date, phase_id: phaseId || null,
      [isVehicle ? 'asset_id' : 'employee_id']: form.who,
    });
    if (slot) {
      try { await api.put(`${API}/projects/${p.id}/crew/${slot.id}`, body(picked[0])); onSaved(); } catch (err) { setError(errorOf(err)); setBusy(false); }
      return;
    }
    // One slot per day; the days that clash stay ticked with the reason, the rest are saved.
    const failed = [];
    for (const k of [...picked].sort()) {
      try { await api.post(`${API}/projects/${p.id}/crew`, body(k)); } catch (err) { failed.push({ day: k, why: errorOf(err) }); }
    }
    if (failed.length) {
      const saved = picked.length - failed.length;
      if (saved) setSavedSome(true);
      setError(`${saved ? `${saved} day(s) saved. ` : ''}Not saved -- ${failed.map((f) => `${displayDate(f.day)}: ${f.why}`).join(' ')}`);
      setPicked(failed.map((f) => f.day));
      setBusy(false);
      return;
    }
    onSaved();
  }
  const close = savedSome ? onSaved : onClose;

  return (
    <Modal title={slot ? `Change ${R.one} Slot` : 'Assign to the Schedule'} onClose={close}>
      {error && <div className="error-banner">{error}</div>}
      {!meta ? <LoadingSpinner /> : (
        <form onSubmit={save}>
          <div className="field">
            <label>As *</label>
            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              {Object.entries(RESOURCES).map(([k, cfg]) => (
                <button key={k} type="button" className={`btn btn-sm ${role === k ? 'btn-primary' : ''}`} disabled={!!slot}
                  onClick={() => { setRole(k); set({ who: '' }); }}>{cfg.one}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>{R.one} *</label>
            <select required value={form.who} onChange={(e) => set({ who: e.target.value })}>
              <option value="">-- Select {R.one} --</option>
              {options.map((x) => (
                <option key={x.id} value={x.id}>{x.name}{onProject.has(Number(x.id)) ? ' ★ on this project' : ''}</option>
              ))}
            </select>
            <div className="muted" style={{ fontSize: 12 }}>
              {isVehicle ? 'Vehicles in Assets > Fleet.' : `Employees with Position Code ${R.code}.`} ★ = already on this project;
              {role === 'driver' ? ' a driver you schedule becomes the project\'s driver if it has none.' : ` any other you schedule is added to the project's ${R.plural.toLowerCase()}.`}
            </div>
            {options.length === 0 && <div className="muted" style={{ fontSize: 12 }}>{R.none}</div>}
          </div>
          {phases.length > 0 && (
            <div className="field">
              <label>Work *</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {phases.map((x) => (
                  <button key={x.id} type="button" className={`btn btn-sm ${phaseId === String(x.id) ? 'btn-primary' : ''}`}
                    onClick={() => {
                      setPhaseId(String(x.id));
                      const inIt = picked.filter((k) => covers(x, k));
                      setPicked(inIt.length ? inIt : [timeline.find((k) => covers(x, k)) || day10(x.date_from)]);
                    }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: x.work_color, marginRight: 6, border: '1px solid rgba(0,0,0,0.2)' }} />
                    {x.work_type} <span style={{ fontWeight: 400, opacity: 0.8 }}>· {rangeLabel(x.date_from, x.date_to).replace(/\s*\(.*\)$/, '')}</span>
                  </button>
                ))}
              </div>
              {!phase && <div className="muted" style={{ fontSize: 12 }}>Pick the work this slot is for -- its days are offered below.</div>}
            </div>
          )}
          <div className="field">
            <label>{slot ? 'Day *' : 'Day(s) *'}</label>
            {slot ? (
              <select value={picked[0]} onChange={(e) => setPicked([e.target.value])}>
                {days.map((k) => <option key={k} value={k}>{weekday(k)}, {displayDate(k)}</option>)}
              </select>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
                {days.map((k) => (
                  <Check key={k} checked={picked.includes(k)} onChange={(v) => setPicked(v ? [...picked, k] : picked.filter((x) => x !== k))}>
                    {weekday(k)} {displayDate(k)}
                  </Check>
                ))}
                {days.length > 1 && (
                  <button type="button" className="btn btn-sm" onClick={() => setPicked(picked.length === days.length ? [] : days)}>
                    {picked.length === days.length ? 'None' : 'Every day'}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="filter-grid">
            <div className="field"><label>Start *</label><input type="time" required step={300} value={form.start_time} onChange={(e) => set({ start_time: e.target.value })} /></div>
            <div className="field"><label>End *</label><input type="time" required step={300} value={form.end_time} onChange={(e) => set({ end_time: e.target.value })} /></div>
          </div>
          <div className="field"><label>Note</label><input maxLength={500} value={form.note} placeholder="e.g. mounting, wiring" onChange={(e) => set({ note: e.target.value })} /></div>

          {form.who && (
            <div className="card" style={{ padding: 10, marginTop: 8 }}>
              <strong style={{ fontSize: 13 }}>Already scheduled on {picked.length > 1 ? 'these days' : 'this day'}</strong>
              {taken.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>Nothing -- free all day.</div> : taken.map((s) => (
                <div key={s.id} style={{ fontSize: 12, marginTop: 4, color: overlaps(s) ? 'var(--color-danger-text, #b91c1c)' : undefined }}>
                  {picked.length > 1 && `${displayDate(s.work_date)} · `}{timeText(s.start_time)} – {timeText(s.end_time)}{s.role !== role ? ` · as ${RESOURCES[s.role]?.one.toLowerCase()}` : ''} · {s.project_no}{s.job_order_no ? ` (${s.job_order_no})` : ''} {s.project_id === p.id ? '· this project' : `· ${s.project_title}`}
                  {overlaps(s) && <strong> -- overlaps the hours above</strong>}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : slot ? 'Save' : `Assign${picked.length > 1 ? ` (${picked.length} days)` : ''}`}</button>
            <button type="button" className="btn" onClick={close}>{savedSome ? 'Close' : 'Cancel'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Checklist({ p, busy, canTick, call }) {
  const done = p.checklist.filter((c) => c.checked_at).length;
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Quality Checklist</h3>
        <span className="muted" style={{ fontSize: 12 }}>Category: {p.category_name || '—'}{p.checklist.length ? ` · ${done}/${p.checklist.length} done` : ''}</span>
      </div>
      {!p.category_id ? <p className="muted">No category assigned.</p>
        : p.checklist.length === 0 ? <p className="muted">No checklist items for this category.</p> : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th style={{ width: 50 }}>#</th><th>Checklist Item</th><th>Done</th><th style={{ width: 110, textAlign: 'center' }}>Status</th></tr></thead>
              <tbody>
                {p.checklist.map((c) => (
                  <tr key={c.id}>
                    <td>{c.sort_order}</td>
                    <td>{c.item}{c.is_required ? <span className="badge badge-danger" style={{ marginLeft: 6 }}>Required</span> : null}</td>
                    <td>{c.checked_at ? <>{displayDateTime(c.checked_at)}<div className="muted" style={{ fontSize: 12 }}>{c.checked_by_name}</div></> : '—'}</td>
                    <td style={{ textAlign: 'center' }}>
                      {c.checked_at ? (
                        <>
                          <span className="badge badge-success">✓ DONE</span>
                          {canTick && (
                            <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} disabled={busy} title="Undo"
                              onClick={() => window.confirm('Mark this item not done again?') && call(() => api.delete(`${API}/projects/${p.id}/checks/${c.id}`))}>↺</button>
                          )}
                        </>
                      ) : canTick ? (
                        <button type="button" className="btn btn-sm" disabled={busy} title="Mark as DONE"
                          onClick={() => call(() => api.post(`${API}/projects/${p.id}/checks/${c.id}`))}>✓ Done</button>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

function Bom({ p, busy, rights, call, onAdd, onImport, onView }) {
  const items = p.bom_items;
  const n = (s) => items.filter((b) => b.status === s).length;
  const pct = items.length ? Math.round((n('done') / items.length) * 100) : 0;
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>BOM Items <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{items.length} item(s)</span></h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {p.files?.bom && <button type="button" className="btn btn-sm" onClick={() => onView(`${API}/projects/${p.id}/files/bom`)}>View BOM PDF</button>}
          {rights.can_update && <button type="button" className="btn btn-sm" onClick={onImport}>Paste from BOM</button>}
          {rights.can_update && <button type="button" className="btn btn-sm btn-primary" onClick={onAdd}>+ Add Item</button>}
        </div>
      </div>
      {items.length === 0 ? (
        <p className="muted">{p.files?.bom ? 'The BOM PDF is attached; no lines yet -- copy its text and use "Paste from BOM", or add items one by one.' : 'No BOM items.'}</p>
      ) : (
        <>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Section</th><th>Item</th><th>Qty</th><th style={{ width: 140 }}>Status</th><th>Done</th>{rights.can_delete && <th style={{ width: 60 }} />}</tr></thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id}>
                    <td className="muted" style={{ fontSize: 12 }}>{b.section}</td>
                    <td>{b.item}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{b.qty || ''}</td>
                    <td>
                      {rights.can_update ? (
                        <select value={b.status} disabled={busy}
                          onChange={(e) => { const s = e.target.value; call(() => api.patch(`${API}/projects/${p.id}/bom-items/${b.id}`, { status: s })); }}>
                          {Object.entries(BOM_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      ) : <span className={`badge ${b.status === 'done' ? 'badge-success' : b.status === 'ready' ? 'badge-info' : 'badge-muted'}`}>{BOM_LABEL[b.status]}</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{b.done_at ? displayDateTime(b.done_at) : '—'}</td>
                    {rights.can_delete && (
                      <td><button type="button" className="btn btn-sm btn-danger" disabled={busy}
                        onClick={() => window.confirm('Delete this BOM item?') && call(() => api.delete(`${API}/projects/${p.id}/bom-items/${b.id}`))}>✕</button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', margin: '10px 0 4px', fontSize: 12 }} className="muted">
            <span>Not Ready: {n('not_ready')} | Ready: {n('ready')} | Done: {n('done')}</span><span>{pct}% Done</span>
          </div>
          <ProgressBar value={pct} height={16} />
        </>
      )}
    </div>
  );
}

function BomAddModal({ id, onClose, onSaved }) {
  const [form, setForm] = useState({ item: '', qty: '', status: 'not_ready' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try { await api.post(`${API}/projects/${id}/bom-items`, form); onSaved(); } catch (err) { setError(errorOf(err)); setBusy(false); }
  }
  return (
    <Modal title="Add BOM Item" onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <form onSubmit={save}>
        <div className="field"><label>Item *</label>
          <textarea rows={3} required value={form.item} placeholder="Type the BOM item here..." onChange={(e) => setForm({ ...form, item: e.target.value })} /></div>
        <div className="filter-grid">
          <div className="field"><label>Qty</label><input value={form.qty} maxLength={60} placeholder="e.g. 12pcs" onChange={(e) => setForm({ ...form, qty: e.target.value })} /></div>
          <div className="field"><label>Status</label>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {Object.entries(BOM_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <div className="muted" style={{ fontSize: 12 }}>Done sets the Done date automatically.</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>Add Item</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// PLANNER read the BOM PDF's text on upload and split it into lines. Here the text is pasted (open the
// PDF, select all, copy) and the same cutting-list rules split it; Preview shows the lines first.
function BomImportModal({ id, hasItems, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function preview() {
    setError('');
    try { const { data } = await api.post(`${API}/projects/${id}/bom-items/import?preview=1`, { text }); setRows(data.rows); } catch (err) { setError(errorOf(err)); }
  }
  async function save() {
    setBusy(true);
    try { await api.post(`${API}/projects/${id}/bom-items/import`, { text, replace }); onSaved(); } catch (err) { setError(errorOf(err)); setBusy(false); }
  }
  return (
    <Modal title="Paste from BOM" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>Open the BOM / cutting list PDF, select all its text, copy, and paste it here. Lines with a quantity (pcs, pc, m, sqft) become items; CUTTING LIST, SCREWS, WIRINGS, LIGHTINGS, ELECTRICAL ASSEMBLY and POWER SUPPLY start sections.</p>
      <textarea rows={10} style={{ width: '100%' }} value={text} onChange={(e) => { setText(e.target.value); setRows(null); }} />
      {rows && (
        <div className="table-wrap" style={{ marginTop: 10, maxHeight: 300, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>Section</th><th>Item</th><th>Qty</th></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={3} className="muted">No lines found.</td></tr>
                : rows.map((r, i) => <tr key={i}><td className="muted" style={{ fontSize: 12 }}>{r.section}</td><td>{r.item}</td><td>{r.qty}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
      {hasItems && (
        <Check checked={replace} onChange={setReplace} style={{ display: 'flex', marginTop: 8 }}>Replace the BOM items already on this project</Check>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn" disabled={!text.trim()} onClick={preview}>Preview</button>
        <button type="button" className="btn btn-primary" disabled={busy || !rows?.length} onClick={save}>Add {rows?.length || ''} item(s)</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function UpdateProgress({ id, onSaved, onError }) {
  const [percent, setPercent] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    onError('');
    try {
      await api.post(`${API}/projects/${id}/progress`, { percent: Number(percent), note, photo: photo ? await filePayload(photo) : null });
      setPercent(''); setNote(''); setPhoto(null); setInputKey((k) => k + 1);
      await onSaved();
    } catch (err) { onError(errorOf(err)); } finally { setBusy(false); }
  }
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Update Progress</h3>
      <form onSubmit={save}>
        <div className="filter-grid">
          <div className="field">
            <label>Progress Percentage *</label>
            <input type="number" min={0} max={100} required value={percent} onChange={(e) => setPercent(e.target.value)} />
            <div className="muted" style={{ fontSize: 12 }}>Adds to the current progress. 100% marks the project Done.</div>
          </div>
          <div className="field">
            <label>Upload Image</label>
            <input key={inputKey} type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files[0] || null)} />
          </div>
        </div>
        <div className="field"><label>Note</label><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Update'}</button>
      </form>
    </div>
  );
}

function History({ p, onView }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>Update History</h3>
        <span className="muted" style={{ fontSize: 12 }}>{p.updates.length} record(s)</span>
      </div>
      {p.updates.length === 0 ? <p className="muted">No progress updates yet.</p> : p.updates.map((u) => (
        <div key={u.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <strong>+{u.percent}%</strong>
              <div className="muted" style={{ fontSize: 12 }}>{displayDateTime(u.created_at)} · {u.created_by_name || '—'}</div>
            </div>
            {Number(u.has_photo) ? <button type="button" className="btn btn-sm" onClick={() => onView(`${API}/projects/${p.id}/progress/${u.id}/photo`)}>View Photo</button> : null}
          </div>
          {u.note && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{u.note}</div>}
        </div>
      ))}
    </div>
  );
}
