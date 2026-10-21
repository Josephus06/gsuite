import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { fmtDay } from '../../utils/exams';

// Forms > My Training (2026-10-21; routes/training.js): the courses HR assigned to you, each with
// its progress. Opening one is the course page.
export default function MyTraining() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/training/my').then(({ data }) => setRows(data)).catch((e) => { setRows([]); setError(e.response?.data?.error || 'Could not load your courses.'); });
  }, []);
  return (
    <div>
      <div className="page-header"><h1>My Training</h1></div>
      {error && <div className="error-banner">{error}</div>}
      {!rows ? <LoadingSpinner /> : rows.length === 0 ? (
        <div className="card muted">No courses assigned to you.</div>
      ) : (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {rows.map((r) => (
            <Link key={r.id} to={`/trainings/${r.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{r.title}</div>
                {r.completed_at ? <span className="badge badge-success">Completed</span>
                  : r.overdue ? <span className="badge badge-danger">Overdue</span> : null}
              </div>
              <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
                {r.materials_done} / {r.materials} Materials · {r.quizzes_passed} / {r.quizzes} Assessments
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--border, #e5e7eb)' }}>
                  <div style={{ width: `${r.percent}%`, height: '100%', borderRadius: 3, background: r.completed_at ? 'var(--success, #16a34a)' : 'var(--primary, #1d4ed8)' }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{r.percent}%</span>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                {r.completed_at ? `Completed ${fmtDay(r.completed_at)}` : `Finish by ${fmtDay(r.end_date)}`}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
