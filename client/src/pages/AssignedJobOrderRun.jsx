import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

// Where the artist actually runs the layout timer for one assigned JO (Play/Hold/Stop
// live here, not on the Assigned JO list) -- shows a countdown from the PMS Job Type's
// allotted minutes_consume, and a Session Log of every Play/Hold/Resume/Stop so it's
// clear when the clock was running vs held.
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

export default function AssignedJobOrderRun() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [jo, setJo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  function load() {
    return api.get(`/assigned-jo/${id}`).then(({ data }) => { setJo(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  const openSession = jo?.sessions?.find((s) => !s.ended_at) || null;
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
      await api.put(`/assigned-jo/${id}/${action}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !jo) return <LoadingSpinner />;

  const sessions = jo.sessions || [];
  const closedSeconds = sessions
    .filter((s) => s.ended_at)
    .reduce((sum, s) => sum + (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000, 0);
  const liveSeconds = openSession ? (now - new Date(openSession.started_at).getTime()) / 1000 : 0;
  const actualSeconds = closedSeconds + liveSeconds;
  // minutes_consume is the allotment for ONE unit of this layout task -- scaled by the
  // Qty entered when the artist was assigned (server-side, jobOrders.js's assign-design
  // route computes planned_end_at the same way, so this stays consistent with that).
  const allottedSeconds = Number(jo.minutes_consume || 0) * Number(jo.layout_qty || 1) * 60;
  const remainingSeconds = allottedSeconds - actualSeconds;
  const overdue = remainingSeconds < 0;
  const performance = actualSeconds > 0 && allottedSeconds > 0 ? (allottedSeconds / actualSeconds) * 100 : null;
  // The countdown never actually stops at zero -- actualSeconds keeps accruing off the
  // live `now` tick above regardless of overdue, which is what naturally drags
  // `performance` down the longer this runs past its allotted time. These two flags just
  // decide when to surface that on screen: a heads-up with 30s or less left, then a
  // persistent reminder once it's actually run over, so it's never a surprise.
  const nearingLimit = isRunning && !overdue && remainingSeconds <= 30;
  const pastLimit = isRunning && overdue;

  const isCompleted = !!jo.layout_ended_at;
  const notStarted = !jo.layout_started_at;

  return (
    <div>
      <div className="page-header">
        <div />
        <button className="btn btn-sm" onClick={() => navigate('/assigned-jo')}>Back to Assigned JO</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {nearingLimit && (
        <div className="warning-banner timer-notice-pulse">
          ⚠ Less than 30 seconds remaining on this Job Order — Hold or Stop it now.
        </div>
      )}
      {pastLimit && (
        <div className="error-banner">
          ⏱ Time limit reached. This Job Order is still running — every extra second now counts against your Performance %. End it now.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Assigned JO</h1>
          <span className="estimate-no">{jo.job_order_no}</span>
        </div>
        <div className="estimate-status">{jo.sub_status}</div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Job</h4>
            <div>Customer : <span className="hi">{jo.customer_name}</span></div>
            <div>Job Desc. : <span className="hi">{jo.description}</span></div>
            <div>Layout - Job Type : <span className="hi">{jo.pms_job_type_name ? `${jo.pms_job_type_code} — ${jo.pms_job_type_name}` : '—'}</span></div>
            <div>Minutes Consume (Allotted) : <span className="hi">{jo.minutes_consume ?? 0} mins × {jo.layout_qty ?? 1} qty = {allottedSeconds / 60} mins</span></div>
          </div>
          <div>
            <h4>Planned</h4>
            <div>Planned Start : <span className="hi">{formatDateTime(jo.planned_start_at)}</span></div>
            <div>Planned End : <span className="hi">{formatDateTime(jo.planned_end_at)}</span></div>
          </div>
          <div>
            <h4>Actual</h4>
            <div>Actual Start : <span className="hi">{formatDateTime(jo.layout_started_at)}</span></div>
            <div>Actual End : <span className="hi">{formatDateTime(jo.layout_ended_at)}</span></div>
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
          {!isCompleted && !isRunning && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => runAction('start-layout')}>
              ▶ {notStarted ? 'Play' : 'Resume'}
            </button>
          )}
          {!isCompleted && isRunning && (
            <button type="button" className="btn btn-warning" disabled={busy} onClick={() => runAction('hold-layout')}>⏸ Hold</button>
          )}
          {!isCompleted && !notStarted && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => runAction('finish-layout')}>■ Stop</button>
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
