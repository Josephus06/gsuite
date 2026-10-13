import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { parseUtc } from '../utils/datetime';
import ChatGroupModal from './ChatGroupModal';

// One group chat's box in the dock (2026-10-13). Like a one-to-one box, but every message from
// someone else carries their name, the header opens the group's details (members; the creator
// manages them there), and nothing here deletes a message -- group messages are kept.
const timeOf = (v) => (v ? parseUtc(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');
const dayOf = (v) => (v ? parseUtc(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }) : '');

export default function GroupChatBox({ box, meId, onClose, onToggle, onSent, onOlder, onGroupChanged }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const newestRef = useRef(null);

  const newest = box.messages[box.messages.length - 1]?.id;
  useEffect(() => {
    const el = listRef.current;
    if (el && newest !== newestRef.current) el.scrollTop = el.scrollHeight;
    newestRef.current = newest;
  }, [newest]);
  useEffect(() => {
    const el = listRef.current;
    if (el && !box.minimized) el.scrollTop = el.scrollHeight;
    if (!box.minimized) inputRef.current?.focus();
  }, [box.minimized]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true); setError('');
    try {
      const { data } = await api.post(`/chat/groups/${box.group.id}/send`, { body });
      onSent(data);
      setDraft('');
    } catch (e) { setError(e.response?.data?.error || 'Not sent.'); }
    setSending(false);
    inputRef.current?.focus();
  }

  let prevDay = '';
  let prevSender = null;
  return (
    <div className={`chat-box ${box.minimized ? 'is-min' : ''}`}>
      <div className="chat-box-head" onClick={onToggle} title={box.minimized ? 'Open' : 'Minimize'}>
        <span className="chat-group-icon" aria-hidden="true">{String(box.group.name || '?').slice(0, 1).toUpperCase()}</span>
        <span className="chat-box-name">
          {box.group.name}
          {!box.minimized && box.group.member_count ? <span className="chat-head-typing">{box.group.member_count} members</span> : null}
        </span>
        {box.minimized && box.unread > 0 && (
          <span className="chat-unread" title={`${box.unread} unread message${box.unread === 1 ? '' : 's'}`}>{box.unread > 99 ? '99+' : box.unread}</span>
        )}
        <button type="button" className="chat-box-btn" title="Group details" onClick={(e) => { e.stopPropagation(); setManaging(true); }}>⚙</button>
        <button type="button" className="chat-box-btn" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
      </div>
      {!box.minimized && (
        <>
          <div className="chat-box-list" ref={listRef}>
            {box.hasMore && <button type="button" className="chat-older" onClick={onOlder}>Earlier messages</button>}
            {box.loading && <div className="chat-empty">Loading…</div>}
            {!box.loading && !box.messages.length && <div className="chat-empty">Say hi to the group.</div>}
            {box.messages.map((m) => {
              const d = dayOf(m.created_at);
              const showDay = d !== prevDay;
              prevDay = d;
              const mine = m.sender_user_id === meId;
              // The sender's name over the first of their messages in a run, as group chats show it.
              const showName = !mine && (showDay || prevSender !== m.sender_user_id);
              prevSender = m.sender_user_id;
              return (
                <div key={m.id}>
                  {showDay && <div className="chat-day">{d}</div>}
                  <div className={`chat-msg ${mine ? 'mine' : ''}`} title={timeOf(m.created_at)}>
                    {showName && <div className="chat-sender">{m.sender_name}</div>}
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
      {managing && (
        <ChatGroupModal
          groupId={box.group.id}
          onClose={() => setManaging(false)}
          onDone={(r) => { setManaging(false); onGroupChanged(r); }}
        />
      )}
    </div>
  );
}
