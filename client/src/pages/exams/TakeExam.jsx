import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { LETTERS, TYPE_LABELS, answerText, download, fmtDay, fmtWhen, pct } from '../../utils/exams';
import QuestionImage from './QuestionImage';

// One exam (2026-10-21; routes/exams.js), taken and then reviewed.
//
// Taking it: questions in your own order. Answer, skip, come back -- but CONFIRM makes an answer
// final, and a confirmed question cannot be opened again. Only confirmed answers count. When the
// time limit runs out the exam is submitted as it stands.
//
// After: your score, by topic, and your own answers marked right or wrong -- not the correct ones.
const clock = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};
const hasAnswer = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.some((x) => x != null && x !== ''));

function AnswerInput({ q, value, onChange }) {
  if (q.type === 'true_false') {
    return (
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[[true, 'True'], [false, 'False']].map(([v, label]) => (
          <label key={label} className={`btn ${value === v ? 'btn-primary' : ''}`} style={{ minWidth: 120, justifyContent: 'center' }}>
            <input type="radio" name={`q${q.id}`} checked={value === v} onChange={() => onChange(v)} style={{ display: 'none' }} />{label}
          </label>
        ))}
      </div>
    );
  }
  if (q.type === 'multiple_choice' || q.type === 'multiple_select') {
    const multi = q.type === 'multiple_select';
    const picked = multi ? (Array.isArray(value) ? value.map(Number) : []) : value;
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {multi && <div className="muted" style={{ fontSize: 12 }}>Select all that apply.</div>}
        {q.choices.map((c, n) => {
          const on = multi ? picked.includes(Number(c.i)) : Number(picked) === Number(c.i) && picked != null;
          return (
            <label key={c.i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--border, #d1d5db)', borderRadius: 6, cursor: 'pointer', background: on ? 'var(--primary-soft, #eef2ff)' : undefined }}>
              <input
                type={multi ? 'checkbox' : 'radio'} name={`q${q.id}`} checked={on}
                onChange={() => onChange(multi ? (on ? picked.filter((i) => i !== Number(c.i)) : [...picked, Number(c.i)]) : Number(c.i))}
              />
              <span><strong>{LETTERS[n]}.</strong> {c.text}</span>
            </label>
          );
        })}
      </div>
    );
  }
  // Enumeration: one box per item asked for, in any order.
  if (q.type === 'enumeration') {
    const list = Array.from({ length: q.slots || 1 }, (_, i) => (Array.isArray(value) ? value[i] ?? '' : ''));
    return (
      <div style={{ display: 'grid', gap: 6, maxWidth: 480 }}>
        <div className="muted" style={{ fontSize: 12 }}>Give {q.slots} answer{q.slots === 1 ? '' : 's'}, in any order.</div>
        {list.map((v, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong style={{ width: 20 }}>{i + 1}.</strong>
            <input value={v} onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
      </div>
    );
  }
  if (q.type === 'identification') {
    return <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Type your answer" style={{ maxWidth: 480 }} />;
  }
  return <textarea rows={10} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Write your answer" style={{ width: '100%' }} />;
}

function Review({ exam }) {
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>Score</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{exam.score} / {exam.max_score} <span style={{ fontSize: 18 }}>({pct(exam.percent)})</span></div>
          </div>
          <div>
            {exam.essays_pending > 0
              ? <span className="badge badge-warning">{exam.essays_pending} essay(s) still being graded -- score so far</span>
              : exam.passed ? <span className="badge badge-success">Passed (passing {pct(exam.passing_percent)})</span>
                : <span className="badge badge-danger">Below passing ({pct(exam.passing_percent)})</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Submitted {fmtWhen(exam.submitted_at)}{exam.auto_submitted ? ' -- time ran out' : ''}</div>
          {exam.certificate && (
            <button className="btn btn-primary btn-sm" onClick={() => download(`/exams/attempts/${exam.id}/certificate`, `certificate-${exam.id}.pdf`).catch(() => window.alert('Could not download the certificate.'))}>
              Download Certificate
            </button>
          )}
        </div>
        {exam.topics?.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Topic</th><th style={{ textAlign: 'right' }}>Points</th><th style={{ textAlign: 'right' }}>Score</th></tr></thead>
              <tbody>{exam.topics.map((t) => (
                <tr key={t.topic}><td>{t.topic}</td><td style={{ textAlign: 'right' }}>{t.earned} / {t.max}</td><td style={{ textAlign: 'right' }}>{pct(t.percent)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Your Answers</h3>
        <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>Marked right or wrong. The correct answers are not shown.</div>
        {exam.questions.map((q) => (
          <div key={q.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div><strong>{q.n}.</strong> {q.question} <span className="muted" style={{ fontSize: 11 }}>({TYPE_LABELS[q.type]}, {q.points} pt{q.points === 1 ? '' : 's'})</span></div>
              <div style={{ whiteSpace: 'nowrap' }}>
                {q.pending ? <span className="badge badge-warning">Being graded</span>
                  : q.is_correct ? <span className="badge badge-success">✓ {q.points_awarded}</span>
                    : <span className="badge badge-danger">✗ {q.points_awarded ?? 0}</span>}
              </div>
            </div>
            {q.has_image && <QuestionImage url={`/exams/attempts/${exam.id}/questions/${q.id}/image`} maxHeight={160} />}
            <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
              <span className="muted">Your answer: </span>{!q.confirmed ? <em className="muted">not answered / not confirmed</em>
                : q.type === 'enumeration' ? (q.answer || []).map((v, i) => (
                  <span key={i} style={{ marginRight: 12 }}>{i + 1}. {v || <em className="muted">blank</em>} {q.marks?.[i] ? '✓' : '✗'}</span>
                )) : (answerText(q.type, q.answer, q.choices) || '—')}
            </div>
            {q.feedback && <div style={{ marginTop: 4, fontSize: 13 }}><span className="muted">Grader&apos;s note: </span>{q.feedback}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

export default function TakeExam() {
  const { id } = useParams();
  const [exam, setExam] = useState(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(null);
  const [answers, setAnswers] = useState({});
  const [left, setLeft] = useState(null);
  const [busy, setBusy] = useState(false);
  const saveTimers = useRef({}); // one per question, so moving on never drops a pending save
  const submitting = useRef(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/exams/attempts/${id}`);
      setExam(data);
      if (data.status === 'in_progress') {
        setAnswers(Object.fromEntries(data.questions.filter((q) => !q.confirmed).map((q) => [q.id, q.answer])));
        setLeft(data.seconds_left);
        setCurrent((c) => (data.questions.some((q) => q.id === c && !q.confirmed) ? c : data.questions.find((q) => !q.confirmed)?.id ?? null));
      }
    } catch (e) { setError(e.response?.data?.error || 'Could not load the exam.'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const submit = useCallback(async (auto = false) => {
    if (submitting.current) return;
    submitting.current = true;
    try { await api.post(`/exams/attempts/${id}/submit`); }
    catch (e) { if (!auto) setError(e.response?.data?.error || 'Could not submit.'); }
    submitting.current = false;
    load();
  }, [id, load]);

  // The countdown; at zero the exam goes in as it stands.
  useEffect(() => {
    if (exam?.status !== 'in_progress' || left == null) return undefined;
    if (left <= 0) { submit(true); return undefined; }
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left, exam?.status, submit]);

  // Leaving the tab is counted for HR.
  useEffect(() => {
    if (exam?.status !== 'in_progress') return undefined;
    const onHide = () => { if (document.visibilityState === 'hidden') api.post(`/exams/attempts/${id}/tab-switch`).catch(() => {}); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [exam?.status, id]);

  const closedOut = (e) => { if (e.response?.data?.closed) load(); };

  function change(qid, v) {
    setAnswers((a) => ({ ...a, [qid]: v }));
    clearTimeout(saveTimers.current[qid]);
    saveTimers.current[qid] = setTimeout(() => {
      api.put(`/exams/attempts/${id}/answers/${qid}`, { answer: v }).catch(closedOut);
    }, 600);
  }

  async function start() {
    if (!window.confirm(`Start "${exam.title}" now?${exam.time_limit_minutes ? ` You will have ${exam.time_limit_minutes} minutes.` : ''}`)) return;
    setBusy(true); setError('');
    try { await api.post(`/exams/attempts/${id}/start`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not start the exam.'); }
    finally { setBusy(false); }
  }

  const open = exam?.status === 'in_progress' ? exam.questions.filter((q) => !q.confirmed) : [];
  const q = open.find((x) => x.id === current) || null;
  const nextOpen = (from) => {
    const idx = open.findIndex((x) => x.id === from);
    const after = [...open.slice(idx + 1), ...open.slice(0, Math.max(0, idx))];
    return after.find((x) => x.id !== from)?.id ?? null;
  };

  async function confirmAnswer() {
    const v = answers[q.id];
    if (!hasAnswer(v)) { setError('Answer the question first, or skip it for now.'); return; }
    if (!window.confirm('Is this your final answer? Once confirmed you cannot go back to this question.')) return;
    setBusy(true); setError('');
    clearTimeout(saveTimers.current[q.id]);
    try {
      await api.post(`/exams/attempts/${id}/answers/${q.id}/confirm`, { answer: v });
      const next = nextOpen(q.id);
      setCurrent(next);
      await load();
    } catch (e) { setError(e.response?.data?.error || 'Could not confirm the answer.'); closedOut(e); }
    finally { setBusy(false); }
  }

  async function submitAll() {
    const unconfirmed = open.length;
    const msg = unconfirmed
      ? `${unconfirmed} question(s) are not confirmed and will score 0. Submit the exam anyway?`
      : 'Submit the exam? You cannot change anything after.';
    if (!window.confirm(msg)) return;
    setBusy(true);
    await submit(false);
    setBusy(false);
  }

  if (!exam) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;

  const header = (
    <div className="page-header">
      <h1>{exam.title} <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>{exam.set_name}</span></h1>
      {exam.status === 'in_progress'
        ? <div style={{ fontSize: 22, fontWeight: 700, color: left != null && left < 300 ? 'var(--danger, #b91c1c)' : undefined }}>⏱ {clock(Math.max(0, left || 0))}</div>
        : <Link className="btn btn-sm" to="/exams">Back to My Exams</Link>}
    </div>
  );

  if (exam.status === 'assigned' || exam.status === 'missed') {
    return (
      <div>
        {header}
        {error && <div className="error-banner">{error}</div>}
        <div className="card" style={{ maxWidth: 720 }}>
          {exam.description && <p style={{ whiteSpace: 'pre-wrap' }}>{exam.description}</p>}
          <ul>
            <li>{exam.question_count} question(s). Take it between {fmtDay(exam.start_date)} and {fmtDay(exam.end_date)}.</li>
            <li>{exam.time_limit_minutes ? `Time limit: ${exam.time_limit_minutes} minutes from when you start. When time is up the exam is submitted as it stands.` : 'No time limit, but finish before the window closes.'}</li>
            <li>You can skip a question and come back to it. When you are sure, <strong>Confirm</strong> the answer -- a confirmed answer is final and you cannot go back to that question.</li>
            <li>Only confirmed answers are scored. Leaving this page during the exam is recorded.</li>
            <li>Passing score: {pct(exam.passing_percent)}.</li>
          </ul>
          {exam.status === 'missed'
            ? <div className="error-banner">The exam window closed before you took it.</div>
            : exam.can_start
              ? <button className="btn btn-primary" disabled={busy} onClick={start}>Start Exam</button>
              : <div className="muted">This exam opens on {fmtDay(exam.start_date)}.</div>}
        </div>
      </div>
    );
  }

  if (exam.status === 'submitted') return <div>{header}<Review exam={exam} /></div>;

  const confirmedCount = exam.questions.length - open.length;
  return (
    <div>
      {header}
      {error && <div className="error-banner">{error}</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <span><strong>{confirmedCount}</strong> of {exam.questions.length} confirmed</span>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={submitAll}>Submit Exam</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {exam.questions.map((x) => {
            const isCur = x.id === current;
            const saved = !x.confirmed && hasAnswer(answers[x.id]);
            return (
              <button
                key={x.id} type="button" disabled={x.confirmed} onClick={() => setCurrent(x.id)}
                title={x.confirmed ? 'Confirmed -- final' : saved ? 'Answered, not confirmed' : 'Not answered'}
                className={`btn btn-sm ${isCur ? 'btn-primary' : ''}`}
                style={{ minWidth: 38, opacity: x.confirmed ? 0.45 : 1, borderColor: saved && !isCur ? 'var(--warning, #d97706)' : undefined }}
              >
                {x.confirmed ? '✓' : x.n}
              </button>
            );
          })}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>✓ confirmed (final) · orange outline: answered but not confirmed yet</div>
      </div>

      <div className="card">
        {!q ? (
          <div>
            <p>All questions are confirmed.</p>
            <button className="btn btn-primary" disabled={busy} onClick={submitAll}>Submit Exam</button>
          </div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Question {q.n} · {TYPE_LABELS[q.type]} · {q.points} pt{q.points === 1 ? '' : 's'}</div>
            <div style={{ fontSize: 17, marginBottom: 14, whiteSpace: 'pre-wrap' }}>{q.question}</div>
            {q.has_image && <QuestionImage key={q.id} url={`/exams/attempts/${id}/questions/${q.id}/image`} maxHeight={340} />}
            <AnswerInput q={q} value={answers[q.id]} onChange={(v) => change(q.id, v)} />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={busy || !hasAnswer(answers[q.id])} onClick={confirmAnswer}>Confirm Final Answer</button>
              {open.length > 1 && <button className="btn" disabled={busy} onClick={() => setCurrent(nextOpen(q.id))}>Skip for now</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
