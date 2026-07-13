import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

// Where the production employee actually runs the clock for one assigned process
// (Play/Hold/Stop live here, not on the Scheduled JO list) -- shows a countdown from
// the process's allotted minutes (Total material needed x the process's Minutes per
// Unit rate), and a Session Log of every Play/Hold/Resume/Stop. Mirrors
// AssignedJobOrderRun.jsx's pattern exactly, just against a process instead of a whole
// JO's layout task.
function formatDuration(totalSeconds) {
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDateTime(v) {
  return v ? new Date(v).toLocaleString() : '—';
}

export default function ScheduledJobOrderRun() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [proc, setProc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  function load() {
    return api.get(`/scheduled-jo/process/${id}`).then(({ data }) => { setProc(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  const openSession = proc?.sessions?.find((s) => !s.ended_at) || null;
  const isRunning = !!openSession;

  useEffect(() => {
    if (!isRunning) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  async function runAction(action) {
    setBusy(true);
    setError('');
    try {
      await api.put(`/scheduled-jo/process/${id}/${action}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !proc) return <LoadingSpinner />;

  const sessions = proc.sessions || [];
  const closedSeconds = sessions
    .filter((s) => s.ended_at)
    .reduce((sum, s) => sum + (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000, 0);
  const liveSeconds = openSession ? (now - new Date(openSession.started_at).getTime()) / 1000 : 0;
  const actualSeconds = closedSeconds + liveSeconds;
  const allottedSeconds = Number(proc.allotted_minutes || 0) * 60;
  const remainingSeconds = allottedSeconds - actualSeconds;
  const overdue = remainingSeconds < 0;
  const performance = actualSeconds > 0 && allottedSeconds > 0 ? (allottedSeconds / actualSeconds) * 100 : null;

  const isCompleted = !!proc.assignment_ended_at;
  const notStarted = !proc.assignment_started_at;

  return (
    <div>
      <div className="page-header">
        <div />
        <button className="btn btn-sm" onClick={() => navigate('/scheduled-jo')}>Back to Scheduled JO</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Scheduled JO</h1>
          <span className="estimate-no">{proc.job_order_no}</span>
        </div>
        <div className="estimate-status">{proc.process_name}</div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Job</h4>
            <div>Customer : <span className="hi">{proc.customer_name}</span></div>
            <div>Job Desc. : <span className="hi">{proc.description}</span></div>
            <div>Process : <span className="hi">{proc.process_name}</span></div>
            <div>Assigned To : <span className="hi">{proc.assigned_employee_name}</span></div>
            <div>Total (Material Needed) : <span className="hi">{proc.total}</span></div>
            <div>Minutes per Unit : <span className="hi">{proc.minutes_per_unit ?? 0}</span></div>
            <div>Allotted Minutes : <span className="hi">{Number(proc.allotted_minutes || 0).toFixed(0)} mins</span></div>
          </div>
          <div>
            <h4>Actual</h4>
            <div>Actual Start : <span className="hi">{formatDateTime(proc.assignment_started_at)}</span></div>
            <div>Actual End : <span className="hi">{formatDateTime(proc.assignment_ended_at)}</span></div>
            <div>Performance % : <span className="hi">{performance === null ? '—' : `${performance.toFixed(1)}%`}</span></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'center', marginTop: 20 }}>
        <p className="muted" style={{ marginBottom: 4 }}>Time Remaining</p>
        <div className="hi-lg" style={{ fontSize: 40, color: overdue ? 'var(--danger)' : undefined }}>
          {overdue ? `Overdue by ${formatDuration(remainingSeconds)}` : formatDuration(remainingSeconds)}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
          {!proc.is_owner && (
            <span className="muted">Read-only — this process is assigned to {proc.assigned_employee_name}, not you.</span>
          )}
          {proc.is_owner && !isCompleted && !isRunning && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => runAction('start')}>
              ▶ {notStarted ? 'Play' : 'Resume'}
            </button>
          )}
          {proc.is_owner && !isCompleted && isRunning && (
            <button type="button" className="btn btn-warning" disabled={busy} onClick={() => runAction('hold')}>⏸ Hold</button>
          )}
          {proc.is_owner && !isCompleted && !notStarted && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => runAction('finish')}>■ Stop</button>
          )}
          {isCompleted && <span className="badge badge-success">Completed</span>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Session Log</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Started At</th><th>Ended At</th><th>Duration</th></tr>
            </thead>
            <tbody>
              {sessions.length === 0 && (
                <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>Not started yet.</td></tr>
              )}
              {sessions.map((s, idx) => {
                const duration = s.ended_at
                  ? (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000
                  : liveSeconds;
                return (
                  <tr key={s.id}>
                    <td>{idx + 1}</td>
                    <td>{formatDateTime(s.started_at)}</td>
                    <td>{s.ended_at ? formatDateTime(s.ended_at) : <span className="hi">Running…</span>}</td>
                    <td>{formatDuration(duration)}</td>
                  </tr>
                );
              })}
            </tbody>
            {sessions.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={3}><strong>Total Actual Time Consumed</strong></td>
                  <td><strong>{formatDuration(actualSeconds)}</strong></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
