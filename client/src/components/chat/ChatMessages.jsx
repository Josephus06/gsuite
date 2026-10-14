import { useEffect, useState } from 'react';
import api from '../../api/client';
import { parseUtc } from '../../utils/datetime';
import { downloadFile } from '../../utils/downloadFile';
import Avatar from '../Avatar';

// The messages of one chat box, Messenger-style (2026-10-13): consecutive messages from one person
// grouped with rounded corners, their photo beside the last of a run, photos shown in the thread,
// files as chips, the message being replied to quoted above, reactions under the bubble, and on
// hover: react, reply, and -- your own -- unsend. Shared by one-to-one and group boxes.
export const REACTIONS = ['👍', '❤️', '😆', '😮', '😢', '😡'];
// What a reply bar shows of the message being answered.
export function replyTarget(m, meId, otherName) {
  const n = (m.attachments || []).length;
  return {
    id: m.id,
    who: m.sender_user_id === meId ? 'yourself' : (m.sender_name || otherName),
    preview: m.body || (n ? `📎 ${n} attachment${n === 1 ? '' : 's'}` : ''),
  };
}

const GROUP_GAP_MS = 2 * 60 * 1000; // messages closer than this from one sender read as one run

const timeOf = (v) => (v ? parseUtc(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');
const dayOf = (v) => (v ? parseUtc(v).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }) : '');
const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Photos need the login token, which an <img src> cannot carry: fetched once as a blob and kept.
const blobCache = new Map();
function ChatImage({ id, name, onOpen }) {
  const [url, setUrl] = useState(blobCache.get(id) || null);
  useEffect(() => {
    if (blobCache.has(id)) { setUrl(blobCache.get(id)); return undefined; }
    let alive = true;
    api.get(`/chat/attachments/${id}`, { responseType: 'blob' })
      .then(({ data }) => { const u = URL.createObjectURL(data); blobCache.set(id, u); if (alive) setUrl(u); })
      .catch(() => {});
    return () => { alive = false; };
  }, [id]);
  if (!url) return <div className="cm-img cm-img-loading" />;
  return <img className="cm-img" src={url} alt={name} onClick={() => onOpen(url, name)} />;
}

// Seen by (2026-10-14): each reader's profile picture sits under the newest message they have read
// -- readers: [{ id, display_name, avatar_data, last_read_id }] for a group; for a one-to-one chat the
// other person's picture under seenAt. Nobody is shown under their own message.
function seenPositions(messages, readers) {
  const at = new Map(); // message id -> readers whose newest-read message it is
  for (const r of readers || []) {
    let hit = null;
    for (const m of messages) if (m.id <= r.last_read_id) hit = m; else break;
    if (!hit || hit.sender_user_id === r.id) continue;
    if (!at.has(hit.id)) at.set(hit.id, []);
    at.get(hit.id).push(r);
  }
  return at;
}

