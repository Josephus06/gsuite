import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/useAuth';
import {
  CHOICE_TYPES, LETTERS, ORIENTATION_BADGE, ORIENTATION_LABELS, STATUS_BADGE, STATUS_LABELS, TYPE_LABELS,
  answerText, download, fmtDay, fmtWhen, indexed, pct,
} from '../../utils/exams';
import QuestionImage from './QuestionImage';
import { TargetPicker } from './Examinations';

// HRD > Examinations results (2026-10-21; routes/examAdmin.js): one schedule's examinees by topic,
// and one examinee's full result -- with the answer key, essay grading, the AI evaluation and the
// re-orientation it recommends.
const ROUTE = '/hrd/exams';
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

function AiText({ text }) {
  return <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{text}</div>;
}

export function ScheduleResults() {
  const { id } = useParams();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [adding, setAdding] = useState(false);
  const [departmentIds, setDepartmentIds] = useState([]);
  const [userIds, setUserIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.get(`/exam-admin/schedules/${id}`).then(({ data: d }) => setData(d))
    .catch((e) => setError(e.response?.data?.error || 'Could not load the results.')), [id]);
  useEffect(() => { load(); }, [load]);

  async function aiSummary() {
    setBusy(true); setError('');
    try { const { data: r } = await api.post(`/exam-admin/schedules/${id}/ai-summary`); setData((d) => ({ ...d, schedule: { ...d.schedule, ai_summary: r.ai_summary } })); }
    catch (e) { setError(e.response?.data?.error || 'The AI could not summarize this exam.'); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!window.confirm('Cancel this schedule? It disappears from everyone\'s My Exams.')) return;
    await api.post(`/exam-admin/schedules/${id}/cancel`); load();
  }
  async function openAdd() {
    if (!meta) { const { data: m } = await api.get('/exam-admin/meta'); setMeta(m); }
    setDepartmentIds([]); setUserIds([]); setAdding(true);
  }
  async function saveAdd() {
    setBusy(true); setError('');
    try { await api.post(`/exam-admin/schedules/${id}/targets`, { department_ids: departmentIds, user_ids: userIds }); setAdding(false); load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not add them.'); }
    finally { setBusy(false); }
  }

  if (!data) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const s = data.schedule;
  const line = Number(s.reorient_below_percent);
  const done = data.attempts.filter((a) => a.status === 'submitted');
  const open = s.status === 'active' && String(s.end_date).slice(0, 10) >= today();

  return (
    <div>
      <div className="page-header">
        <h1>{s.title} <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>{s.set_name}</span></h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/hrd/exams">Back</Link>
          <button className="btn btn-sm" onClick={() => download(`/exam-admin/schedules/${id}/export`, `exam-results-${id}.xlsx`).catch(() => setError('Could not export.'))}>Export Excel</button>
          {open && can(ROUTE, 'can_add') && <button className="btn btn-sm" onClick={openAdd}>Add Examinees</button>}
          {s.status === 'active' && can(ROUTE, 'can_delete') && <button className="btn btn-sm" onClick={cancel}>Cancel Schedule</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <span>{fmtDay(s.start_date)} — {fmtDay(s.end_date)}{s.status === 'cancelled' && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Cancelled</span>}</span>
          <span>For: {data.targets.map((t) => t.department || t.user).join(', ')}</span>
          <span>Assigned <strong>{data.attempts.length}</strong></span>
          <span>Submitted <strong>{done.length}</strong></span>
          <span>Passed <strong>{done.filter((a) => Number(a.passed) === 1).length}</strong> (passing {pct(s.passing_percent)})</span>
          <span>Re-orient below <strong>{pct(line)}</strong> in a topic</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>AI Summary</h3>
          <button className="btn btn-sm btn-primary" disabled={busy || !done.length} onClick={aiSummary}>{s.ai_summary ? 'Refresh' : 'Generate'}</button>
        </div>
        <div style={{ marginTop: 8 }}>
          {s.ai_summary ? <AiText text={s.ai_summary} /> : <span className="muted">Where the group is weak and who needs re-orientation, once people have submitted.</span>}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Results by Topic</h3>
        <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 8 }}>Red: under the re-orientation line -- that orientation is recommended.</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Status</th><th style={{ textAlign: 'right' }}>Score</th><th style={{ textAlign: 'right' }}>%</th>
                {data.topics.map((t) => <th key={t.topic_id || 0} style={{ textAlign: 'right' }}>{t.topic}</th>)}
                <th style={{ textAlign: 'right' }} title="Times the examinee left the exam tab">Left tab</th><th />
              </tr>
            </thead>
            <tbody>
              {data.attempts.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}><Link className="link-btn" to={`/hrd/exams/employees/${a.user_id}`}>{a.name}</Link></td>
                  <td>{a.department}</td>
                  <td><span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABELS[a.status]}</span>
                    {a.essays_pending > 0 && <span className="badge badge-warning" style={{ marginLeft: 4 }}>{a.essays_pending} to grade</span>}</td>
                  <td style={{ textAlign: 'right' }}>{a.status === 'submitted' ? `${a.score} / ${a.max_score}` : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{a.status === 'submitted'
                    ? <span style={{ color: Number(a.passed) === 0 ? 'var(--danger, #b91c1c)' : undefined }}>{pct(a.percent)}</span> : '—'}</td>
                  {data.topics.map((t) => {
                    const v = a.topics[t.topic_id || 0];
                    const low = v && t.topic_id && v.percent < line;
                    return <td key={t.topic_id || 0} style={{ textAlign: 'right', color: low ? 'var(--danger, #b91c1c)' : undefined, fontWeight: low ? 700 : undefined }}>{v ? pct(v.percent) : '—'}</td>;
                  })}
                  <td style={{ textAlign: 'right' }}>{a.tab_switches || 0}</td>
                  <td>{['submitted', 'missed'].includes(a.status) && <Link className="btn btn-sm" to={`/hrd/exams/attempts/${a.id}`}>View</Link>}</td>
                </tr>
              ))}
            </tbody>
            {done.length > 0 && (
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={5}>Average ({done.length} submitted)</td>
                  {data.topics.map((t) => <td key={t.topic_id || 0} style={{ textAlign: 'right' }}>{pct(data.topic_avg[t.topic_id || 0])}</td>)}
                  <td colSpan={2} />
                </tr>
                <tr>
                  <td colSpan={5} className="muted">Below the line</td>
                  {data.topics.map((t) => <td key={t.topic_id || 0} style={{ textAlign: 'right' }}>{t.topic_id ? data.weak_counts[t.topic_id] || 0 : '—'}</td>)}
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {adding && meta && (
        <Modal title="Add Examinees" onClose={() => setAdding(false)} large>
          <TargetPicker meta={meta} departmentIds={departmentIds} setDepartmentIds={setDepartmentIds} userIds={userIds} setUserIds={setUserIds} />
          <button className="btn btn-primary" disabled={busy} onClick={saveAdd}>Add</button>
        </Modal>
      )}
    </div>
  );
}

