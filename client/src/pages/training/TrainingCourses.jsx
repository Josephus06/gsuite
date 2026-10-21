import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/useAuth';
import { download, fmtDay, pct } from '../../utils/exams';
import { TargetPicker } from '../exams/Examinations';

// HRD > Training Courses (2026-10-21; routes/training.js): HR's side of the courses -- the list,
// the course editor (instructions, learning-material files, quizzes from Examinations' exam sets),
// assigning it to departments / people over a date window, and each assignment's progress.
const ROUTE = '/hrd/training';
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const QUIZ_STATE = {
  passed: ['badge-success', 'Passed'], failed: ['badge-danger', 'Failed'], grading: ['badge-warning', 'Grading'],
  in_progress: ['badge-info', 'Taking'], not_taken: ['badge-muted', '—'], missed: ['badge-danger', 'Missed'],
};

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function TrainingCourses() {
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/training/courses').then(({ data }) => setRows(data)).catch(() => setRows([])); }, []);
  return (
    <div>
      <div className="page-header">
        <h1>Training Courses</h1>
        {can(ROUTE, 'can_add') && <Link className="btn btn-primary" to="/hrd/training/courses/new">New Course</Link>}
      </div>
      <div className="card">
        {!rows ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Course</th><th>Department</th><th>Materials</th><th>Quizzes</th><th>Enrolled</th><th>Completed</th><th /></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No courses yet.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Course" style={{ fontWeight: 600 }}>{r.title}</td>
                    <td data-label="Department">{r.department || 'Any'}</td>
                    <td data-label="Materials">{r.materials}</td>
                    <td data-label="Quizzes">{r.quizzes}</td>
                    <td data-label="Enrolled">{r.enrolled}</td>
                    <td data-label="Completed">{r.completed}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/hrd/training/courses/${r.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function CourseEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { can } = useAuth();
  const [form, setForm] = useState({ title: '', description: '', department_id: '', quizzes: [] });
  const [course, setCourse] = useState(null);
  const [meta, setMeta] = useState(null);
  const [sets, setSets] = useState([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [assigning, setAssigning] = useState(null);
  const [departmentIds, setDepartmentIds] = useState([]);
  const [userIds, setUserIds] = useState([]);
  const canEdit = can(ROUTE, isNew ? 'can_add' : 'can_edit');

  const load = useCallback(() => {
    if (isNew) return;
    api.get(`/training/courses/${id}`).then(({ data }) => {
      setCourse(data);
      setForm({ title: data.title, description: data.description || '', department_id: data.department_id || '',
        quizzes: data.quizzes.map((q) => ({ set_id: String(q.set_id), instructions: q.instructions || '' })) });
    }).catch((e) => setError(e.response?.data?.error || 'Could not load the course.'));
  }, [id, isNew]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/exam-admin/meta').then(({ data }) => setMeta(data)).catch(() => setMeta({ departments: [], users: [] }));
    api.get('/exam-admin/sets').then(({ data }) => setSets(data)).catch(() => {});
  }, []);

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (isNew) {
        const { data } = await api.post('/training/courses', form);
        navigate(`/hrd/training/courses/${data.id}`, { replace: true });
      } else {
        await api.put(`/training/courses/${id}`, form);
        setNotice('Course saved.'); load();
      }
    } catch (e) { setError(e.response?.data?.error || 'Could not save the course.'); }
    finally { setBusy(false); }
  }

  async function upload(files) {
    setError('');
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { setError(`${f.name} is over 25MB.`); continue; }
      setUploading(f.name);
      try { await api.post(`/training/courses/${id}/materials`, { file_name: f.name, file_data: await readFile(f) }); }
      catch (e) { setError(e.response?.data?.error || `Could not upload ${f.name}.`); }
    }
    setUploading('');
    load();
  }
  async function material(m, patch) {
    try { await api.put(`/training/materials/${m.id}`, { title: m.title, description: m.description, ...patch }); load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not update the material.'); }
  }
  async function removeMaterial(m) {
    if (!window.confirm(`Take "${m.title}" off the course?`)) return;
    await api.delete(`/training/materials/${m.id}`); load();
  }
  async function assign() {
    setBusy(true); setError('');
    try {
      const { data } = await api.post(`/training/courses/${id}/assign`, { ...assigning, department_ids: departmentIds, user_ids: userIds });
      setAssigning(null); setNotice(`Assigned to ${data.enrolled} employee(s).`); load();
    } catch (e) { setError(e.response?.data?.error || 'Could not assign the course.'); }
    finally { setBusy(false); }
  }

  if (!isNew && !course) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const setQ = (i, patch) => setForm((f) => ({ ...f, quizzes: f.quizzes.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));
  const monthEnd = (d) => { const x = new Date(`${d}T00:00:00`); return new Date(x.getFullYear(), x.getMonth() + 1, 0).toLocaleDateString('en-CA'); };

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'New Course' : course.title}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/hrd/training">Back</Link>
          {!isNew && can(ROUTE, 'can_add') && (
            <button className="btn btn-sm btn-primary" onClick={() => { setDepartmentIds([]); setUserIds([]); setAssigning({ start_date: today(), end_date: '' }); }}>Assign Course</button>
          )}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid var(--success, #16a34a)' }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>Course Title</label><input value={form.title} disabled={!canEdit} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Human Resource Management" /></div>
          <div className="field"><label>Department (optional)</label>
            <select value={form.department_id} disabled={!canEdit} onChange={(e) => setForm({ ...form, department_id: e.target.value })}>
              <option value="">Any</option>
              {(meta?.departments || []).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
        </div>
        <div className="field"><label>About the course / instructions</label>
          <textarea rows={4} value={form.description} disabled={!canEdit} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>

        <h3 style={{ marginBottom: 6 }}>Quizzes</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Exam sets from HRD &gt; Examinations. Each is taken on the usual exam screen; passing all of them (with every material completed) completes the course.</div>
        {form.quizzes.map((q, i) => (
          <div key={i} className="card" style={{ marginBottom: 8, padding: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={q.set_id} disabled={!canEdit} onChange={(e) => setQ(i, { set_id: e.target.value })} style={{ minWidth: 260 }}>
                <option value="">-- pick an exam set --</option>
                {sets.map((st) => <option key={st.id} value={st.id}>{st.name} ({st.question_count} q, pass {pct(st.passing_percent)})</option>)}
              </select>
              {canEdit && <button className="btn btn-sm" onClick={() => setForm({ ...form, quizzes: form.quizzes.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
            <textarea rows={3} style={{ width: '100%', marginTop: 6 }} disabled={!canEdit} value={q.instructions} onChange={(e) => setQ(i, { instructions: e.target.value })}
              placeholder={'Instructions shown before the quiz, e.g.\nDear Participant, the Quiz has 5 multiple-choice questions...'} />
          </div>
        ))}
        {canEdit && <button className="btn btn-sm" onClick={() => setForm({ ...form, quizzes: [...form.quizzes, { set_id: '', instructions: '' }] })}>+ Quiz</button>}
        {canEdit && <div style={{ marginTop: 12 }}><button className="btn btn-primary" disabled={busy} onClick={save}>{isNew ? 'Create Course' : 'Save'}</button></div>}
      </div>

      {!isNew && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>Learning Materials</h3>
            {canEdit && (
              <label className="btn btn-sm btn-primary" style={{ cursor: 'pointer' }}>
                {uploading ? `Uploading ${uploading}…` : '+ Upload Files'}
                <input type="file" multiple style={{ display: 'none' }} disabled={!!uploading}
                  onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) upload(fs); }} />
              </label>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>PDF, Word, PowerPoint, Excel or pictures, up to 25MB each. PDFs and pictures open inside the course; other files download. Employees mark each one Completed.</div>
          {course.materials.length === 0 && <div className="muted">No materials yet.</div>}
          {course.materials.map((m, i) => (
            <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border, #e5e7eb)', flexWrap: 'wrap' }}>
              <strong style={{ width: 24 }}>{i + 1}.</strong>
              <div style={{ flex: 1, minWidth: 220 }}>
                {canEdit ? <input defaultValue={m.title} onBlur={(e) => e.target.value.trim() && e.target.value !== m.title && material(m, { title: e.target.value })} />
                  : <strong>{m.title}</strong>}
                <div className="muted" style={{ fontSize: 11 }}>{m.file_name} · {size(m.file_size)}</div>
              </div>
              <button className="btn btn-sm" onClick={() => download(`/training/materials/${m.id}/file`, m.file_name)}>Download</button>
              {canEdit && <>
                <button className="btn btn-sm" disabled={i === 0} onClick={() => material(m, { move: 'up' })}>↑</button>
                <button className="btn btn-sm" disabled={i === course.materials.length - 1} onClick={() => material(m, { move: 'down' })}>↓</button>
                <button className="btn btn-sm" onClick={() => removeMaterial(m)}>Remove</button>
              </>}
            </div>
          ))}
        </div>
      )}

      {!isNew && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Assignments</h3>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Window</th><th>For</th><th>Enrolled</th><th>Completed</th><th>Status</th><th /></tr></thead>
              <tbody>
                {course.assignments.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>Not assigned yet.</td></tr>}
                {course.assignments.map((a) => (
                  <tr key={a.id}>
                    <td data-label="Window">{fmtDay(a.start_date)} — {fmtDay(a.end_date)}</td>
                    <td data-label="For" style={{ maxWidth: 260, whiteSpace: 'normal' }}>{a.targets}</td>
                    <td data-label="Enrolled">{a.enrolled}</td>
                    <td data-label="Completed">{Number(a.completed || 0)}</td>
                    <td data-label="Status">{a.status === 'cancelled' ? <span className="badge badge-danger">Cancelled</span> : <span className="badge badge-success">Active</span>}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/hrd/training/assignments/${a.id}`}>Progress</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {assigning && meta && (
        <Modal title={`Assign: ${course.title}`} onClose={() => setAssigning(null)} large>
          <div className="filter-grid">
            <div className="field"><label>Opens</label><input type="date" value={assigning.start_date} onChange={(e) => setAssigning({ ...assigning, start_date: e.target.value })} /></div>
            <div className="field"><label>Must be done by</label>
              <input type="date" value={assigning.end_date} onChange={(e) => setAssigning({ ...assigning, end_date: e.target.value })} />
              <button type="button" className="link-btn" style={{ fontSize: 11 }} onClick={() => setAssigning({ ...assigning, end_date: monthEnd(assigning.start_date) })}>End of that month</button></div>
          </div>
          <TargetPicker meta={meta} departmentIds={departmentIds} setDepartmentIds={setDepartmentIds} userIds={userIds} setUserIds={setUserIds} />
          <div className="muted" style={{ fontSize: 12 }}>Everyone gets the materials and the quizzes (each quiz is scheduled for the same window) and is notified.</div>
          <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={assign}>Assign</button>
        </Modal>
      )}
    </div>
  );
}

export function AssignmentProgress() {
  const { id } = useParams();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/training/assignments/${id}`).then(({ data: d }) => setData(d))
    .catch((e) => setError(e.response?.data?.error || 'Could not load.')), [id]);
  useEffect(() => { load(); }, [load]);
  async function cancel() {
    if (!window.confirm('Cancel this assignment? Its quizzes are cancelled too.')) return;
    await api.post(`/training/assignments/${id}/cancel`); load();
  }
  if (!data) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const a = data.assignment;
  const done = data.rows.filter((r) => r.completed_at).length;
  return (
    <div>
      <div className="page-header">
        <h1>{a.title} <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>{fmtDay(a.start_date)} — {fmtDay(a.end_date)}</span></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={`/hrd/training/courses/${a.course_id}`}>Back to Course</Link>
          {a.status === 'active' && can(ROUTE, 'can_delete') && <button className="btn btn-sm" onClick={cancel}>Cancel Assignment</button>}
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <span>For: {data.targets.map((t) => t.department || t.user).join(', ')}</span>
          <span>Enrolled <strong>{data.rows.length}</strong></span>
          <span>Completed <strong>{done}</strong></span>
          {a.status === 'cancelled' && <span className="badge badge-danger">Cancelled</span>}
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Employee</th><th>Department</th><th>Materials</th>
                {data.quizzes.map((q) => <th key={q.id}>{q.name}</th>)}
                <th style={{ textAlign: 'right' }}>Progress</th><th>Completed</th><th /></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}><Link className="link-btn" to={`/hrd/exams/employees/${r.user_id}`}>{r.name}</Link></td>
                  <td>{r.department}</td>
                  <td>{r.materials_done} / {r.materials}</td>
                  {r.quizzes.map((q) => {
                    const [cls, label] = QUIZ_STATE[q.state] || QUIZ_STATE.not_taken;
                    return (
                      <td key={q.id}>
                        {q.attempt_id && q.state !== 'not_taken' ? <Link to={`/hrd/exams/attempts/${q.attempt_id}`}><span className={`badge ${cls}`}>{label}</span></Link>
                          : <span className={`badge ${cls}`}>{label}</span>}
                        {q.percent != null && <span style={{ marginLeft: 4 }}>{pct(q.percent)}</span>}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.percent}%</td>
                  <td>{r.completed_at ? fmtDay(r.completed_at) : '—'}</td>
                  <td>{r.completed_at && <button className="btn btn-sm" onClick={() => download(`/training/enrollments/${r.id}/certificate-hr`, `certificate-${r.name}.pdf`)}>Certificate</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
