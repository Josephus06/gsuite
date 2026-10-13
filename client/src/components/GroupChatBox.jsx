import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import ChatGroupModal from './ChatGroupModal';
import ChatMessages, { replyTarget } from './chat/ChatMessages';
import ChatComposer from './chat/ChatComposer';

// One group chat's box in the dock (2026-10-13). Like a one-to-one box, but every message from
// someone else carries their name, the header opens the group's details (members; the creator
// manages them there), and group messages are kept (only their sender may unsend one).
// AI summary of the unread messages a group was opened with (2026-10-13; POST /chat/groups/:id/summary).
// Offered, not run on its own -- each summary is a paid AI call.
function UnreadSummary({ groupId, summary, onClose }) {
  const [state, setState] = useState({ loading: false, text: '', error: '' });
  async function run() {
    setState({ loading: true, text: '', error: '' });
    try {
      const { data } = await api.post(`/chat/groups/${groupId}/summary`, { after: summary.after }, { timeout: 60000 });
      setState({ loading: false, text: data.summary || 'Nothing new from the others to summarize.', error: '' });
    } catch (e) {
      setState({ loading: false, text: '', error: e.response?.data?.error || 'Could not summarize.' });
    }
  }
  return (
    <div className="chat-summary">
      {!state.text && (
        <div className="chat-summary-bar">
          <span>✨ {summary.count} unread message{summary.count === 1 ? '' : 's'}</span>
          <button type="button" className="chat-summary-go" disabled={state.loading} onClick={run}>
            {state.loading ? 'Summarizing…' : 'Summarize'}
          </button>
          <button type="button" className="chat-summary-x" title="Dismiss" onClick={onClose}>×</button>
        </div>
      )}
      {state.error && <div className="chat-error">{state.error}</div>}
      {state.text && (
        <div className="chat-summary-body">
          <div className="chat-summary-head">
            <strong>✨ Summary of {summary.count} unread</strong>
            <button type="button" className="chat-summary-x" title="Close" onClick={onClose}>×</button>
          </div>
          <div className="chat-summary-text">{state.text}</div>
          <div className="chat-summary-note">AI-generated -- check the messages for details.</div>
        </div>
      )}
    </div>
  );
}

export default function GroupChatBox({ box, meId, onClose, onToggle, onSent, onOlder, onGroupChanged, onSummaryDone }) {
  const [managing, setManaging] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [error, setError] = useState('');
  const listRef = useRef(null);
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
  }, [box.minimized]);

  async function send({ body, attachments, reply_to_id }) {
    const { data } = await api.post(`/chat/groups/${box.group.id}/send`, { body, attachments, reply_to_id });
    onSent(data);
    setReplyTo(null);
  }
  const act = (path, payload) => api.post(path, payload).catch((e) => setError(e.response?.data?.error || 'Could not do that.'));

  return (
    <div className={`chat-box ${box.minimized ? 'is-min' : ''}`}>
      <div className="chat-box-head" onClick={onToggle} title={box.minimized ? 'Open' : 'Minimize'}>
        <span className="chat-group-icon" aria-hidden="true">{String(box.group.name || '?').slice(0, 1).toUpperCase()}</span>
        <span className="chat-box-name">
          {box.group.name}
          {!box.minimized && box.group.member_count ? <span className="chat-head-sub">{box.group.member_count} members</span> : null}
        </span>
        {box.minimized && box.unread > 0 && (
          <span className="chat-unread" title={`${box.unread} unread message${box.unread === 1 ? '' : 's'}`}>{box.unread > 99 ? '99+' : box.unread}</span>
        )}
        <button type="button" className="chat-box-btn" title="Group details" onClick={(e) => { e.stopPropagation(); setManaging(true); }}>⚙</button>
        <button type="button" className="chat-box-btn" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
      </div>
      {!box.minimized && (
        <>
          {box.summary && <UnreadSummary groupId={box.group.id} summary={box.summary} onClose={onSummaryDone} />}
          <div className="chat-box-list" ref={listRef}>
            {box.hasMore && <button type="button" className="chat-older" onClick={onOlder}>Earlier messages</button>}
            {box.loading && <div className="chat-empty">Loading…</div>}
            {!box.loading && !box.messages.length && (
              <div className="chat-intro">
                <span className="chat-group-icon big">{String(box.group.name || '?').slice(0, 1).toUpperCase()}</span>
                <strong>{box.group.name}</strong>
                <span>Say hi to the group 👋</span>
              </div>
            )}
            <ChatMessages messages={box.messages} meId={meId} showNames
              onReply={(m) => setReplyTo(replyTarget(m, meId, m.sender_name))}
              onReact={(m, emoji) => act('/chat/react', { kind: 'group', message_id: m.id, emoji })}
              onUnsend={(m) => act('/chat/unsend', { kind: 'group', message_id: m.id })} />
          </div>
          {error && <div className="chat-error" onClick={() => setError('')}>{error}</div>}
          <ChatComposer onSend={send} focusKey={box.minimized}
            replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
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