export default function ChatMessages({ messages, meId, otherUser, showNames, seenAt, readers, onReply, onReact, onUnsend }) {
  const [menuFor, setMenuFor] = useState(null); // the message whose reaction picker is open
  const [viewer, setViewer] = useState(null); // { url, name } -- a photo opened full size
  const seenBy = seenPositions(messages, readers);

  let prevDay = '';
  return (
    <>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const next = messages[i + 1];
        const d = dayOf(m.created_at);
        const showDay = d !== prevDay;
        prevDay = d;
        const mine = m.sender_user_id === meId;
        const t = parseUtc(m.created_at).getTime();
        const joinsPrev = prev && !showDay && prev.sender_user_id === m.sender_user_id && t - parseUtc(prev.created_at).getTime() < GROUP_GAP_MS;
        const joinsNext = next && dayOf(next.created_at) === d && next.sender_user_id === m.sender_user_id
          && parseUtc(next.created_at).getTime() - t < GROUP_GAP_MS;
        const pos = joinsPrev && joinsNext ? 'mid' : joinsPrev ? 'last' : joinsNext ? 'first' : 'single';
        const images = (m.attachments || []).filter((a) => a.is_image);
        const files = (m.attachments || []).filter((a) => !a.is_image);
        const onlyEmoji = m.body && !images.length && !files.length && /^(\p{Extended_Pictographic}|️|‍|\s){1,6}$/u.test(m.body);
        const sender = { id: m.sender_user_id, display_name: m.sender_name || otherUser?.display_name, avatar_data: m.sender_avatar || otherUser?.avatar_data };
        return (
          <div key={m.id}>
            {showDay && <div className="chat-day">{d}</div>}
            <div className={`cm-row ${mine ? 'mine' : ''} pos-${pos}`} onMouseLeave={() => setMenuFor((x) => (x === m.id ? null : x))}>
              {!mine && (
                <div className="cm-avatar">{(pos === 'last' || pos === 'single') && <Avatar user={sender} size={28} />}</div>
              )}
              <div className="cm-col">
                {showNames && !mine && (pos === 'first' || pos === 'single') && <div className="chat-sender">{m.sender_name}</div>}
                {m.reply && (
                  <div className="cm-reply-quote">
                    <span className="cm-reply-who">↩ {m.reply.sender_user_id === meId ? 'You' : m.reply.sender_name} </span>
                    {m.reply.unsent ? <em>unsent message</em> : (m.reply.body || (m.reply.att_count ? '📎 Attachment' : ''))}
                  </div>
                )}
                <div className="cm-line">
                  {m.unsent ? (
                    <div className="cm-bubble cm-unsent">{mine ? 'You unsent a message' : 'Message unsent'}</div>
                  ) : (
                    <div className="cm-content" title={timeOf(m.created_at)}>
                      {images.length > 0 && (
                        <div className={`cm-images n${Math.min(images.length, 3)}`}>
                          {images.map((a) => <ChatImage key={a.id} id={a.id} name={a.file_name} onOpen={(url, name) => setViewer({ url, name, id: a.id })} />)}
                        </div>
                      )}
                      {files.map((a) => (
                        <button type="button" key={a.id} className="cm-file"
                          onClick={() => downloadFile(`/chat/attachments/${a.id}`, { download: 1 }, a.file_name)}>
                          <span className="cm-file-icon">📄</span>
                          <span className="cm-file-name">{a.file_name}<small>{sizeOf(a.size_bytes)}</small></span>
                        </button>
                      ))}
                      {m.body && <div className={onlyEmoji ? 'cm-emoji-only' : 'cm-bubble'}>{m.body}</div>}
                    </div>
                  )}
                  {!m.unsent && (
                    <div className="cm-actions">
                      <button type="button" title="React" onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}>😊</button>
                      <button type="button" title="Reply" onClick={() => onReply(m)}>↩</button>
                      {mine && <button type="button" title="Unsend" onClick={() => { if (window.confirm('Unsend this message for everyone?')) onUnsend(m); }}>🗑</button>}
                    </div>
                  )}
                  {menuFor === m.id && (
                    <div className="cm-react-menu">
                      {REACTIONS.map((e) => (
                        <button type="button" key={e} className={(m.reactions || []).some((r) => r.emoji === e && r.mine) ? 'on' : ''}
                          onClick={() => { onReact(m, e); setMenuFor(null); }}>{e}</button>
                      ))}
                    </div>
                  )}
                </div>
                {(m.reactions || []).length > 0 && (
                  <div className="cm-reactions" title={m.reactions.map((r) => `${r.emoji} ${r.names.join(', ')}`).join('\n')}>
                    {m.reactions.map((r) => (
                      <button type="button" key={r.emoji} className={r.mine ? 'mine' : ''} onClick={() => onReact(m, r.emoji)}>
                        {r.emoji}{r.count > 1 ? ` ${r.count}` : ''}
                      </button>
                    ))}
                  </div>
                )}
                {(pos === 'last' || pos === 'single') && <div className="chat-time">{timeOf(m.created_at)}</div>}
                {mine && seenAt === m.id && otherUser && (
                  <div className="chat-seen-by" title={`Seen by ${otherUser.display_name}`}><Avatar user={otherUser} size={14} /></div>
                )}
                {seenBy.has(m.id) && (
                  <div className="chat-seen-by" title={`Seen by ${seenBy.get(m.id).map((r) => r.display_name).join(', ')}`}>
                    {seenBy.get(m.id).map((r) => <Avatar key={r.id} user={r} size={14} />)}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {viewer && (
        <div className="cm-viewer" onClick={() => setViewer(null)}>
          <img src={viewer.url} alt={viewer.name} onClick={(e) => e.stopPropagation()} />
          <div className="cm-viewer-bar" onClick={(e) => e.stopPropagation()}>
            <span>{viewer.name}</span>
            <button type="button" onClick={() => downloadFile(`/chat/attachments/${viewer.id}`, { download: 1 }, viewer.name)}>Download</button>
            <button type="button" onClick={() => setViewer(null)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
