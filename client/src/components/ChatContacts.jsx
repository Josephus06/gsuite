import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Avatar from './Avatar';
import { openChat } from './ChatDock';
import { hiddenPollGate, onTabVisible } from '../utils/backgroundPoll';

// The Dashboard's people list (2026-10-12): everyone you can chat with -- photo, online dot, unread
// count. Clicking one pops out their chatbox (ChatDock). Only for users with the Chat permission.
const REFRESH_MS = 20000;

export default function ChatContacts() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const enabled = can('/chat', 'can_view');
  const [contacts, setContacts] = useState([]);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    api.get('/chat/contacts').then(({ data }) => setContacts(Array.isArray(data) ? data : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    // Slow while the tab is hidden; refreshed as soon as it is shown (utils/backgroundPoll.js).
    const gate = hiddenPollGate();
    const t = setInterval(() => { if (gate()) load(); }, REFRESH_MS);
    const offVisible = onTabVisible(load);
    // A box marked a conversation read: drop its badge now rather than at the next refresh.
    const onRead = (e) => setContacts((cs) => cs.map((c) => (c.id === e.detail ? { ...c, unread: 0 } : c)));
    window.addEventListener('chat:read', onRead);
    return () => { clearInterval(t); offVisible(); window.removeEventListener('chat:read', onRead); };
  }, [enabled, load]);

  if (!enabled) return null;
  const q = filter.trim().toLowerCase();
  const shown = q ? contacts.filter((c) => String(c.display_name || '').toLowerCase().includes(q)) : contacts;
  const online = contacts.filter((c) => c.online).length;

  return (
    <div className="chat-contacts">
      <div className="chat-contacts-head">
        <span>Messenger</span>
        <span className="chat-contacts-count">{online} online</span>
      </div>
      {contacts.length > 6 && (
        <input className="chat-contacts-search" value={filter} placeholder="Search people" onChange={(e) => setFilter(e.target.value)} />
      )}
      <div className="chat-contacts-list">
        {!contacts.length && <div className="chat-empty">No one else has Chat yet.</div>}
        {shown.map((c) => (
          <button type="button" key={c.id} className="chat-contact" onClick={() => openChat(c)} title={`Chat with ${c.display_name}`}>
            {/* The photo opens their profile and timeline (2026-10-14); the name opens the chat. */}
            <span className="chat-box-avatar" title={`View ${c.display_name}'s profile`}
              onClick={(e) => { e.stopPropagation(); navigate(`/profile/${c.id}`); }}>
              <Avatar user={c} size={34} />
              {c.online && <span className="chat-online-dot" />}
            </span>
            <span className="chat-contact-name">
              {c.display_name}
              {c.group_name && <small>{c.group_name}</small>}
            </span>
            {c.unread > 0 && <span className="chat-unread">{c.unread}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
