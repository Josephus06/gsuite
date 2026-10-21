import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { STATUS_BADGE, STATUS_LABELS, download, fmtDay, pct } from '../../utils/exams';

// Forms > My Exams (2026-10-21; routes/exams.js): the exams HR scheduled for you -- to take while
// the window is open, and your results after.
export default function MyExams() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/exams/my').then(({ data }) => setRows(data)).catch((e) => { setRows([]); setError(e.response?.data?.error || 'Could not load your exams.'); });
  }, []);

  const result = (r) => {
    if (r.status !== 'submitted') return '—';
    if (r.essays_pending > 0) return <span>{pct(r.percent)} <span className="muted" style={{ fontSize: 11 }}>so far · essays being graded</span></span>;
    return <span>{pct(r.percent)} {r.passed ? <span className="badge badge-success">Passed</span> : <span className="badge badge-danger">Below passing</span>}</span>;
  };

  return (
    <div>
      <div className="page-header"><h1>My Exams</h1></div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card">
        {!rows ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Exam</th><th>Set</th><th>Take it between</th><th>Questions</th><th>Time Limit</th><th>Status</th><th>Result</th><th /></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No exams scheduled for you.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Exam" style={{ fontWeight: 600 }}>{r.title}</td>
                    <td data-label="Set">{r.set_name}</td>
                    <td data-label="Take it between">{fmtDay(r.start_date)} — {fmtDay(r.end_date)}</td>
                    <td data-label="Questions">{r.question_count}</td>
                    <td data-label="Time Limit">{r.time_limit_minutes ? `${r.time_limit_minutes} min` : 'None'}</td>
                    <td data-label="Status"><span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{STATUS_LABELS[r.status] || r.status}</span>
                      {r.auto_submitted ? <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>time ran out</span> : null}</td>
                    <td data-label="Result">{result(r)}</td>
                    <td>
                      {r.can_start && <Link className="btn btn-sm btn-primary" to={`/exams/${r.id}`}>{r.status === 'in_progress' ? 'Continue' : 'Take Exam'}</Link>}
                      {r.not_yet_open && <span className="muted" style={{ fontSize: 12 }}>Opens {fmtDay(r.start_date)}</span>}
                      {r.status === 'submitted' && <Link className="btn btn-sm" to={`/exams/${r.id}`}>View Result</Link>}
                      {r.certificate && (
                        <button className="btn btn-sm" style={{ marginLeft: 4 }} title="Certificate of Completion"
                          onClick={() => download(`/exams/attempts/${r.id}/certificate`, `certificate-${r.id}.pdf`).catch(() => window.alert('Could not download the certificate.'))}>
                          Certificate
                        </button>
                      )}
                    </td>
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
