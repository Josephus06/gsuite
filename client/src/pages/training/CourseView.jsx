import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { download, fmtDay, pct } from '../../utils/exams';

// One course, as the "T1S Improvement Plan (Training)" slide lays it out (2026-10-21;
// routes/training.js): the blue header with the title, progress and the certificate card; the
// Learning / Notes / Other Courses tabs; the Learning Materials list and viewer (open the file,
// then Mark as Completed); and the Quiz screen (type, questions, marks, time limit, instructions)
// that starts the ordinary exam. Moving between them keeps "Course Details" one click away.
const QUIZ_STATE = {
  passed: ['badge-success', 'Passed'], failed: ['badge-danger', 'Below passing'], grading: ['badge-warning', 'Being graded'],
  in_progress: ['badge-info', 'In progress'], not_taken: ['badge-muted', 'Not taken'], missed: ['badge-danger', 'Missed'],
};
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ext = (name) => (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toUpperCase() || 'FILE';
const viewable = (m) => /^application\/pdf$|^image\//.test(m.mime_type || '');

const CSS = `
  .crs { max-width: 760px; margin: 0 auto; }
  .crs-head { background: linear-gradient(135deg, var(--primary, #1d4ed8), #1e3a8a); color: #fff; border-radius: 12px; padding: 18px 18px 16px; }
  .crs-chip { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .5px; border: 1px solid rgba(255,255,255,.6); border-radius: 6px; padding: 2px 8px; }
  .crs-title { font-size: 24px; font-weight: 700; margin: 8px 0 4px; }
  .crs-sub { font-size: 12px; opacity: .9; }
  .crs-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .crs-bar > div { flex: 1; height: 5px; border-radius: 3px; background: rgba(255,255,255,.3); }
  .crs-bar > div > div { height: 100%; border-radius: 3px; background: #fff; }
  .crs-cert { display: flex; gap: 14px; align-items: center; background: #fff; color: #1f2937; border-radius: 10px; padding: 12px; margin-top: 14px; }
  .crs-cert-art { width: 110px; height: 76px; flex: none; border: 3px solid #0b109f; outline: 1px solid #ec7601; outline-offset: -7px; border-radius: 3px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 7px; font-weight: 700; color: #0b109f; text-align: center; }
  .crs-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border, #e5e7eb); margin: 14px 0 12px; }
  .crs-tabs button { background: none; border: none; padding: 10px 14px; cursor: pointer; color: var(--text-muted, #6b7280); font-weight: 600; border-bottom: 2px solid transparent; }
  .crs-tabs button.on { color: var(--primary, #1d4ed8); border-bottom-color: var(--primary, #1d4ed8); }
  .crs-item { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; cursor: pointer; padding: 14px 16px; margin-bottom: 10px;
    border: 1px solid var(--border, #e5e7eb); border-radius: 10px; background: var(--surface, #fff); color: inherit; font: inherit; }
  .crs-item:hover { border-color: var(--primary, #1d4ed8); }
  .crs-item.locked { opacity: .55; cursor: default; }
  .crs-item .grow { flex: 1; min-width: 0; }
  .crs-item .name { font-weight: 600; }
  .crs-item .meta { font-size: 12px; color: var(--text-muted, #6b7280); margin-top: 2px; }
  .crs-mini { height: 4px; width: 120px; border-radius: 2px; background: var(--border, #e5e7eb); display: inline-block; vertical-align: middle; margin-right: 6px; }
  .crs-mini > div { height: 100%; border-radius: 2px; background: var(--primary, #1d4ed8); }
  .crs-bar2 { display: flex; align-items: center; gap: 10px; background: var(--primary, #1d4ed8); color: #fff; border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; }
  .crs-bar2 button { background: none; border: none; color: #fff; font-size: 20px; cursor: pointer; }
  .crs-foot { position: sticky; bottom: 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 0;
    background: var(--bg, #f8fafc); border-top: 1px solid var(--border, #e5e7eb); margin-top: 12px; }
  .crs-done { color: var(--success, #16a34a); font-size: 12px; font-weight: 600; }
  .crs-info { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--border, #e5e7eb); border-radius: 10px; margin-bottom: 10px; }
  .crs-kv div { margin: 3px 0; }
  .crs-kv span { color: var(--text-muted, #6b7280); }
`;

function Arrow() { return <span style={{ color: 'var(--primary, #1d4ed8)', fontSize: 18 }}>›</span>; }

// A material's file in the page: PDF and pictures shown, anything else downloaded.
function Viewer({ enrollmentId, m }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!viewable(m)) return undefined;
    let live = true;
    let made = null;
    api.get(`/training/enrollments/${enrollmentId}/materials/${m.id}/file`, { params: { inline: 1 }, responseType: 'blob' })
      .then((res) => { if (live) { made = URL.createObjectURL(res.data); setUrl(made); } })
      .catch(() => live && setErr('Could not open the file.'));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [enrollmentId, m]);
  const get = () => download(`/training/enrollments/${enrollmentId}/materials/${m.id}/file`, m.file_name).catch(() => setErr('Could not download the file.'));
  if (!viewable(m)) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 30 }}>
        <div style={{ fontSize: 40 }}>📄</div>
        <div style={{ fontWeight: 600, margin: '6px 0' }}>{m.file_name}</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{ext(m.file_name)} · {size(m.file_size)} -- opens in its own program</div>
        <button className="btn btn-primary" onClick={get}>Download &amp; Open</button>
        {err && <div className="error-banner" style={{ marginTop: 10 }}>{err}</div>}
      </div>
    );
  }
  return (
    <div>
      {err && <div className="error-banner">{err}</div>}
      {!url ? <LoadingSpinner /> : /^image\//.test(m.mime_type)
        ? <img src={url} alt={m.title} style={{ maxWidth: '100%', borderRadius: 8, display: 'block', margin: '0 auto' }} />
        : <iframe title={m.title} src={url} style={{ width: '100%', height: '70vh', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8 }} />}
      <div style={{ textAlign: 'right', marginTop: 6 }}><button className="btn btn-sm" onClick={get}>Download</button></div>
    </div>
  );
}

