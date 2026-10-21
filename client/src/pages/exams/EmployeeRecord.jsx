import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { ORIENTATION_BADGE, ORIENTATION_LABELS, STATUS_BADGE, STATUS_LABELS, fmtDay, pct } from '../../utils/exams';

// HRD > Examinations > an employee's training record (2026-10-21; GET /exam-admin/employees/:id):
// every exam they were given, each topic's score over time (are they improving?), and their
// re-orientations -- for performance reviews and regularization.
export default function EmployeeRecord() {
  const { userId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [courses, setCourses] = useState([]);
  useEffect(() => { api.get(`/training/users/${userId}`).then(({ data: d }) => setCourses(d)).catch(() => setCourses([])); }, [userId]);
  useEffect(() => {
    api.get(`/exam-admin/employees/${userId}`).then(({ data: d }) => setData(d)).catch((e) => setError(e.response?.data?.error || 'Could not load the record.'));
  }, [userId]);
  if (!data) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;

  const e = data.employee;
  const done = data.attempts.filter((a) => a.status === 'submitted');
  const graded = done.filter((a) => !Number(a.essays_pending));
  const avg = graded.length ? graded.reduce((m, a) => m + Number(a.percent), 0) / graded.length : null;
  const trend = (t) => {
    if (t.scores.length < 2) return null;
    const d = Math.round((t.latest - t.first) * 10) / 10;
    if (d === 0) return <span className="muted">no change</span>;
    return <span style={{ color: d > 0 ? 'var(--success, #16a34a)' : 'var(--danger, #b91c1c)', fontWeight: 600 }}>{d > 0 ? '▲' : '▼'} {Math.abs(d)} pts</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1>{e.name} <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>Training Record</span></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/hrd/exams?tab=employees">Back</Link>
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <span>{e.department || '—'}{e.position_title ? ` · ${e.position_title}` : ''}{e.employee_code ? ` · ${e.employee_code}` : ''}</span>
          <span>Exams <strong>{data.attempts.length}</strong></span>
          <span>Taken <strong>{done.length}</strong></span>
          <span>Passed <strong>{done.filter((a) => Number(a.passed) === 1).length}</strong></span>
          <span>Missed <strong>{data.attempts.filter((a) => a.status === 'missed').length}</strong></span>
          <span>Average <strong>{pct(avg)}</strong></span>
          <span>Orientations attended <strong>{data.orientations.filter((o) => o.status === 'attended').length}</strong></span>
        </div>
      </div>

      {data.topics.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>By Topic</h3>
          <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 8 }}>Every exam that tested the topic, oldest first. Weakest topics on top.</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Topic</th><th style={{ textAlign: 'right' }}>Latest</th><th>Change</th><th>History</th></tr></thead>
              <tbody>
                {data.topics.map((t) => (
                  <tr key={t.topic_id || 0}>
                    <td style={{ fontWeight: 600 }}>{t.topic}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{pct(t.latest)}</td>
                    <td>{trend(t)}</td>
                    <td style={{ whiteSpace: 'normal' }}>
                      {t.scores.map((s, i) => (
                        <span key={s.attempt_id} title={`${s.title} · ${fmtDay(s.date)}`}>
                          {i > 0 && <span className="muted"> → </span>}
                          <Link className="link-btn" to={`/hrd/exams/attempts/${s.attempt_id}`}>{pct(s.percent)}</Link>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Exams</h3>
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Exam</th><th>Set</th><th>Window</th><th>Status</th><th style={{ textAlign: 'right' }}>Score</th><th>Result</th><th>Submitted</th><th /></tr></thead>
            <tbody>
              {data.attempts.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No exams.</td></tr>}
              {data.attempts.map((a) => (
                <tr key={a.id}>
                  <td data-label="Exam" style={{ fontWeight: 600 }}>{a.title}{a.retake_of_attempt_id ? <span className="badge badge-muted" style={{ marginLeft: 4 }}>Retake</span> : null}</td>
                  <td data-label="Set">{a.set_name}</td>
                  <td data-label="Window">{fmtDay(a.start_date)} — {fmtDay(a.end_date)}</td>
                  <td data-label="Status"><span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABELS[a.status]}</span></td>
                  <td data-label="Score" style={{ textAlign: 'right' }}>{a.status === 'submitted' ? `${a.score} / ${a.max_score} (${pct(a.percent)})` : '—'}</td>
                  <td data-label="Result">{a.status !== 'submitted' ? '' : Number(a.essays_pending) ? <span className="badge badge-warning">Essays to grade</span>
                    : Number(a.passed) ? <span className="badge badge-success">Passed</span> : <span className="badge badge-danger">Below passing</span>}</td>
                  <td data-label="Submitted">{fmtDay(a.submitted_at) || '—'}</td>
                  <td>{['submitted', 'missed'].includes(a.status) && <Link className="btn btn-sm" to={`/hrd/exams/attempts/${a.id}`}>View</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {courses.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Training Courses</h3>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Course</th><th>Window</th><th>Materials</th><th>Quizzes Passed</th><th style={{ textAlign: 'right' }}>Progress</th><th>Completed</th><th /></tr></thead>
              <tbody>
                {courses.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Course" style={{ fontWeight: 600 }}>{t.title}</td>
                    <td data-label="Window">{fmtDay(t.start_date)} — {fmtDay(t.end_date)}</td>
                    <td data-label="Materials">{t.materials_done} / {t.materials}</td>
                    <td data-label="Quizzes Passed">{t.quizzes_passed} / {t.quizzes}</td>
                    <td data-label="Progress" style={{ textAlign: 'right', fontWeight: 600 }}>{t.percent}%</td>
                    <td data-label="Completed">{t.completed_at ? <span className="badge badge-success">{fmtDay(t.completed_at)}</span> : '—'}</td>
                    <td><Link className="btn btn-sm" to={`/hrd/training/assignments/${t.assignment_id}`}>Progress</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Re-orientation</h3>
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Orientation</th><th>Topic Score</th><th>From Exam</th><th>Status</th><th>Scheduled</th><th>Attended</th><th>Notes</th></tr></thead>
            <tbody>
              {data.orientations.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>None.</td></tr>}
              {data.orientations.map((o) => (
                <tr key={o.id}>
                  <td data-label="Orientation" style={{ fontWeight: 600 }}>{o.orientation_name || `${o.topic} Orientation`}</td>
                  <td data-label="Topic Score">{pct(o.topic_percent)}</td>
                  <td data-label="From Exam"><Link className="link-btn" to={`/hrd/exams/attempts/${o.attempt_id}`}>{o.exam_title}</Link></td>
                  <td data-label="Status"><span className={`badge ${ORIENTATION_BADGE[o.status]}`}>{ORIENTATION_LABELS[o.status]}</span></td>
                  <td data-label="Scheduled">{fmtDay(o.scheduled_date) || '—'}</td>
                  <td data-label="Attended">{fmtDay(o.attended_date) || '—'}</td>
                  <td data-label="Notes">{o.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
