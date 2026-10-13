import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { chime } from '../utils/notificationSound';
import Avatar from './Avatar';
import { parseUtc } from '../utils/datetime';
import GroupChatBox from './GroupChatBox';

// Messenger-style chat (2026-10-12; routes/chat.js). Mounted once in Layout, so it lives on every
// page: chatboxes dock at the bottom right, and a message from someone opens their box on your
// screen wherever you are, with a chime. Only for users with the Chat permission (/chat).
//
// Open a box from anywhere with openChat(user) -- the Dashboard's people list does.
const RETRY_MS = 3000; // wait after a failed poll before trying again
const TYPING_EVERY_MS = 2000; // "I am typing" is sent at most this often while a draft is typed

// The newest of my messages in this list that the other person has read (0 = none).
const lastSeenIn = (messages, meId) => messages.reduce((n, m) => (m.sender_user_id === meId && m.read_at && m.id > n ? m.id : n), 0);
const MAX_BOXES = 3;

export function openChat(user) {
  window.dispatchEvent(new CustomEvent('chat:open', { detail: user }));
}
// A group chat's box (2026-10-13), from the Groups list. group: { id, name }
export function openGroupChat(group) {
  window.dispatchEvent(new CustomEvent('chatgroup:open', { detail: group }));
}

// chat_messages.created_at is written by the server in UTC (2026-10-12: a 3:40 PM message read
// "7:40 AM"), so it is read as UTC and shown in Philippine time, whatever the computer's own zone.
const timeOf = (v) => (v ? parseUtc(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');
const dayOf = (v) => (v ? parseUtc(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }) : '');

export default function ChatDock() {
  const { user, can } = useAuth();
  const enabled = !!user && can('/chat', 'can_view');
  const [boxes, setBoxes] = useState([]); // { user, messages, minimized, hasMore, loading }
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const lastIdRef = useRef(null);
  // Group chats (2026-10-13): their own boxes, and where "now" is in group messages.
  const [groupBoxes, setGroupBoxes] = useState([]); // { group, messages, minimized, hasMore, loading, unread }
  const groupBoxesRef = useRef(groupBoxes);
  groupBoxesRef.current = groupBoxes;
  const gLastIdRef = useRef(null);
  // Who is typing to me (user ids), and per conversation the newest of my messages they have seen.
  // Mirrored in refs so the poll can tell the server what is already on screen.
  const [typing, setTyping] = useState([]);
  const typingRef = useRef(typing);
  typingRef.current = typing;
  const [seen, setSeen] = useState({});
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const bumpSeen = useCallback((otherId, id) => {
    if (!id) return;
    setSeen((m) => ((m[otherId] || 0) >= id ? m : { ...m, [otherId]: id }));
  }, []);

  const markRead = useCallback((otherId) => {
    api.post(`/chat/read/${otherId}`).catch(() => {});
    window.dispatchEvent(new CustomEvent('chat:read', { detail: otherId }));
  }, []);

  // Open (or bring forward) a box and load its conversation.
  const open = useCallback(async (u, { focus = true } = {}) => {
    if (!u?.id) return;
    const existing = boxesRef.current.find((b) => b.user.id === u.id);
    if (existing) {
      if (focus) {
        setBoxes((bs) => bs.map((b) => (b.user.id === u.id ? { ...b, minimized: false, unread: 0 } : b)));
        if (existing.unread) markRead(u.id);
      }
      return;
    }
    setBoxes((bs) => {
      const next = [...bs, { user: u, messages: [], minimized: !focus, hasMore: false, loading: true, unread: 0 }];
      return next.length > MAX_BOXES ? next.slice(next.length - MAX_BOXES) : next;
    });
    try {
      const { data } = await api.get(`/chat/thread/${u.id}`);
      setBoxes((bs) => bs.map((b) => (b.user.id === u.id
        ? {
          ...b, user: { ...b.user, ...(data.user || {}) }, messages: data.messages, hasMore: data.has_more, loading: false,
          // Opened minimized (unread waiting from before the page loaded): its header counts them.
          unread: focus ? 0 : data.messages.filter((m) => m.sender_user_id !== user.id && !m.read_at).length,
        }
        : b)));
      bumpSeen(u.id, lastSeenIn(data.messages, user.id));
      if (focus) markRead(u.id);
    } catch {
      setBoxes((bs) => bs.map((b) => (b.user.id === u.id ? { ...b, loading: false } : b)));
    }
  }, [markRead, bumpSeen, user?.id]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onOpen = (e) => open(e.detail);
    window.addEventListener('chat:open', onOpen);
    return () => window.removeEventListener('chat:open', onOpen);
  }, [enabled, open]);

  const markGroupRead = useCallback((groupId) => {
    api.post(`/chat/groups/${groupId}/read`).then(() => window.dispatchEvent(new CustomEvent('chatgroup:changed'))).catch(() => {});
  }, []);

  // Open (or bring forward) a group's box and load its conversation.
  const openGroup = useCallback(async (g, { focus = true } = {}) => {
    if (!g?.id) return;
    const existing = groupBoxesRef.current.find((b) => b.group.id === g.id);
    if (existing) {
      if (focus) {
        setGroupBoxes((bs) => bs.map((b) => (b.group.id === g.id ? { ...b, minimized: false, unread: 0 } : b)));
        if (existing.unread) markGroupRead(g.id);
      }
      return;
    }
    setGroupBoxes((bs) => {
      const next = [...bs, { group: g, messages: [], minimized: !focus, hasMore: false, loading: true, unread: 0 }];
      return next.length > MAX_BOXES ? next.slice(next.length - MAX_BOXES) : next;
    });
    try {
      const { data } = await api.get(`/chat/groups/${g.id}/thread`);
      setGroupBoxes((bs) => bs.map((b) => (b.group.id === g.id
        ? {
          ...b, group: { ...b.group, ...(data.group || {}) }, messages: data.messages, hasMore: data.has_more, loading: false,
          unread: focus ? 0 : data.messages.filter((m) => m.sender_user_id !== user.id && m.id > (data.last_read_id || 0)).length,
        }
        : b)));
      if (focus) markGroupRead(g.id);
    } catch {
      setGroupBoxes((bs) => bs.map((b) => (b.group.id === g.id ? { ...b, loading: false } : b)));
    }
  }, [markGroupRead, user?.id]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onOpen = (e) => openGroup(e.detail);
    window.addEventListener('chatgroup:open', onOpen);
    return () => window.removeEventListener('chatgroup:open', onOpen);
  }, [enabled, openGroup]);

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
          gLastIdRef.current = data.g_last_id ?? 0;
          // Unread waiting from before this page loaded: open those boxes, minimized.
          for (const p of data.pending || []) open(p, { focus: false });
          for (const g of data.pending_groups || []) openGroup(g, { focus: false });
          return true;
        }
        // What is on screen, so the server holds the request until any of it changes.
        const openIds = boxesRef.current.map((b) => b.user.id);
        const { data } = await api.get('/chat/poll', {
          params: {
            after: lastIdRef.current, wait: 1, gafter: gLastIdRef.current ?? 0,
            typing: [...typingRef.current].sort((a, b) => a - b).join(','),
            open: openIds.join(','),
            seen: openIds.map((id) => `${id}:${seenRef.current[id] || 0}`).join(','),
          },
          signal: ctrl.signal, timeout: 40000,
        });
        if (stopped) return true;
        setTyping(Array.isArray(data.typing) ? data.typing : []);
        for (const [id, n] of Object.entries(data.seen || {})) bumpSeen(Number(id), Number(n));
        lastIdRef.current = data.last_id;
        let incoming = false;
        for (const m of data.messages || []) {
          const mine = m.sender_user_id === user.id;
          const other = { id: m.other_id, display_name: m.other_name, avatar_data: m.other_avatar };
          const box = boxesRef.current.find((b) => b.user.id === other.id);
          if (box) {
            // A minimized box stays minimized and counts the message as unread (2026-10-12), as a
            // chat head does; it is marked read when opened. An open box reads it straight away.
            const countIt = !mine && box.minimized;
            setBoxes((bs) => bs.map((b) => (b.user.id === other.id && !b.messages.some((x) => x.id === m.id)
              ? { ...b, messages: [...b.messages, m], unread: (b.unread || 0) + (countIt ? 1 : 0) }
              : b)));
            if (!mine && !countIt) markRead(other.id);
          } else if (!mine) {
            open(other); // loads the thread, which already holds this message
          }
          if (!mine) incoming = true;
        }
        // Group messages: into the group's box (counted unread while it is minimized), or a new
        // minimized box for a group that has none open.
        if (data.g_last_id != null) gLastIdRef.current = data.g_last_id;
        for (const m of data.group_messages || []) {
          const mine = m.sender_user_id === user.id;
          const box = groupBoxesRef.current.find((b) => b.group.id === m.group_id);
          if (box) {
            const countIt = !mine && box.minimized;
            setGroupBoxes((bs) => bs.map((b) => (b.group.id === m.group_id && !b.messages.some((x) => x.id === m.id)
              ? { ...b, messages: [...b.messages, m], unread: (b.unread || 0) + (countIt ? 1 : 0) }
              : b)));
            if (!mine && !countIt) markGroupRead(m.group_id);
          } else if (!mine) {
            openGroup({ id: m.group_id, name: m.group_name }, { focus: false });
          }
          if (!mine) incoming = true;
        }
        if ((data.group_messages || []).length) window.dispatchEvent(new CustomEvent('chatgroup:changed'));
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
  }, [enabled, user?.id, open, markRead, bumpSeen, openGroup, markGroupRead]);

  if (!enabled || (!boxes.length && !groupBoxes.length)) return null;

  const closeGroup = (id) => setGroupBoxes((bs) => bs.filter((b) => b.group.id !== id));
  const toggleGroup = (id) => setGroupBoxes((bs) => bs.map((b) => {
    if (b.group.id !== id) return b;
    if (b.minimized) markGroupRead(id);
    return { ...b, minimized: !b.minimized, unread: b.minimized ? 0 : b.unread };
  }));
  const appendGroup = (id, m) => setGroupBoxes((bs) => bs.map((b) => (b.group.id === id && !b.messages.some((x) => x.id === m.id)
    ? { ...b, messages: [...b.messages, m] } : b)));
  const loadOlderGroup = async (id) => {
    const box = groupBoxesRef.current.find((b) => b.group.id === id);
    if (!box?.messages.length) return;
    const { data } = await api.get(`/chat/groups/${id}/thread`, { params: { before: box.messages[0].id } });
    setGroupBoxes((bs) => bs.map((b) => (b.group.id === id ? { ...b, messages: [...data.messages, ...b.messages], hasMore: data.has_more } : b)));
  };
  // Renamed or members changed: refresh its header. Deleted or left: close it.
  const groupChanged = async (id, r) => {
    window.dispatchEvent(new CustomEvent('chatgroup:changed'));
    if (r?.deleted || r?.left) { closeGroup(id); return; }
    try {
      const { data } = await api.get(`/chat/groups/${id}/thread`);
      setGroupBoxes((bs) => bs.map((b) => (b.group.id === id ? { ...b, group: { ...b.group, ...(data.group || {}) } } : b)));
    } catch { /* keep what is shown */ }
  };

  const close = (id) => setBoxes((bs) => bs.filter((b) => b.user.id !== id));
  const toggle = (id) => setBoxes((bs) => bs.map((b) => {
    if (b.user.id !== id) return b;
    if (b.minimized) markRead(id);
    return { ...b, minimized: !b.minimized, unread: b.minimized ? 0 : b.unread };
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
          onSent={(m) => append(b.user.id, m)} onOlder={() => loadOlder(b.user.id)}
          isTyping={typing.includes(b.user.id)} seenId={seen[b.user.id] || 0} />
      ))}
      {groupBoxes.map((b) => (
        <GroupChatBox key={`g${b.group.id}`} box={b} meId={user.id}
          onClose={() => closeGroup(b.group.id)} onToggle={() => toggleGroup(b.group.id)}
          onSent={(m) => appendGroup(b.group.id, m)} onOlder={() => loadOlderGroup(b.group.id)}
          onGroupChanged={(r) => groupChanged(b.group.id, r)} />
      ))}
    </div>
  );
}