export default function CourseView() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState('learning');
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [instrOpen, setInstrOpen] = useState(true);
  const notesTimer = useRef(null);
  // The screen: home, the materials list, one material, or one quiz -- kept in the address so Back works.
  const view = params.get('v') || 'home';
  const go = (v) => setParams(v === 'home' ? {} : { v });

  const load = useCallback(() => api.get(`/training/enrollments/${id}`).then(({ data }) => { setC(data); setNotes(data.notes || ''); })
    .catch((e) => setError(e.response?.data?.error || 'Could not load the course.')), [id]);
  useEffect(() => { load(); }, [load]);

  function changeNotes(v) {
    setNotes(v); setSaved('');
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => {
      api.put(`/training/enrollments/${id}/notes`, { notes: v }).then(() => setSaved('Saved')).catch(() => setSaved('Not saved'));
    }, 700);
  }
  async function markDone(m, completed) {
    setBusy(true); setError('');
    try { await api.post(`/training/enrollments/${id}/materials/${m.id}/complete`, { completed }); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not update.'); }
    finally { setBusy(false); }
  }
  const certificate = () => download(`/training/enrollments/${id}/certificate`, `certificate-${c.title}.pdf`).catch(() => setError('Could not download the certificate.'));

  if (!c) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;

  // Every screen in order -- materials then quizzes -- for the ← / → buttons.
  const steps = [...c.materials.map((m) => `m${m.id}`), ...c.quizzes.map((q) => `q${q.id}`)];
  const stepNav = (cur) => {
    const i = steps.indexOf(cur);
    return (
      <div className="crs-foot">
        <button className="btn btn-sm" disabled={i <= 0} onClick={() => go(steps[i - 1])}>←</button>
        <button className="btn btn-sm" onClick={() => go('home')}>☰ Course Details</button>
        <button className="btn btn-sm" disabled={i < 0 || i >= steps.length - 1} onClick={() => go(steps[i + 1])}>→</button>
      </div>
    );
  };
  const bar = (title, back = 'home') => (
    <div className="crs-bar2"><button onClick={() => go(back)} aria-label="Back">←</button><strong style={{ fontSize: 17 }}>{title}</strong></div>
  );

  // ---- one material
  if (view.startsWith('m') && view !== 'materials') {
    const m = c.materials.find((x) => `m${x.id}` === view);
    if (!m) return <div className="crs"><div className="card muted">That is no longer part of this course. <button className="btn btn-sm" onClick={() => go('materials')}>Back</button></div></div>;
    return (
      <div className="crs"><style>{CSS}</style>
        {bar('Learning Materials', 'materials')}
        {error && <div className="error-banner">{error}</div>}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{m.title}</div>
          {m.description && <div className="muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{m.description}</div>}
        </div>
        <Viewer enrollmentId={id} m={m} />
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {m.completed_at ? (
            <>
              <span className="crs-done">✓ Completed {fmtDay(m.completed_at)}</span>
              {!c.complete && <button className="btn btn-sm" disabled={busy} onClick={() => markDone(m, false)}>Undo</button>}
            </>
          ) : (
            <button className="btn btn-primary" disabled={busy || !c.open} onClick={() => markDone(m, true)}>✓ Mark as Completed</button>
          )}
          {!c.open && <span className="muted">This course opens on {fmtDay(c.start_date)}.</span>}
        </div>
        {stepNav(view)}
      </div>
    );
  }

  // ---- the materials list
  if (view === 'materials') {
    return (
      <div className="crs"><style>{CSS}</style>
        {bar('Learning Materials')}
        {c.materials.length === 0 && <div className="card muted">No learning materials in this course.</div>}
        {c.materials.map((m) => (
          <button key={m.id} type="button" className="crs-item" onClick={() => go(`m${m.id}`)}>
            <span style={{ fontSize: 20 }}>{m.completed_at ? '✅' : '📄'}</span>
            <span className="grow">
              <span className="name">{m.title}</span>
              <div className="meta">{m.completed_at ? <span className="crs-done">Completed · {fmtDay(m.completed_at)}</span> : `${ext(m.file_name)} · ${size(m.file_size)}`}</div>
            </span>
            <Arrow />
          </button>
        ))}
      </div>
    );
  }

  // ---- one quiz
  if (view.startsWith('q')) {
    const q = c.quizzes.find((x) => `q${x.id}` === view);
    if (!q) return <div className="crs"><div className="card muted">That is no longer part of this course. <button className="btn btn-sm" onClick={() => go('home')}>Back</button></div></div>;
    const [cls, label] = QUIZ_STATE[q.state] || QUIZ_STATE.not_taken;
    const action = q.state === 'in_progress' ? 'Continue Quiz'
      : ['passed', 'failed', 'grading'].includes(q.state) ? 'View Result' : 'Take Quiz';
    return (
      <div className="crs"><style>{CSS}</style>
        {bar('Quiz')}
        <div className="crs-info">
          <span style={{ fontSize: 18 }}>ⓘ</span>
          <div>A minimum of <strong>{pct(q.passing_percent)}</strong> is required to pass this quiz{c.quizzes.length ? ' and complete the course' : ''}.</div>
        </div>
        <div className="card crs-kv" style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{q.name}</div>
          <div><span>Type:</span> Graded Quiz</div>
          <div><span>Questions:</span> {q.questions}</div>
          <div><span>Total Marks:</span> {q.total_marks ?? 'varies (questions drawn per person)'}</div>
          <div><span>Time Limit:</span> {q.time_limit_minutes ? `${q.time_limit_minutes} Mins` : 'None'}</div>
          <div><span>Status:</span> <span className={`badge ${cls}`}>{label}</span>
            {q.best_percent != null && <span style={{ marginLeft: 6 }}>best score {pct(q.best_percent)}</span>}</div>
        </div>
        {q.instructions && (
          <div className="card" style={{ marginBottom: 10 }}>
            <button type="button" onClick={() => setInstrOpen(!instrOpen)}
              style={{ display: 'flex', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', font: 'inherit', fontWeight: 700, cursor: 'pointer', color: 'inherit', padding: 0 }}>
              Instructions <span>{instrOpen ? '˄' : '˅'}</span>
            </button>
            {instrOpen && <div style={{ whiteSpace: 'pre-wrap', marginTop: 10, lineHeight: 1.5 }}>{q.instructions}</div>}
          </div>
        )}
        {q.state === 'failed' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Below passing. HR schedules a retake -- it will appear here.</div>}
        {q.state === 'missed' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>The quiz window closed. Ask HR to schedule a retake.</div>}
        {q.attempt_id && q.state !== 'missed' && (
          <Link className="btn btn-primary" to={`/exams/${q.attempt_id}`}>{action}</Link>
        )}
        {stepNav(view)}
      </div>
    );
  }

  // ---- course details (home)
  const matPct = c.materials.length ? Math.round((c.materials_done / c.materials.length) * 100) : 0;
  return (
    <div className="crs"><style>{CSS}</style>
      <div style={{ marginBottom: 8 }}><Link className="btn btn-sm" to="/trainings">← My Training</Link></div>
      {error && <div className="error-banner">{error}</div>}
      <div className="crs-head">
        <span className="crs-chip">{c.complete ? '✓ COMPLETED' : 'COURSE'}</span>
        <div className="crs-title">{c.title}</div>
        <div className="crs-sub">{c.materials_done} / {c.materials.length} Materials · {c.quizzes_passed} / {c.quizzes.length} Assessments
          {' · '}{c.complete ? `completed ${fmtDay(c.completed_at)}` : `finish by ${fmtDay(c.end_date)}`}</div>
        <div className="crs-bar"><div><div style={{ width: `${c.percent}%` }} /></div><span style={{ fontSize: 12 }}>{c.percent}%</span></div>
        <div className="crs-cert">
          <div className="crs-cert-art">CERTIFICATE<br />OF COMPLETION<div style={{ fontWeight: 400, marginTop: 4, color: '#ec7601' }}>GRAPHICSTAR</div></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {c.complete ? 'You finished the course -- claim your certificate.' : 'Finish every material and pass the quiz to claim your course certificate.'}
            </div>
            <button className="btn btn-primary btn-sm" disabled={!c.complete} onClick={certificate}>{c.complete ? 'Get Certificate' : '🔒 Get Certificate'}</button>
          </div>
        </div>
      </div>

      <div className="crs-tabs">
        {[['learning', 'Learning'], ['notes', 'Notes'], ['others', 'Other Courses']].map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'learning' && (
        <>
          {c.description && <div className="card" style={{ marginBottom: 10, whiteSpace: 'pre-wrap' }}>{c.description}</div>}
          {c.materials.length > 0 && (
            <button type="button" className="crs-item" onClick={() => go('materials')}>
              <span className="grow">
                <span className="name">Learning Materials</span>
                <div className="meta">{c.materials.length} File{c.materials.length === 1 ? '' : 's'}</div>
                <div className="meta"><span className="crs-mini"><div style={{ width: `${matPct}%` }} /></span>{matPct}%</div>
              </span>
              <Arrow />
            </button>
          )}
          {c.quizzes.map((q) => {
            const [cls, label] = QUIZ_STATE[q.state] || QUIZ_STATE.not_taken;
            return (
              <button key={q.id} type="button" className="crs-item" onClick={() => go(`q${q.id}`)}>
                <span className="grow">
                  <span className="name">Quiz{c.quizzes.length > 1 ? `: ${q.name}` : ''}</span>
                  <div className="meta">1 Assessment · <span className={`badge ${cls}`}>{label}</span>{q.best_percent != null ? ` ${pct(q.best_percent)}` : ''}</div>
                </span>
                <Arrow />
              </button>
            );
          })}
          <button type="button" className={`crs-item ${c.complete ? '' : 'locked'}`} onClick={() => c.complete && certificate()}>
            <span className="grow">
              <span className="name">Claim your course certificate</span>
              <div className="meta">{c.complete ? 'Ready -- click to download' : `${c.quizzes.length} Assessment${c.quizzes.length === 1 ? '' : 's'} to pass first`}</div>
            </span>
            <span style={{ fontSize: 18 }}>{c.complete ? '⬇' : '🔒'}</span>
          </button>
        </>
      )}

      {tab === 'notes' && (
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Your own notes for this course -- only you see them. {saved && <strong>{saved}</strong>}</div>
          <textarea rows={12} value={notes} onChange={(e) => changeNotes(e.target.value)} style={{ width: '100%' }} placeholder="Write what you want to remember..." />
        </div>
      )}

      {tab === 'others' && (
        <div>
          {c.others.length === 0 && <div className="card muted">No other courses assigned to you.</div>}
          {c.others.map((o) => (
            <Link key={o.id} to={`/trainings/${o.id}`} className="crs-item" style={{ textDecoration: 'none' }} onClick={() => setTab('learning')}>
              <span className="grow"><span className="name">{o.title}</span>
                <div className="meta">{o.completed_at ? <span className="crs-done">Completed · {fmtDay(o.completed_at)}</span> : 'In progress'}</div></span>
              <Arrow />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
