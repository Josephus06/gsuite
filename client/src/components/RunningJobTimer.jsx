import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { parseUtc } from '../utils/datetime';

// The artist's running layout timer, floating over whatever page they are on. Without it,
// holding or finishing a job means navigating back to Assigned JO and opening the order --
// so a job left running while the artist works elsewhere in the system silently accrues
// time against them.
//
// Rendered for everyone; it draws nothing unless this user actually has a timer running,
// which is what keeps it out of the way of every non-artist account.

const POSITION_KEY = 'runningJobTimer.pos';
// The list/run screens show the same timer in full, so the floating copy would be a second
// clock on the same job -- confusing when the two tick a frame apart.
const HIDE_ON = [/^\/assigned-jo(\/|$)/];

function formatDuration(totalSeconds) {
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.round(Math.abs(totalSeconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}:${pad(abs % 60)}`;
}

function loadPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
  } catch { /* a corrupt entry just means the default corner */ }
  return { x: window.innerWidth - 260, y: window.innerHeight - 190 };
}

export default function RunningJobTimer() {
  const navigate = useNavigate();
  const location = useLocation();
  const [running, setRunning] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pos, setPos] = useState(loadPosition);
  const drag = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/assigned-jo/running');
      setRunning(data.running || null);
    } catch {
      // A 403 is the normal answer for anyone without the Assigned JO page -- not an error
      // worth showing, just a reason to draw nothing.
      setRunning(null);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, location.pathname]);

  // Polled slowly: the clock below ticks locally, so this only has to notice a timer being
  // started or stopped in another tab.
  useEffect(() => {
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Dragging is done on the window rather than the card, so a fast pointer that outruns the
  // element still moves it instead of dropping it mid-gesture.
  useEffect(() => {
    function onMove(e) {
      if (!drag.current) return;
      const x = Math.min(Math.max(0, e.clientX - drag.current.dx), window.innerWidth - 180);
      const y = Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - 60);
      setPos({ x, y });
    }
    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      setPos((p) => { localStorage.setItem(POSITION_KEY, JSON.stringify(p)); return p; });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  if (!running || HIDE_ON.some((re) => re.test(location.pathname))) return null;

  const base = `/assigned-jo${running.kind === 'NSTDJO' ? '/nstdjo' : ''}/${running.id}`;
  const elapsed = Number(running.consumed_seconds || 0)
    + (now - parseUtc(running.started_at).getTime()) / 1000;
  const allotted = Number(running.minutes_consume || 0) * Number(running.layout_qty || 1) * 60;
  const remaining = allotted - elapsed;
  const overdue = allotted > 0 && remaining < 0;

  async function act(action) {
    if (action === 'finish' && !window.confirm(
      `Mark ${running.job_order_no} as done? This records ${formatDuration(elapsed)} as the actual time consumed.`,
    )) return;
    setBusy(action);
    setError('');
    try {
      await api.put(`${base}/${action === 'hold' ? 'hold-layout' : 'finish-layout'}`);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || `Could not ${action} this job.`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div
      className={`running-timer${overdue ? ' overdue' : ''}`}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => {
        // Only the card itself drags -- starting a drag from a button would make Hold and
        // Done fire on any slight movement.
        if (e.target.closest('button')) return;
        drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      }}
    >
      <div className="running-timer-head">
        <button
          type="button"
          className="running-timer-no"
          title="Open this job"
          onClick={() => navigate(base)}
        >
          {running.job_order_no}
        </button>
        <span className="running-timer-grip" title="Drag to move">⠿</span>
      </div>

      <div className="running-timer-clock">{formatDuration(elapsed)}</div>
      {allotted > 0 && (
        <div className="running-timer-sub">
          {overdue ? `Overdue by ${formatDuration(remaining)}` : `${formatDuration(remaining)} left`}
        </div>
      )}

      {error && <div className="running-timer-error">{error}</div>}

      <div className="running-timer-actions">
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act('hold')}>
          {busy === 'hold' ? '…' : 'Hold'}
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('finish')}>
          {busy === 'finish' ? '…' : 'Done'}
        </button>
      </div>
    </div>
  );
}
