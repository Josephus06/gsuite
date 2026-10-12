import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { chime } from '../utils/notificationSound';
import Avatar from './Avatar';

// Messenger-style chat (2026-10-12; routes/chat.js). Mounted once in Layout, so it lives on every
// page: chatboxes dock at the bottom right, and a message from someone opens their box on your
// screen wherever you are, with a chime. Only for users with the Chat permission (/chat).
//
// Open a box from anywhere with openChat(user) -- the Dashboard's people list does.
const RETRY_MS = 3000; // wait after a failed poll before trying again
const MAX_BOXES = 3;

export function openChat(user) {
  window.dispatchEvent(new CustomEvent('chat:open', { detail: user }));
}

const timeOf = (v) => (v ? new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
const dayOf = (v) => (v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

export default function ChatDock() {
  const { user, can } = useAuth();
  const enabled = !!user && can('/chat', 'can_view');
  const [boxes, setBoxes] = useState([]); // { user, messages, minimized, hasMore, loading }
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const lastIdRef = useRef(null);

  const markRead = useCallback((otherId) => {
    api.post(`/chat/read/${otherId}`).catch(() => {});
    window.dispatchEvent(new CustomEvent('chat:read', { detail: otherId }));
  }, []);

  // Open (or bring forward) a box and load its conversation.
  const open = useCallback(async (u, { focus = true } = {}) => {
    if (!u?.id) return;
    const existing = boxesRef.current.find((b) => b.user.id === u.id);
    if (existing) {
      if (focus) setBoxes((bs) => bs.map((b) => (b.user.id === u.id ? { ...b, minimized: false } : b)));
      return;
    }
    setBoxes((bs) => {
      const next = [...bs, { user: u, messages: [], minimized: !focus, hasMore: false, loading: true }];
      return next.length > MAX_BOXES ? next.slice(next.length - MAX_BOXES) : next;
    });
    try {
      const { data } = await api.get(`/chat/thread/${u.id}`);
      setBoxes((bs) => bs.map((b) => (b.user.id === u.id
        ? { ...b, user: { ...b.user, ...(data.user || {}) }, messages: data.messages, hasMore: data.has_more, loading: false }
        : b)));
      if (focus) markRead(u.id);
    } catch {
      setBoxes((bs) => bs.map((b) => (b.user.id === u.id ? { ...b, loading: false } : b)));
    }
  }, [markRead]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onOpen = (e) => open(e.detail);
    window.addEventListener('chat:open', onOpen);
    return () => window.removeEventListener('chat:open', onOpen);
  }, [enabled, open]);

  // The poll: new messages to or from me. A message from someone opens their box.
  //
  // LONG POLL (2026-10-12): each request waits on the server until a message arrives (up to 25 s)
  // and the next one goes out the moment it returns, so a message shows as soon as it is sent --
  // not up to 4 seconds later, as the old interval had it. After an error it backs off.
  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    const ctrl = new AbortController();
    async function poll() {
      try {
        if (lastIdRef.current === null) {
          const { data } = await api.get('/chat/poll', { signal: ctrl.signal });
          lastIdRef.current = data.last_id;
          // Unread waiting from before this page loaded: open those boxes, minimized.
          for (const p of data.pending || []) open(p, { focus: false });
          return true;
        }
        const { data } = await api.get('/chat/poll', { params: { after: lastIdRef.current, wait: 1 }, signal: ctrl.signal, timeout: 40000 });
        if (stopped) return true;
        lastIdRef.current = data.last_id;
        let incoming = false;
        for (const m of data.messages || []) {
          const mine = m.sender_user_id === user.id;
          const other = { id: m.other_id, display_name: m.other_name, avatar_data: m.other_avatar };
          const box = boxesRef.current.find((b) => b.user.id === other.id);
          if (box) {
            setBoxes((bs) => bs.map((b) => (b.user.id === other.id && !b.messages.some((x) => x.id === m.id)
              ? { ...b, messages: [...b.messages, m], minimized: mine ? b.minimized : false }
              : b)));
            if (!mine) markRead(other.id);
          } else if (!mine) {
            open(other); // loads the thread, which already holds this message
          }
          if (!mine) incoming = true;
        }
        if (incoming) chime();
        return true;
      } catch {
        return false; // offline, server restarting, or the tab is closing
      }
    }
    (async () => {
      while (!stopped) {
        const ok = await poll();
        if (!ok && !stopped) await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    })();
    return () => { stopped = true; ctrl.abort(); };
  }, [enabled, user?.id, open, markRead]);

  if (!enabled || !boxes.length) return null;

  const close = (id) => setBoxes((bs) => bs.filter((b) => b.user.id !== id));
  const toggle = (id) => setBoxes((bs) => bs.map((b) => {
    if (b.user.id !== id) return b;
    if (b.minimized) markRead(id);
    return { ...b, minimized: !b.minimized };
  }));
  const append = (id, m) => setBoxes((bs) => bs.map((b) => (b.user.id === id && !b.messages.some((x) => x.id === m.id)
    ? { ...b, messages: [...b.messages, m] } : b)));
  const loadOlder = async (id) => {
    const box = boxesRef.current.find((b) => b.user.id === id);
    if (!box?.messages.length) return;
    const { data } = await api.get(`/chat/thread/${id}`, { params: { before: box.messages[0].id } });
    setBoxes((bs) => bs.map((b) => (b.user.id === id ? { ...b, messages: [...data.messages, ...b.messages], hasMore: data.has_more } : b)));
  };

  return (
    <div className="chat-dock">
      {boxes.map((b) => (
        <ChatBox key={b.user.id} box={b} meId={user.id}
          onClose={() => close(b.user.id)} onToggle={() => toggle(b.user.id)}
          onSent={(m) => append(b.user.id, m)} onOlder={() => loadOlder(b.user.id)} />
      ))}
    </div>
  );
}

