import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const POLL_MS = 5000;
const TOAST_MS = 6000;

function formatTime(v) {
  return v ? new Date(v).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';
}

// Bell + unread badge in the topnav, plus a toast popup for anything that arrives
// after mount -- polled every 5s (same setInterval pattern as ChatWidget's ticket
// thread) plus an immediate extra poll whenever the tab regains focus/visibility, so
// coming back from another tab/app doesn't leave you waiting out the rest of the
// interval. General enough to cover any future notification type -- tickets.js fires
// one on creation (pending approval), on approval (ready to work), and on resolution.
export default function NotificationBell() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const lastSeenMaxId = useRef(null);
  const rootRef = useRef(null);

  async function poll() {
    try {
      const { data } = await api.get('/notifications');
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);

      if (lastSeenMaxId.current === null) {
        // First load -- establish the baseline silently, don't toast a backlog of
        // everything that was already unread before this session started.
        lastSeenMaxId.current = data.notifications[0]?.id || 0;
        return;
      }
      const fresh = data.notifications.filter((n) => n.id > lastSeenMaxId.current);
      if (fresh.length) {
        lastSeenMaxId.current = Math.max(...data.notifications.map((n) => n.id));
        setToasts((prev) => [...prev, ...fresh]);
        fresh.forEach((n) => {
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== n.id)), TOAST_MS);
        });
      }
    } catch {
      // Polling hiccup -- just try again next tick, not worth surfacing to the user.
    }
  }

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    function onVisible() { if (document.visibilityState === 'visible') poll(); }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onClickOutside(e) {
      if (open && rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function openNotification(n) {
    setOpen(false);
    if (!n.is_read) {
      try {
        await api.put(`/notifications/${n.id}/read`);
        setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
        setUnreadCount((c) => Math.max(0, c - 1));
      } catch {
        // Non-critical -- worst case it just stays "unread" until the next poll settles it.
      }
    }
    if (n.related_type === 'Ticket' && n.related_id) navigate(`/tickets/${n.related_id}`);
  }

  async function markAllRead() {
    try {
      await api.put('/notifications/read-all');
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch {
      // Non-critical.
    }
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <>
      <div ref={rootRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="Notifications"
          style={{
            position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 18, padding: 4, lineHeight: 1,
          }}
        >
          🔔
          {unreadCount > 0 && (
            <span
              style={{
                position: 'absolute', top: -2, right: -2, background: 'var(--danger, #e05252)', color: '#fff',
                borderRadius: '999px', fontSize: 10, minWidth: 16, height: 16, display: 'flex',
                alignItems: 'center', justifyContent: 'center', padding: '0 4px', fontWeight: 600,
              }}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>

        {open && (
          <div
            className="card"
            style={{
              position: 'absolute', right: 0, top: '100%', marginTop: 8, width: 320, maxHeight: 400,
              overflowY: 'auto', padding: 0, zIndex: 300, boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <strong style={{ fontSize: 14 }}>Notifications</strong>
              {unreadCount > 0 && (
                <button type="button" className="btn btn-sm" onClick={markAllRead}>Mark all read</button>
              )}
            </div>
            {notifications.length === 0 && (
              <div className="muted" style={{ padding: 16, textAlign: 'center' }}>No notifications yet.</div>
            )}
            {notifications.map((n) => (
              <div
                key={n.id}
                onClick={() => openNotification(n)}
                style={{
                  padding: '10px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                  background: n.is_read ? 'transparent' : 'var(--panel-2, #f3f4f6)',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: n.is_read ? 400 : 600 }}>{n.title}</div>
                {n.message && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{n.message}</div>}
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{formatTime(n.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 400, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            className="card"
            onClick={() => { dismissToast(t.id); openNotification(t); }}
            style={{ width: 300, padding: 12, cursor: 'pointer', boxShadow: '0 8px 30px rgba(0,0,0,0.3)', borderLeft: '3px solid var(--accent)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{t.title}</strong>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, opacity: 0.6 }}
              >
                ✕
              </button>
            </div>
            {t.message && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t.message}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
