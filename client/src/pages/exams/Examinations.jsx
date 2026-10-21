import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/useAuth';
import { ORIENTATION_BADGE, ORIENTATION_LABELS, TYPES, TYPE_LABELS, fmtDay, pct } from '../../utils/exams';

// HRD > Examinations (2026-10-21; routes/examAdmin.js). HR builds exam SETS from the departments'
// question banks, SCHEDULES a set for departments and/or people over a date window (each examinee
// gets it in their own shuffled order), reads the results by topic, and follows RE-ORIENTATION
// through to "attended on date X".
const ROUTE = '/hrd/exams';
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const WINDOW_BADGE = { open: 'badge-success', upcoming: 'badge-info', closed: 'badge-muted', cancelled: 'badge-danger' };

// ---------------------------------------------------------------- Sets

function SetEditor({ meta, setId, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', department_id: '', description: '', time_limit_minutes: '', passing_percent: 75, reorient_below_percent: 60 });
  const [selected, setSelected] = useState([]);
  const [locked, setLocked] = useState(false);
  const [pool, setPool] = useState([]);
  const [f, setF] = useState({ department_id: '', topic_id: '', type: '', q: '' });
  const [randomN, setRandomN] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!setId) return;
    api.get(`/exam-admin/sets/${setId}`).then(({ data }) => {
      setForm({
        name: data.name, department_id: data.department_id || '', description: data.description || '', time_limit_minutes: data.time_limit_minutes || '',
        passing_percent: Number(data.passing_percent), reorient_below_percent: Number(data.reorient_below_percent),
      });
      setSelected(data.questions.map((q) => ({ id: q.id, question: q.question, type: q.type, topic: q.topic, department: q.department, points: q.points })));
      setLocked(data.locked);
      setF((x) => ({ ...x, department_id: data.department_id || '' }));
    }).catch((e) => setError(e.response?.data?.error || 'Could not load the set.'));
  }, [setId]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get('/exam-admin/question-pool', { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })
        .then(({ data }) => setPool(data)).catch(() => setPool([]));
    }, 250);
    return () => clearTimeout(t);
  }, [f]);

  const chosen = new Set(selected.map((q) => q.id));
  const available = pool.filter((q) => !chosen.has(q.id));
  const add = (list) => setSelected((s) => [...s, ...list.filter((q) => !s.some((x) => x.id === q.id))]);
  const addRandom = () => {
    const a = [...available];
    for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    add(a.slice(0, Math.max(0, Number(randomN) || 0)));
  };
  const byTopic = useMemo(() => {
    const m = new Map();
    selected.forEach((q) => { const k = q.topic || 'General'; const v = m.get(k) || { n: 0, pts: 0 }; v.n += 1; v.pts += Number(q.points); m.set(k, v); });
    return [...m.entries()];
  }, [selected]);
  const topics = meta.topics.filter((t) => !f.department_id || !t.department_id || Number(t.department_id) === Number(f.department_id));

  async function save() {
    setBusy(true); setError('');
    try {
      const body = { ...form, question_ids: selected.map((q) => q.id) };
      if (setId) await api.put(`/exam-admin/sets/${setId}`, body); else await api.post('/exam-admin/sets', body);
      onSaved();
    } catch (e) { setError(e.response?.data?.error || 'Could not save the set.'); }
    finally { setBusy(false); }
  }

  const s = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal title={setId ? 'Edit Exam Set' : 'New Exam Set'} onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      {locked && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>This set has already been taken: its questions and passing score are fixed. Make a new set to change them.</div>}
      <div className="filter-grid">
        <div className="field"><label>Set Name</label><input value={form.name} onChange={s('name')} placeholder="e.g. SET 1 -- Production" /></div>
        <div className="field"><label>Department (optional)</label>
          <select value={form.department_id} onChange={(e) => { s('department_id')(e); setF((x) => ({ ...x, department_id: e.target.value, topic_id: '' })); }}>
            <option value="">Mixed / any</option>
            {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
        <div className="field"><label>Time Limit (minutes)</label><input type="number" min="1" value={form.time_limit_minutes} onChange={s('time_limit_minutes')} placeholder="None" /></div>
        <div className="field"><label>Passing %</label><input type="number" min="1" max="100" value={form.passing_percent} disabled={locked} onChange={s('passing_percent')} /></div>
        <div className="field"><label>Re-orient below % (per topic)</label><input type="number" min="0" max="100" value={form.reorient_below_percent} onChange={s('reorient_below_percent')} /></div>
      </div>
      <div className="field"><label>Instructions (shown before the exam starts)</label><textarea rows={2} value={form.description} onChange={s('description')} /></div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginTop: 8 }}>
        <div>
          <h3 style={{ margin: '4px 0' }}>Question Bank</h3>
          <div className="filter-grid">
            <div className="field"><label>Department</label>
              <select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value, topic_id: '' })}>
                <option value="">All</option>
                {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select></div>
            <div className="field"><label>Topic</label>
              <select value={f.topic_id} onChange={(e) => setF({ ...f, topic_id: e.target.value })}>
                <option value="">All</option>
                {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select></div>
            <div className="field"><label>Type</label>
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                <option value="">All</option>
                {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select></div>
            <div className="field"><label>Search</label><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
          </div>
          {!locked && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0', flexWrap: 'wrap' }}>
              <button className="btn btn-sm" disabled={!available.length} onClick={() => add(available)}>Add all {available.length}</button>
              <span className="muted">or</span>
              <input type="number" min="1" value={randomN} onChange={(e) => setRandomN(e.target.value)} style={{ width: 70 }} />
              <button className="btn btn-sm" disabled={!available.length} onClick={addRandom}>Add random from these</button>
            </div>
          )}
          <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--border, #e5e7eb)', borderRadius: 6 }}>
            {available.length === 0 && <div className="muted" style={{ padding: 10 }}>No more questions match.</div>}
            {available.map((q) => (
              <div key={q.id} style={{ display: 'flex', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--border, #f1f5f9)' }}>
                {!locked && <button className="btn btn-sm" onClick={() => add([q])}>+</button>}
                <div style={{ fontSize: 13 }}>{q.question}<div className="muted" style={{ fontSize: 11 }}>{TYPE_LABELS[q.type]} · {q.topic || 'General'} · {q.department} · {q.points} pt</div></div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 style={{ margin: '4px 0' }}>In this set: {selected.length} question(s), {selected.reduce((m, q) => m + Number(q.points), 0)} pts</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{byTopic.map(([t, v]) => `${t}: ${v.n}`).join(' · ') || 'Add questions from the bank.'}</div>
          <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--border, #e5e7eb)', borderRadius: 6 }}>
            {selected.map((q, i) => (
              <div key={q.id} style={{ display: 'flex', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--border, #f1f5f9)' }}>
                <strong style={{ width: 24 }}>{i + 1}.</strong>
                <div style={{ fontSize: 13, flex: 1 }}>{q.question}<div className="muted" style={{ fontSize: 11 }}>{TYPE_LABELS[q.type]} · {q.topic || 'General'} · {q.points} pt</div></div>
                {!locked && <button className="btn btn-sm" onClick={() => setSelected(selected.filter((x) => x.id !== q.id))}>✕</button>}
              </div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Each examinee gets these in their own shuffled order.</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}><button className="btn btn-primary" disabled={busy} onClick={save}>Save Set</button></div>
    </Modal>
  );
}

function SetsTab({ meta }) {
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => api.get('/exam-admin/sets').then(({ data }) => setRows(data)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  async function remove(r) {
    if (!window.confirm(`Remove ${r.name}? Its schedules and results stay.`)) return;
    await api.delete(`/exam-admin/sets/${r.id}`); load();
  }
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setEditing({})}>New Exam Set</button>}
      </div>
      {!rows ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Set</th><th>Department</th><th>Questions</th><th>Points</th><th>Time Limit</th><th>Passing</th><th>Re-orient below</th><th>Scheduled</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No exam sets yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Set" style={{ fontWeight: 600 }}>{r.name}</td>
                  <td data-label="Department">{r.department || 'Mixed'}</td>
                  <td data-label="Questions">{r.question_count}</td>
                  <td data-label="Points">{r.total_points}</td>
                  <td data-label="Time Limit">{r.time_limit_minutes ? `${r.time_limit_minutes} min` : 'None'}</td>
                  <td data-label="Passing">{pct(r.passing_percent)}</td>
                  <td data-label="Re-orient below">{pct(r.reorient_below_percent)}</td>
                  <td data-label="Scheduled">{r.schedule_count}×</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" onClick={() => setEditing({ id: r.id })}>{can(ROUTE, 'can_edit') ? 'Edit' : 'View'}</button>{' '}
                    {can(ROUTE, 'can_delete') && <button className="btn btn-sm" onClick={() => remove(r)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <SetEditor meta={meta} setId={editing.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Schedules

// Departments and/or people -- used by New Schedule and Add Examinees.
export function TargetPicker({ meta, departmentIds, setDepartmentIds, userIds, setUserIds }) {
  const users = meta.users.map((u) => ({ ...u, department: u.department || '' }));
  return (
    <>
      <div className="field"><label>Departments -- everyone in them gets the exam</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', maxHeight: 160, overflow: 'auto' }}>
          {meta.departments.map((d) => (
            <label key={d.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
              <input type="checkbox" checked={departmentIds.includes(d.id)}
                onChange={(e) => setDepartmentIds(e.target.checked ? [...departmentIds, d.id] : departmentIds.filter((x) => x !== d.id))} />
              {d.label}
            </label>
          ))}
        </div></div>
      <div className="field"><label>People</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {userIds.map((id) => {
            const u = users.find((x) => x.id === id);
            return <span key={id} className="badge badge-info">{u?.display_name || id} <button type="button" className="link-btn" onClick={() => setUserIds(userIds.filter((x) => x !== id))}>✕</button></span>;
          })}
        </div>
        <EntityPicker
          items={users.filter((u) => !userIds.includes(u.id))} value="" triggerLabel="+ Add a person"
          getLabel={(u) => u.display_name} searchKeys={['display_name', 'department']}
          columns={[{ key: 'display_name', label: 'Name' }, { key: 'department', label: 'Department' }]}
          onSelect={(u) => setUserIds([...userIds, u.id])}
        />
      </div>
    </>
  );
}

function ScheduleModal({ meta, onClose, onSaved }) {
  const [sets, setSets] = useState([]);
  const [form, setForm] = useState({ set_id: '', title: '', start_date: today(), end_date: '' });
  const [departmentIds, setDepartmentIds] = useState([]);
  const [userIds, setUserIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/exam-admin/sets').then(({ data }) => setSets(data)).catch(() => {}); }, []);
  const monthEnd = () => { const d = new Date(`${form.start_date}T00:00:00`); return new Date(d.getFullYear(), d.getMonth() + 1, 0).toLocaleDateString('en-CA'); };

  async function save() {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/exam-admin/schedules', { ...form, department_ids: departmentIds, user_ids: userIds });
      onSaved(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not schedule the exam.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Schedule an Exam" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div className="filter-grid">
        <div className="field"><label>Exam Set</label>
          <select value={form.set_id} onChange={(e) => setForm({ ...form, set_id: e.target.value, title: form.title || sets.find((x) => String(x.id) === e.target.value)?.name || '' })}>
            <option value="">-- pick --</option>
            {sets.map((st) => <option key={st.id} value={st.id}>{st.name} ({st.question_count} q)</option>)}
          </select></div>
        <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Q4 Production Exam" /></div>
        <div className="field"><label>Opens</label><input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
        <div className="field"><label>Must be done by</label>
          <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          <button type="button" className="link-btn" style={{ fontSize: 11 }} onClick={() => setForm({ ...form, end_date: monthEnd() })}>End of that month</button></div>
      </div>
      <TargetPicker meta={meta} departmentIds={departmentIds} setDepartmentIds={setDepartmentIds} userIds={userIds} setUserIds={setUserIds} />
      <div className="muted" style={{ fontSize: 12 }}>Everyone gets the same set, each in their own shuffled order, and is notified.</div>
      <div style={{ marginTop: 12 }}><button className="btn btn-primary" disabled={busy} onClick={save}>Schedule</button></div>
    </Modal>
  );
}

function SchedulesTab({ meta }) {
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.get('/exam-admin/schedules').then(({ data }) => setRows(data)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setCreating(true)}>Schedule an Exam</button>}
      </div>
      {!rows ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Exam</th><th>Set</th><th>Window</th><th>For</th><th>Assigned</th><th>Submitted</th><th>Missed</th><th>Passed</th><th>Average</th><th>To Grade</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No exams scheduled yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Exam" style={{ fontWeight: 600 }}>{r.title}{r.retake_of_attempt_id ? <span className="badge badge-muted" style={{ marginLeft: 4 }}>Retake</span> : null}</td>
                  <td data-label="Set">{r.set_name}</td>
                  <td data-label="Window">{fmtDay(r.start_date)} — {fmtDay(r.end_date)} <span className={`badge ${WINDOW_BADGE[r.window]}`}>{r.window}</span></td>
                  <td data-label="For" style={{ maxWidth: 220, whiteSpace: 'normal' }}>{r.targets}</td>
                  <td data-label="Assigned">{r.assigned}</td>
                  <td data-label="Submitted">{Number(r.submitted || 0)}{Number(r.in_progress) ? <span className="muted"> (+{r.in_progress} taking)</span> : ''}</td>
                  <td data-label="Missed">{Number(r.missed || 0)}</td>
                  <td data-label="Passed">{Number(r.passed || 0)}</td>
                  <td data-label="Average">{pct(r.avg_percent)}</td>
                  <td data-label="To Grade">{Number(r.to_grade) ? <span className="badge badge-warning">{r.to_grade}</span> : '—'}</td>
                  <td><Link className="btn btn-sm btn-primary" to={`/hrd/exams/schedules/${r.id}`}>Results</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <ScheduleModal meta={meta} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Re-orientation

function OrientationTab() {
  const { can } = useAuth();
  const [status, setStatus] = useState('recommended');
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/exam-admin/orientations', { params: { status: status || undefined } })
    .then(({ data: d }) => setData(d)).catch(() => setData({ rows: [], counts: {} })), [status]);
  useEffect(() => { load(); }, [load]);

  async function save(o, patch) {
    setError('');
    try { await api.put(`/exam-admin/orientations/${o.id}`, { ...o, ...patch }); setEditing(null); load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
  }

  return (
    <div className="card">
      {error && <div className="error-banner">{error}</div>}
      <div className="status-tabs" style={{ marginBottom: 12 }}>
        {[...Object.entries(ORIENTATION_LABELS), ['', 'All']].map(([k, label]) => (
          <button key={k || 'all'} type="button" className={`status-tab ${status === k ? 'active' : ''}`} onClick={() => setStatus(k)}>
            {label} {k && <span className="badge badge-muted" style={{ marginLeft: 4 }}>{data?.counts?.[k] ?? 0}</span>}
          </button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Recommended when an examinee scores under the set&apos;s re-orientation line in a topic. Schedule it, then mark it attended. A retake is scheduled from the examinee&apos;s result.
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Employee</th><th>Department</th><th>Orientation</th><th>Topic Score</th><th>From Exam</th><th>Status</th><th>Scheduled</th><th>Attended</th><th>Notes</th><th /></tr></thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing here.</td></tr>}
              {data.rows.map((o) => (
                <tr key={o.id}>
                  <td data-label="Employee" style={{ fontWeight: 600 }}>{o.name}</td>
                  <td data-label="Department">{o.department}</td>
                  <td data-label="Orientation">{o.orientation_name || `${o.topic} Orientation`}<div className="muted" style={{ fontSize: 11 }}>{o.topic}</div></td>
                  <td data-label="Topic Score" style={{ color: 'var(--danger, #b91c1c)', fontWeight: 600 }}>{pct(o.topic_percent)}</td>
                  <td data-label="From Exam"><Link className="link-btn" to={`/hrd/exams/attempts/${o.attempt_id}`}>{o.exam_title}</Link> <span className="muted">({pct(o.exam_percent)})</span></td>
                  <td data-label="Status"><span className={`badge ${ORIENTATION_BADGE[o.status]}`}>{ORIENTATION_LABELS[o.status]}</span>
                    {o.retake_schedule_id && <div><Link className="link-btn" style={{ fontSize: 11 }} to={`/hrd/exams/schedules/${o.retake_schedule_id}`}>retake scheduled</Link></div>}</td>
                  <td data-label="Scheduled">{fmtDay(o.scheduled_date) || '—'}</td>
                  <td data-label="Attended">{fmtDay(o.attended_date) || '—'}</td>
                  <td data-label="Notes" style={{ maxWidth: 180, whiteSpace: 'normal' }}>{o.notes}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {can(ROUTE, 'can_edit') && o.status !== 'attended' && (
                      <>
                        <button className="btn btn-sm" onClick={() => setEditing({ o, mode: 'scheduled', date: o.scheduled_date ? String(o.scheduled_date).slice(0, 10) : today(), notes: o.notes || '' })}>Schedule</button>{' '}
                        <button className="btn btn-sm btn-primary" onClick={() => setEditing({ o, mode: 'attended', date: today(), notes: o.notes || '' })}>Attended</button>{' '}
                        {o.status !== 'dismissed' && <button className="btn btn-sm" onClick={() => setEditing({ o, mode: 'dismissed', date: '', notes: o.notes || '' })}>Dismiss</button>}
                      </>
                    )}
                    {can(ROUTE, 'can_edit') && o.status === 'attended' && <button className="btn btn-sm" onClick={() => setEditing({ o, mode: 'attended', date: String(o.attended_date).slice(0, 10), notes: o.notes || '' })}>Edit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal title={`${editing.o.name} -- ${editing.o.orientation_name || editing.o.topic}`} onClose={() => setEditing(null)}>
          {editing.mode !== 'dismissed' && (
            <div className="field"><label>{editing.mode === 'attended' ? 'Attended on' : 'Orientation date'}</label>
              <input type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} /></div>
          )}
          <div className="field"><label>Notes</label><textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></div>
          <button className="btn btn-primary" onClick={() => save(editing.o, {
            status: editing.mode, notes: editing.notes,
            ...(editing.mode === 'scheduled' ? { scheduled_date: editing.date } : {}),
            ...(editing.mode === 'attended' ? { attended_date: editing.date } : {}),
          })}>{editing.mode === 'dismissed' ? 'Dismiss' : 'Save'}</button>
        </Modal>
      )}
    </div>
  );
}

const TABS = [['schedules', 'Schedules & Results'], ['sets', 'Exam Sets'], ['orientation', 'Re-orientation']];

export default function Examinations() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'schedules';
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/exam-admin/meta').then(({ data }) => setMeta(data)).catch((e) => setError(e.response?.data?.error || 'Could not load.')); }, []);
  return (
    <div>
      <div className="page-header">
        <h1>Examinations</h1>
        <Link className="btn" to="/hrd/exam-questions">Question Bank</Link>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="status-tabs" style={{ marginBottom: 12 }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setParams({ tab: k })}>{label}</button>
        ))}
      </div>
      {!meta ? <LoadingSpinner /> : (
        <>
          {tab === 'schedules' && <SchedulesTab meta={meta} />}
          {tab === 'sets' && <SetsTab meta={meta} />}
          {tab === 'orientation' && <OrientationTab />}
        </>
      )}
    </div>
  );
}
