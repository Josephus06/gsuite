import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Avatar from './Avatar';
import { openChat, openGroupChat } from './ChatDock';
import { parseUtc } from '../utils/datetime';

// The Messenger icon in the top bar (asked 2026-10-14): every recent conversation and group chat in
// one dropdown, newest first, with the last message and an unread dot -- Facebook's Messenger menu.
// Clicking one opens its chat box (ChatDock). The badge counts conversations with something unread.
// Refreshed on open, when a message arrives or is read (ChatDock's events), and every REFRESH_MS.
const REFRESH_MS = 20000;
const TABS = [{ key: 'all', label: 'All' }, { key: 'unread', label: 'Unread' }, { key: 'groups', label: 'Groups' }];

// "2m", "3h", "Mon", "Oct 9" -- how long ago, as the Messenger list writes it.
function ago(v) {
  const d = parseUtc(v);
  if (!d || Number.isNaN(d.getTime())) return '';
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  if (hrs < 24 * 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function GroupBadge({ name, size = 44 }) {
  const letters = String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--primary, #4f46e5)', color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size / 2.8, flexShrink: 0,
    }}>{letters || '#'}</span>
  );
}

function MessengerGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.19 5.44 3.14 7.17.16.14.26.35.27.57l.05 1.78c.02.57.6.94 1.12.71l1.98-.87c.17-.08.36-.09.54-.04.91.25 1.87.38 2.9.38 5.64 0 10-4.13 10-9.7S17.64 2 12 2zm6 7.46-2.94 4.66a1.5 1.5 0 0 1-2.17.4l-2.34-1.75a.6.6 0 0 0-.72 0l-3.16 2.4c-.42.32-.97-.18-.69-.63l2.94-4.66a1.5 1.5 0 0 1 2.17-.4l2.34 1.75c.21.16.51.16.72 0l3.16-2.4c.42-.32.97.18.69.63z" />
    </svg>
  );
}

export default function MessengerMenu() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const enabled = can('/chat', 'can_view');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const rootRef = useRef(null);

  const load = useCallback(() => {
    api.get('/chat/recent').then(({ data }) => { setRows(Array.isArray(data) ? data : []); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const t = setInterval(load, REFRESH_MS);
    // A box read a conversation: its dot goes now, not at the next refresh.
    const onRead = (e) => setRows((rs) => rs.map((r) => (r.kind === 'dm' && r.id === e.detail ? { ...r, unread: 0 } : r)));
    window.addEventListener('chat:read', onRead);
    window.addEventListener('chat:activity', load);
    window.addEventListener('chatgroup:changed', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('chat:read', onRead);
      window.removeEventListener('chat:activity', load);
      window.removeEventListener('chatgroup:changed', load);
    };
  }, [enabled, load]);

  // Close on a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!enabled) return null;

  const unreadChats = rows.filter((r) => r.unread > 0).length;
  const needle = q.trim().toLowerCase();
  const shown = rows
    .filter((r) => (tab === 'unread' ? r.unread > 0 : tab === 'groups' ? r.kind === 'group' : true))
    .filter((r) => !needle || String(r.name || '').toLowerCase().includes(needle) || String(r.preview || '').toLowerCase().includes(needle));

  function pick(r) {
    setOpen(false);
    if (r.kind === 'group') openGroupChat({ id: r.id, name: r.name });
    else openChat({ id: r.id, display_name: r.name, avatar_data: r.avatar_data });
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); if (!open) load(); }}
        title="Chats"
        aria-label={unreadChats ? `Chats, ${unreadChats} unread` : 'Chats'}
        style={{
          position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer',
          padding: 4, lineHeight: 1, color: 'var(--primary, #4f46e5)', display: 'inline-flex',
        }}
      >
        <MessengerGlyph />
        {unreadChats > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -4, background: 'var(--danger, #e05252)', color: '#fff',
            borderRadius: '999px', fontSize: 10, minWidth: 16, height: 16, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: '0 4px', fontWeight: 600,
          }}>{unreadChats > 99 ? '99+' : unreadChats}</span>
        )}
      </button>

      {open && (
        <div
          className="card"
          style={{
            position: 'absolute', right: 0, top: '100%', marginTop: 8, width: 360, maxWidth: 'calc(100vw - 24px)',
            padding: 0, zIndex: 300, boxShadow: '0 8px 30px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', maxHeight: '75vh',
          }}
        >
          <div style={{ padding: '12px 14px 8px' }}>
            <strong style={{ fontSize: 20 }}>Chats</strong>
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats"
              style={{ width: '100%', marginTop: 10, borderRadius: 999, padding: '7px 12px' }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              {TABS.map((t) => (
                <button
                  key={t.key} type="button" onClick={() => setTab(t.key)}
                  style={{
                    border: 'none', borderRadius: 999, padding: '5px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
                    background: tab === t.key ? 'color-mix(in srgb, var(--primary, #4f46e5) 15%, transparent)' : 'transparent',
                    color: tab === t.key ? 'var(--primary, #4f46e5)' : 'inherit',
                  }}
                >{t.label}</button>
              ))}
            </div>
          </div>

          <div style={{ overflowY: 'auto', padding: '0 6px 8px' }}>
            {!loaded && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>Loading...</div>}
            {loaded && shown.length === 0 && (
              <div className="muted" style={{ padding: 16, textAlign: 'center' }}>
                {needle ? 'No chats match.' : tab === 'unread' ? 'No unread chats.' : tab === 'groups' ? 'No group chats.' : 'No chats yet.'}
              </div>
            )}
            {shown.map((r) => (
              <button
                key={`${r.kind}-${r.id}`} type="button" onClick={() => pick(r)}
                className="messenger-row"
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none', borderRadius: 8, padding: '8px', cursor: 'pointer', color: 'inherit',
                }}
              >
                {/* A person's photo opens their profile and timeline; the rest of the row opens the chat. */}
                <span
                  style={{ position: 'relative', flexShrink: 0 }}
                  title={r.kind === 'dm' ? `View ${r.name}'s profile` : undefined}
                  onClick={r.kind === 'dm' ? (e) => { e.stopPropagation(); setOpen(false); navigate(`/profile/${r.id}`); } : undefined}
                >
                  {r.kind === 'group' ? <GroupBadge name={r.name} /> : <Avatar user={{ display_name: r.name, avatar_data: r.avatar_data }} size={44} />}
                  {r.online && (
                    <span style={{
                      position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: '50%',
                      background: '#31a24c', border: '2px solid var(--card-bg, #fff)',
                    }} />
                  )}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: r.unread ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name}
                  </span>
                  <span style={{
                    display: 'flex', gap: 4, fontSize: 12, fontWeight: r.unread ? 600 : 400,
                    color: r.unread ? 'inherit' : 'var(--muted, #6b7280)',
                  }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{r.preview}</span>
                    {r.last_at && <span style={{ flexShrink: 0 }}>· {ago(r.last_at)}</span>}
                  </span>
                </span>
                {r.unread > 0 && (
                  <span title={`${r.unread} unread`} style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--primary, #4f46e5)', flexShrink: 0 }} />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
