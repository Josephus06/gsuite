import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import Avatar from '../Avatar';
import ReactionButton from './ReactionButton';
import { REACTION_BY_KEY, topReactionKeys } from './reactions';
import { fbTime, fbTimeFull } from './time';

// Auto-growing single-line-until-it-isn't comment box. Enter submits, Shift+Enter newlines.
function CommentBox({ user, placeholder, autoFocus, onSubmit, onCancel }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setText('');
      if (ref.current) ref.current.style.height = 'auto';
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fb-comment-input-row">
      <Avatar user={user} size={32} />
      <div className="fb-comment-input-wrap">
        <textarea
          ref={ref}
          rows={1}
          className="fb-comment-input"
          placeholder={placeholder}
          value={text}
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            if (e.key === 'Escape' && onCancel) onCancel();
          }}
        />
        <button type="button" className="fb-comment-send" disabled={!text.trim() || busy} onClick={send} aria-label="Send">
          ➤
        </button>
      </div>
    </div>
  );
}

function CommentItem({ comment, user, depth, onReply, onDelete, onReact }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [replying, setReplying] = useState(false);
  const top = topReactionKeys(comment.reactions, 2);

  async function saveEdit() {
    const body = draft.trim();
    if (!body || body === comment.body) { setEditing(false); return; }
    await api.put(`/feed/comments/${comment.id}`, { body });
    comment.body = body;
    comment.edited_at = new Date().toISOString();
    setEditing(false);
  }

  return (
    <div>
      <div className="fb-comment-row">
        <span className="fb-link" onClick={() => navigate(`/profile/${comment.author.id}`)}>
          <Avatar user={comment.author} size={32} />
        </span>
        <div className="fb-comment-main">
          {editing ? (
            <div className="fb-comment-input-wrap">
              <textarea
                className="fb-comment-input"
                rows={1}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                  if (e.key === 'Escape') { setDraft(comment.body); setEditing(false); }
                }}
              />
              <button type="button" className="fb-comment-send" onClick={saveEdit} aria-label="Save">➤</button>
            </div>
          ) : (
            <div className="fb-comment-bubble-wrap">
              <div className="fb-comment-bubble">
                <span className="fb-comment-author" onClick={() => navigate(`/profile/${comment.author.id}`)}>
                  {comment.author.display_name}
                </span>
                <div className="fb-comment-text">{comment.body}</div>
              </div>
              {comment.reaction_total > 0 && (
                <div className="fb-comment-reacts">
                  {top.map((k) => <span className="emoji" key={k}>{REACTION_BY_KEY[k].emoji}</span>)}
                  <span>{comment.reaction_total}</span>
                </div>
              )}
            </div>
          )}

          <div className="fb-comment-meta">
            <ReactionButton compact myReaction={comment.my_reaction} onReact={(t) => onReact(comment, t)} />
            {depth === 0 && <button type="button" onClick={() => setReplying((v) => !v)}>Reply</button>}
            {comment.can_edit && !editing && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
            {comment.can_delete && <button type="button" onClick={() => onDelete(comment)}>Delete</button>}
            <span className="time" title={fbTimeFull(comment.created_at)}>{fbTime(comment.created_at)}</span>
            {comment.edited_at && <span className="time">Edited</span>}
          </div>

          {replying && (
            <CommentBox
              user={user}
              autoFocus
              placeholder={`Reply to ${comment.author.display_name}…`}
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                await onReply(comment, body);
                setReplying(false);
              }}
            />
          )}
        </div>
      </div>

      {comment.replies?.length > 0 && (
        <div className="fb-replies">
          {comment.replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              user={user}
              depth={depth + 1}
              onReply={onReply}
              onDelete={onDelete}
              onReact={onReact}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Owns the comment list for one post: seeded with the preview the feed shipped, then swapped
// for the full thread the first time the viewer asks for it.
export default function CommentThread({ postId, initialComments, total, user, autoFocus, onCountChange }) {
  const [comments, setComments] = useState(initialComments || []);
  const [loadedAll, setLoadedAll] = useState((initialComments || []).length >= total);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(total);

  useEffect(() => { setCount(total); }, [total]);

  async function loadAll() {
    setLoading(true);
    try {
      const { data } = await api.get(`/feed/${postId}/comments`);
      setComments(data.comments);
      setLoadedAll(true);
    } finally {
      setLoading(false);
    }
  }

  function bumpCount(n) {
    setCount(n);
    onCountChange?.(n);
  }

  async function addComment(body, parent) {
    const { data } = await api.post(`/feed/${postId}/comments`, {
      body,
      parent_comment_id: parent?.id || null,
    });
    setComments((prev) => {
      if (!parent) return [...prev, data.comment];
      return prev.map((c) => (
        c.id === parent.id || c.id === data.comment.parent_comment_id
          ? { ...c, replies: [...(c.replies || []), data.comment] }
          : c
      ));
    });
    bumpCount(data.comment_count);
  }

  async function deleteComment(comment) {
    const { data } = await api.delete(`/feed/comments/${comment.id}`);
    setComments((prev) => prev
      .filter((c) => c.id !== comment.id)
      .map((c) => ({ ...c, replies: (c.replies || []).filter((r) => r.id !== comment.id) })));
    bumpCount(data.comment_count);
  }

  async function reactComment(comment, type) {
    const { data } = await api.put(`/feed/comments/${comment.id}/reaction`, { type });
    const apply = (c) => (c.id === comment.id
      ? { ...c, reactions: data.reactions, reaction_total: data.reaction_total, my_reaction: data.my_reaction }
      : c);
    setComments((prev) => prev.map((c) => ({ ...apply(c), replies: (c.replies || []).map(apply) })));
  }

  const hidden = count - comments.reduce((n, c) => n + 1 + (c.replies?.length || 0), 0);

  return (
    <div className="fb-comments">
      <div className="fb-comments-top">
        {!loadedAll && hidden > 0 && (
          <button type="button" className="fb-comment-sort" onClick={loadAll} disabled={loading}>
            {loading ? 'Loading…' : `View ${hidden} previous comment${hidden === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {comments.map((c) => (
        <CommentItem
          key={c.id}
          comment={c}
          user={user}
          depth={0}
          onReply={(parent, body) => addComment(body, parent)}
          onDelete={deleteComment}
          onReact={reactComment}
        />
      ))}

      <CommentBox
        user={user}
        autoFocus={autoFocus}
        placeholder="Write a comment…"
        onSubmit={(body) => addComment(body, null)}
      />
    </div>
  );
}
