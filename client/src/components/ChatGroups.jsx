import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import ChatGroupModal from './ChatGroupModal';
import { openGroupChat } from './ChatDock';

// The group chats I am in, with unread counts, and "+ New group" for those allowed to create one
// (Can Add on Chat; 2026-10-13). Shown with the people list on the Dashboard and the Feed.
const REFRESH_MS = 20000;

export default function ChatGroups({ compact = false }) {
  const { can } = useAuth();
  const enabled = can('/chat', 'can_view');
  const [groups, setGroups] = useState([]);
  const [canCreate, setCanCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api.get('/chat/groups').then(({ data }) => { setGroups(data.groups || []); setCanCreate(!!data.can_create); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const t = setInterval(load, REFRESH_MS);
    // A group box was read, or a group changed (created, renamed, left, deleted): refresh now.
    const onChange = () => load();
    window.addEventListener('chatgroup:changed', onChange);
    return () => { clearInterval(t); window.removeEventListener('chatgroup:changed', onChange); };
  }, [enabled, load]);

  if (!enabled || (!groups.length && !canCreate)) return null;

  return (
    <div className={compact ? 'chat-groups compact' : 'chat-groups'}>
      <div className="chat-contacts-head">
        <span>Group chats</span>
        {canCreate && <button type="button" className="link-btn" onClick={() => setCreating(true)}>+ New group</button>}
      </div>
      <div className="chat-contacts-list">
        {!groups.length && <div className="chat-empty">No groups yet.</div>}
        {groups.map((g) => (
          <button type="button" key={g.id} className="chat-contact" onClick={() => openGroupChat(g)} title={`Open ${g.name}`}>
            <span className="chat-group-icon" aria-hidden="true">{String(g.name || '?').slice(0, 1).toUpperCase()}</span>
            <span className="chat-contact-name">
              {g.name}
              <small>{g.member_count} members</small>
            </span>
            {g.unread > 0 && <span className="chat-unread">{g.unread > 99 ? '99+' : g.unread}</span>}
          </button>
        ))}
      </div>
      {creating && (
        <ChatGroupModal
          onClose={() => setCreating(false)}
          onDone={({ created }) => { setCreating(false); load(); if (created) openGroupChat({ id: created.id, name: created.name }); }}
        />
      )}
    </div>
  );
}