function ChatBox({ box, meId, onClose, onToggle, onSent, onOlder }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const newestRef = useRef(null);

  // Jump to the newest message when one arrives or the box opens -- not when older ones load above.
  const newest = box.messages[box.messages.length - 1]?.id;
  useEffect(() => {
    const el = listRef.current;
    if (el && newest !== newestRef.current) el.scrollTop = el.scrollHeight;
    newestRef.current = newest;
  }, [newest]);
  useEffect(() => {
    const el = listRef.current;
    if (el && !box.minimized) el.scrollTop = el.scrollHeight;
  }, [box.minimized]);

  useEffect(() => { if (!box.minimized) inputRef.current?.focus(); }, [box.minimized]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true); setError('');
    try {
      const { data } = await api.post('/chat/send', { to: box.user.id, body });
      onSent(data);
      setDraft('');
    } catch (e) { setError(e.response?.data?.error || 'Not sent.'); }
    setSending(false);
    inputRef.current?.focus();
  }

  let prevDay = '';
  return (
    <div className={`chat-box ${box.minimized ? 'is-min' : ''}`}>
      <div className="chat-box-head" onClick={onToggle} title={box.minimized ? 'Open' : 'Minimize'}>
        <span className="chat-box-avatar">
          <Avatar user={box.user} size={28} />
          {box.user.online && <span className="chat-online-dot" />}
        </span>
        <span className="chat-box-name">{box.user.display_name}</span>
        <button type="button" className="chat-box-btn" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
      </div>
      {!box.minimized && (
        <>
          <div className="chat-box-list" ref={listRef}>
            {box.hasMore && <button type="button" className="chat-older" onClick={onOlder}>Earlier messages</button>}
            {box.loading && <div className="chat-empty">Loading…</div>}
            {!box.loading && !box.messages.length && <div className="chat-empty">Say hi to {box.user.display_name}.</div>}
            {box.messages.map((m) => {
              const d = dayOf(m.created_at);
              const showDay = d !== prevDay;
              prevDay = d;
              const mine = m.sender_user_id === meId;
              return (
                <div key={m.id}>
                  {showDay && <div className="chat-day">{d}</div>}
                  <div className={`chat-msg ${mine ? 'mine' : ''}`} title={timeOf(m.created_at)}>
                    <div className="chat-bubble">{m.body}</div>
                    <div className="chat-time">{timeOf(m.created_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
          {error && <div className="chat-error">{error}</div>}
          <div className="chat-box-input">
            <textarea ref={inputRef} rows={1} value={draft} placeholder="Aa" maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button type="button" className="chat-send" disabled={sending || !draft.trim()} onClick={send}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}
