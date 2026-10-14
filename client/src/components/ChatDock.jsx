import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { chime } from '../utils/notificationSound';
import Avatar from './Avatar';
import GroupChatBox from './GroupChatBox';
import ChatMessages, { replyTarget } from './chat/ChatMessages';
import ChatComposer from './chat/ChatComposer';

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

// A group box being opened (2026-10-13, AI summary): with unread waiting, it remembers where the
// reader had read up to (readMark) -- opening marks them read -- so "Summarize" can ask for exactly
// those. readMark then moves to the newest message, as does every message that arrives while open.
const SUMMARY_MIN_UNREAD = 3;
const newestId = (b) => b.messages[b.messages.length - 1]?.id || b.readMark || 0;
const openedGroup = (b) => ({
  ...b,
  minimized: false,
  unread: 0,
  summary: b.unread >= SUMMARY_MIN_UNREAD ? { after: b.readMark || 0, count: b.unread } : b.summary,
  readMark: newestId(b),
});

// A reaction or unsend (poll `updates`) replaces the message where it is shown; what the box
// already knew about the sender (name, photo) is kept.
const applyUpdates = (messages, list) => {
  if (!list.length) return messages;
  const byId = new Map(list.map((u) => [u.id, u]));
  let changed = false;
  const next = messages.map((m) => {
    const u = byId.get(m.id);
    if (!u) return m;
    changed = true;
    return { ...m, ...u, sender_name: u.sender_name || m.sender_name };
  });
  return changed ? next : messages;
};

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
  const revRef = useRef(null); // where "now" is in reactions / unsends (poll rev_now)
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
        setGroupBoxes((bs) => bs.map((b) => (b.group.id === g.id ? openedGroup(b) : b)));
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
      const lastRead = data.last_read_id || 0;
      const unread = data.messages.filter((m) => m.sender_user_id !== user.id && m.id > lastRead).length;
      setGroupBoxes((bs) => bs.map((b) => {
        if (b.group.id !== g.id) return b;
        const loaded = {
          ...b, group: { ...b.group, ...(data.group || {}) }, messages: data.messages, hasMore: data.has_more, loading: false,
          unread, readMark: lastRead,
        };
        return focus ? openedGroup(loaded) : loaded;
      }));
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
          revRef.current = data.rev_now || null;
          // Unread waiting from before this page loaded: open those boxes, minimized.
          for (const p of data.pending || []) open(p, { focus: false });
          for (const g of data.pending_groups || []) openGroup(g, { focus: false });
          return true;
        }
        // What is on screen, so the server holds the request until any of it changes.
        const openIds = boxesRef.current.map((b) => b.user.id);
        const { data } = await api.get('/chat/poll', {
          params: {
            after: lastIdRef.current, wait: 1, gafter: gLastIdRef.current ?? 0, rev: revRef.current || undefined,
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
        if (data.rev_now) revRef.current = data.rev_now;
        // Reactions and unsends, in the boxes that show those messages.
        const upd = data.updates || {};
        if ((upd.dm || []).length) {
          setBoxes((bs) => bs.map((b) => {
            const msgs = applyUpdates(b.messages, upd.dm.filter((u) => u.other_id === b.user.id));
            return msgs === b.messages ? b : { ...b, messages: msgs };
          }));
        }
        if ((upd.group || []).length) {
          setGroupBoxes((bs) => bs.map((b) => {
            const msgs = applyUpdates(b.messages, upd.group.filter((u) => u.group_id === b.group.id));
            return msgs === b.messages ? b : { ...b, messages: msgs };
          }));
        }
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
              ? { ...b, messages: [...b.messages, m], unread: (b.unread || 0) + (countIt ? 1 : 0), readMark: b.minimized ? b.readMark : m.id }
              : b)));
            if (!mine && !countIt) markGroupRead(m.group_id);
          } else if (!mine) {
            openGroup({ id: m.group_id, name: m.group_name }, { focus: false });
          }
          if (!mine) incoming = true;
        }
        if ((data.group_messages || []).length) window.dispatchEvent(new CustomEvent('chatgroup:changed'));
        // The top bar's Messenger list (MessengerMenu) refreshes on any direct message, sent or received.
        if ((data.messages || []).length) window.dispatchEvent(new CustomEvent('chat:activity'));
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
    if (!b.minimized) return { ...b, minimized: true };
    markGroupRead(id);
    return openedGroup(b);
  }));
  const appendGroup = (id, m) => setGroupBoxes((bs) => bs.map((b) => (b.group.id === id && !b.messages.some((x) => x.id === m.id)
    ? { ...b, messages: [...b.messages, m], readMark: m.id } : b)));
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
          onGroupChanged={(r) => groupChanged(b.group.id, r)}
          onSummaryDone={() => setGroupBoxes((bs) => bs.map((x) => (x.group.id === b.group.id ? { ...x, summary: null } : x)))} />
      ))}
    </div>
  );
}