function ChatBox({ box, meId, onClose, onToggle, onSent, onOlder, isTyping, seenId }) {
  const lastTypingSent = useRef(0);
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
  }, [newest, isTyping]);
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
      lastTypingSent.current = 0; // the server cleared "typing" on send; the next key may say it again
    } catch (e) { setError(e.response?.data?.error || 'Not sent.'); }
    setSending(false);
    inputRef.current?.focus();
  }

  let prevDay = '';
  // "Seen" goes under the newest of my messages they have read, as Messenger shows it.
  const seenAt = box.messages.reduce((n, m) => (m.sender_user_id === meId && m.id <= seenId && m.id > n ? m.id : n), 0);
  return (
    <div className={`chat-box ${box.minimized ? 'is-min' : ''}`}>
      <div className="chat-box-head" onClick={onToggle} title={box.minimized ? 'Open' : 'Minimize'}>
        <span className="chat-box-avatar">
          <Avatar user={box.user} size={28} />
          {box.user.online && <span className="chat-online-dot" />}
        </span>
        <span className="chat-box-name">
          {box.user.display_name}
          {/* Minimized, the typing bubble inside the box cannot be seen -- say it on the header. */}
          {box.minimized && isTyping && <span className="chat-head-typing">typing…</span>}
        </span>
        {box.minimized && box.unread > 0 && (
          <span className="chat-unread" title={`${box.unread} unread message${box.unread === 1 ? '' : 's'}`}>
            {box.unread > 99 ? '99+' : box.unread}
          </span>
        )}
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
                    {mine && m.id === seenAt && <div className="chat-seen">Seen</div>}
                  </div>
                </div>
              );
            })}
            {isTyping && (
              <div className="chat-msg">
                <div className="chat-bubble chat-typing" title={`${box.user.display_name} is typing`}><span /><span /><span /></div>
                <div className="chat-time">{box.user.display_name} is typing…</div>
              </div>
            )}
          </div>
          {error && <div className="chat-error">{error}</div>}
          <div className="chat-box-input">
            <textarea ref={inputRef} rows={1} value={draft} placeholder="Aa" maxLength={4000}
              onChange={(e) => {
                setDraft(e.target.value);
                // Tell them we are typing -- at most every TYPING_EVERY_MS, and only with text in the box.
                if (e.target.value.trim() && Date.now() - lastTypingSent.current > TYPING_EVERY_MS) {
                  lastTypingSent.current = Date.now();
                  api.post('/chat/typing', { to: box.user.id }).catch(() => {});
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button type="button" className="chat-send" disabled={sending || !draft.trim()} onClick={send}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}