// A typed answer box by box (an enumeration's items, an identification's one answer), each marked,
// with HR's hand override for a misspelling: Mark right / Mark wrong / back to Automatic.
function TypedMarks({ q, attempt, canEdit, onDone }) {
  const [busy, setBusy] = useState(false);
  const boxes = q.type === 'enumeration' ? (Array.isArray(q.given) ? q.given : []) : [q.given];
  async function mark(index, correct) {
    setBusy(true);
    try { await api.post(`/exam-admin/attempts/${attempt.id}/override`, { question_id: q.id, index, correct }); onDone(); }
    catch (e) { window.alert(e.response?.data?.error || 'Could not re-mark the answer.'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 4 }}>
      <span className="muted">Answer given:</span>
      {boxes.map((v, i) => {
        const ok = q.marks ? !!q.marks[i] : !!q.is_correct;
        const ov = q.overrides?.[i];
        return (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: 8 }}>
            <span>{boxes.length > 1 ? `${i + 1}. ` : ''}{String(v ?? '').trim() || <em className="muted">blank</em>}</span>
            <span style={{ color: ok ? 'var(--success, #16a34a)' : 'var(--danger, #b91c1c)', fontWeight: 700 }}>{ok ? '✓' : '✗'}</span>
            {ov != null && <span className="badge badge-muted" title="Marked by hand">by HR</span>}
            {canEdit && String(v ?? '').trim() && (
              <>
                {!ok && <button className="btn btn-sm" disabled={busy} onClick={() => mark(i, true)}>Mark right</button>}
                {ok && ov == null && <button className="btn btn-sm" disabled={busy} onClick={() => mark(i, false)}>Mark wrong</button>}
                {ov != null && <button className="btn btn-sm" disabled={busy} onClick={() => mark(i, null)}>Automatic</button>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EssayGrade({ q, attemptId, onDone }) {
  const [points, setPoints] = useState(q.points_awarded ?? '');
  const [feedback, setFeedback] = useState(q.feedback || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { await api.post(`/exam-admin/attempts/${attemptId}/grade`, { question_id: q.id, points, feedback }); onDone(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save the grade.'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}>
      <div className="field" style={{ marginBottom: 0, width: 110 }}><label>Points (of {q.points})</label>
        <input type="number" min="0" max={q.points} step="0.5" value={points} onChange={(e) => setPoints(e.target.value)} /></div>
      <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}><label>Note to the examinee (optional)</label>
        <input value={feedback} onChange={(e) => setFeedback(e.target.value)} /></div>
      <button className="btn btn-sm btn-primary" disabled={busy || points === ''} onClick={save}>{q.points_awarded == null ? 'Grade' : 'Update'}</button>
      {error && <div className="error-banner" style={{ width: '100%' }}>{error}</div>}
    </div>
  );
}

export function AttemptResult() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [a, setA] = useState(null);
  const [sets, setSets] = useState([]);
  const [retake, setRetake] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/exam-admin/attempts/${id}`).then(({ data }) => setA(data))
    .catch((e) => setError(e.response?.data?.error || 'Could not load.')), [id]);
  useEffect(() => { load(); }, [load]);

  async function ai() {
    setBusy(true); setError('');
    try { await api.post(`/exam-admin/attempts/${id}/ai-evaluation`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'The AI could not evaluate this result.'); }
    finally { setBusy(false); }
  }
  async function openRetake() {
    if (!sets.length) { const { data } = await api.get('/exam-admin/sets'); setSets(data); }
    setRetake({ set_id: a.set_id, title: `${a.title} (Retake)`, start_date: today(), end_date: '' });
  }
  async function saveRetake() {
    setBusy(true); setError('');
    try { const { data } = await api.post(`/exam-admin/attempts/${id}/retake`, retake); setRetake(null); navigate(`/hrd/exams/schedules/${data.id}`); }
    catch (e) { setError(e.response?.data?.error || 'Could not schedule the retake.'); }
    finally { setBusy(false); }
  }

  if (!a) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const line = Number(a.reorient_below_percent);
  return (
    <div>
      <div className="page-header">
        <h1>{a.name} <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>{a.title} · {a.set_name}</span></h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to={`/hrd/exams/schedules/${a.schedule_id}`}>Back to Results</Link>
          <Link className="btn btn-sm" to={`/hrd/exams/employees/${a.user_id}`}>Training Record</Link>
          {a.status === 'submitted' && Number(a.passed) === 1 && !Number(a.essays_pending) && (
            <button className="btn btn-sm" onClick={() => download(`/exam-admin/attempts/${a.id}/certificate`, `certificate-${a.id}.pdf`).catch(() => setError('Could not download the certificate.'))}>Certificate</button>
          )}
          {can(ROUTE, 'can_add') && ['submitted', 'missed'].includes(a.status) && <button className="btn btn-sm btn-primary" onClick={openRetake}>Schedule Retake</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{a.department}</span>
          <span><span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABELS[a.status]}</span></span>
          {a.status === 'submitted' && (
            <>
              <span style={{ fontSize: 22, fontWeight: 700 }}>{a.score} / {a.max_score} ({pct(a.percent)})</span>
              <span>{a.essays_pending > 0 ? <span className="badge badge-warning">{a.essays_pending} essay(s) to grade</span>
                : Number(a.passed) ? <span className="badge badge-success">Passed</span> : <span className="badge badge-danger">Below passing ({pct(a.passing_percent)})</span>}</span>
              <span className="muted">Submitted {fmtWhen(a.submitted_at)}{Number(a.auto_submitted) ? ' (time ran out)' : ''} · left the tab {a.tab_switches || 0}×</span>
            </>
          )}
        </div>
        {a.topics.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Topic</th><th style={{ textAlign: 'right' }}>Points</th><th style={{ textAlign: 'right' }}>Score</th><th>Orientation</th></tr></thead>
              <tbody>{a.topics.map((t) => {
                const low = t.topic_id && t.percent < line;
                const o = a.orientations.find((x) => Number(x.topic_id) === Number(t.topic_id));
                return (
                  <tr key={t.topic_id || 0}>
                    <td>{t.topic}</td>
                    <td style={{ textAlign: 'right' }}>{t.earned} / {t.max}</td>
                    <td style={{ textAlign: 'right', color: low ? 'var(--danger, #b91c1c)' : undefined, fontWeight: low ? 700 : undefined }}>{pct(t.percent)}</td>
                    <td>{o ? <><span className={`badge ${ORIENTATION_BADGE[o.status]}`}>{ORIENTATION_LABELS[o.status]}</span> {o.orientation_name || `${t.topic} Orientation`}
                      {o.attended_date && <span className="muted"> · attended {fmtDay(o.attended_date)}</span>}</> : low ? 'Recommended' : '—'}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Re-orientation is recommended below {pct(line)} in a topic. Follow it up under Examinations &gt; Re-orientation.</div>
          </div>
        )}
      </div>

      {a.status === 'submitted' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>AI Evaluation</h3>
            <button className="btn btn-sm btn-primary" disabled={busy || a.essays_pending > 0} onClick={ai}
              title={a.essays_pending > 0 ? 'Grade the essays first' : ''}>{a.ai_evaluation ? 'Refresh' : 'Generate'}</button>
          </div>
          <div style={{ marginTop: 8 }}>
            {a.ai_evaluation ? <><AiText text={a.ai_evaluation} /><div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{fmtWhen(a.ai_evaluation_at)} · from the scores and missed questions only</div></>
              : <span className="muted">Strengths, weak areas and which orientation to attend, read from this result.</span>}
          </div>
        </div>
      )}

      {a.questions.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Answers</h3>
          {a.questions.map((q, n) => (
            <div key={q.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div><strong>{n + 1}.</strong> {q.question} <span className="muted" style={{ fontSize: 11 }}>({TYPE_LABELS[q.type]} · {q.topic || 'General'} · {q.points} pt)</span></div>
                <div style={{ whiteSpace: 'nowrap' }}>
                  {q.type === 'essay' && q.confirmed && q.points_awarded == null ? <span className="badge badge-warning">To grade</span>
                    : q.is_correct ? <span className="badge badge-success">✓ {q.points_awarded}</span> : <span className="badge badge-danger">✗ {q.points_awarded ?? 0}</span>}
                </div>
              </div>
              {q.has_image && <QuestionImage url={`/exam-admin/questions/${q.id}/image`} maxHeight={160} />}
              {CHOICE_TYPES.includes(q.type) && <div className="muted" style={{ fontSize: 12 }}>{(q.choices || []).map((c, j) => `${LETTERS[j]}. ${c}`).join('   ')}</div>}
              {q.confirmed && (q.type === 'enumeration' || q.type === 'identification') ? (
                <TypedMarks q={q} attempt={a} canEdit={can(ROUTE, 'can_edit') && a.status === 'submitted'} onDone={load} />
              ) : (
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}><span className="muted">Answer given: </span>
                  {q.confirmed ? (answerText(q.type, q.given, indexed(q.choices)) || '—') : <em className="muted">not answered / not confirmed</em>}</div>
              )}
              {q.type !== 'essay' && <div style={{ fontSize: 13 }}><span className="muted">Correct: </span>{answerText(q.type, q.answer_key, indexed(q.choices))}</div>}
              {q.type === 'essay' && q.answer_key?.guide && <div style={{ fontSize: 13 }}><span className="muted">Grading guide: </span>{q.answer_key.guide}</div>}
              {q.type === 'essay' && q.confirmed && a.status === 'submitted' && can(ROUTE, 'can_edit') && <EssayGrade q={q} attemptId={a.id} onDone={load} />}
              {q.type === 'essay' && q.graded_by && <div className="muted" style={{ fontSize: 11 }}>Graded by {q.graded_by}</div>}
            </div>
          ))}
        </div>
      )}

      {retake && (
        <Modal title="Schedule a Retake" onClose={() => setRetake(null)}>
          <div className="field"><label>Exam Set</label>
            <select value={retake.set_id} onChange={(e) => setRetake({ ...retake, set_id: e.target.value })}>
              {sets.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </select></div>
          <div className="field"><label>Title</label><input value={retake.title} onChange={(e) => setRetake({ ...retake, title: e.target.value })} /></div>
          <div className="field"><label>Opens</label><input type="date" value={retake.start_date} onChange={(e) => setRetake({ ...retake, start_date: e.target.value })} /></div>
          <div className="field"><label>Must be done by</label><input type="date" value={retake.end_date} onChange={(e) => setRetake({ ...retake, end_date: e.target.value })} /></div>
          <button className="btn btn-primary" disabled={busy} onClick={saveRetake}>Schedule Retake</button>
        </Modal>
      )}
    </div>
  );
}