function ChatBox({ box, meId, onClose, onToggle, onSent, onOlder, isTyping, seenId }) {
  // The photo opens their profile and timeline (2026-10-14); the rest of the header still opens /
  // minimizes the box.
  const navigate = useNavigate();
  const viewProfile = (e) => { e.stopPropagation(); navigate(`/profile/${box.user.id}`); };
  const lastTypingSent = useRef(0);
  const [replyTo, setReplyTo] = useState(null);
  const [error, setError] = useState('');
  const listRef = useRef(null);
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

  async function send({ body, attachments, reply_to_id }) {
    const { data } = await api.post('/chat/send', { to: box.user.id, body, attachments, reply_to_id });
    onSent(data);
    setReplyTo(null);
    lastTypingSent.current = 0; // the server cleared "typing" on send; the next key may say it again
  }
  function typing() {
    // Tell them we are typing -- at most every TYPING_EVERY_MS.
    if (Date.now() - lastTypingSent.current > TYPING_EVERY_MS) {
      lastTypingSent.current = Date.now();
      api.post('/chat/typing', { to: box.user.id }).catch(() => {});
    }
  }
  // Reactions and unsends come back to every screen over the poll (updates).
  const act = (path, payload) => api.post(path, payload).catch((e) => setError(e.response?.data?.error || 'Could not do that.'));

  // "Seen" goes under the newest of my messages they have read, as Messenger shows it.
  const seenAt = box.messages.reduce((n, m) => (m.sender_user_id === meId && m.id <= seenId && m.id > n ? m.id : n), 0);
  return (
    <div className={`chat-box ${box.minimized ? 'is-min' : ''}`}>
      <div className="chat-box-head" onClick={onToggle} title={box.minimized ? 'Open' : 'Minimize'}>
        <span className="chat-box-avatar" onClick={viewProfile} title={`View ${box.user.display_name}'s profile`} style={{ cursor: 'pointer' }}>
          <Avatar user={box.user} size={32} />
          {box.user.online && <span className="chat-online-dot" />}
        </span>
        <span className="chat-box-name">
          {box.user.display_name}
          {/* Minimized, the typing bubble inside the box cannot be seen -- say it on the header. */}
          {box.minimized && isTyping
            ? <span className="chat-head-typing">typing…</span>
            : <span className="chat-head-sub">{box.user.online ? 'Active now' : ''}</span>}
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
            {!box.loading && !box.messages.length && (
              <div className="chat-intro">
                <span onClick={viewProfile} title={`View ${box.user.display_name}'s profile`} style={{ cursor: 'pointer' }}>
                  <Avatar user={box.user} size={56} />
                </span>
                <strong>{box.user.display_name}</strong>
                <span>Say hi 👋</span>
              </div>
            )}
            <ChatMessages messages={box.messages} meId={meId} otherUser={box.user} seenAt={seenAt}
              onReply={(m) => setReplyTo(replyTarget(m, meId, box.user.display_name))}
              onReact={(m, emoji) => act('/chat/react', { kind: 'dm', message_id: m.id, emoji })}
              onUnsend={(m) => act('/chat/unsend', { kind: 'dm', message_id: m.id })} />
            {isTyping && (
              <div className="cm-row pos-single">
                <div className="cm-avatar"><Avatar user={box.user} size={28} /></div>
                <div className="cm-col">
                  <div className="cm-bubble chat-typing" title={`${box.user.display_name} is typing`}><span /><span /><span /></div>
                </div>
              </div>
            )}
          </div>
          {error && <div className="chat-error" onClick={() => setError('')}>{error}</div>}
          <ChatComposer onSend={send} onTyping={typing} focusKey={box.minimized}
            replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
        </>
      )}
    </div>
  );
}
