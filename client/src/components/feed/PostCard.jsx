import { useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import Avatar from '../Avatar';
import ReactionButton from './ReactionButton';
import CommentThread from './CommentThread';
import { REACTION_BY_KEY, reactionSummary, topReactionKeys } from './reactions';
import { audienceMeta } from './audience';
import { fbTime, fbTimeFull } from './time';

// "See more" clamp for long posts, matching FB's ~280-character fold.
const FOLD_AT = 280;

export default function PostCard({ post, user, viewer, onChanged, onDeleted, onEdit }) {
  const [state, setState] = useState(post);
  const [showComments, setShowComments] = useState(false);
  const [focusComment, setFocusComment] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => setState(post), [post]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onDown(e) { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  async function react(type) {
    // Optimistic: the bar should snap shut and recolor instantly, then reconcile with the
    // server's authoritative tallies.
    const prev = state;
    setState((s) => ({ ...s, my_reaction: type }));
    try {
      const { data } = await api.put(`/feed/${state.id}/reaction`, { type });
      setState((s) => ({ ...s, ...data }));
    } catch {
      setState(prev);
    }
  }

  async function remove() {
    setMenuOpen(false);
    if (!window.confirm('Delete this post? This cannot be undone from the feed.')) return;
    await api.delete(`/feed/${state.id}`);
    onDeleted(state.id);
  }

  const aud = audienceMeta(state.audience, state.author.group_name || viewer?.group_name);
  const top = topReactionKeys(state.reactions);
  const summary = reactionSummary(state.reaction_total, state.top_reactors, state.my_reaction);
  const canManage = state.can_edit || viewer?.is_admin;

  const long = state.body.length > FOLD_AT;
  const shownBody = long && !expanded ? `${state.body.slice(0, FOLD_AT).trimEnd()}…` : state.body;
  const bigText = !state.image_data && state.body.length <= 130;

  return (
    <div className="fb-card" style={{ position: 'relative' }}>
      <div className="fb-post-head">
        <Avatar user={state.author} size={40} />
        <div className="fb-post-headmeta">
          <div className="fb-post-author">{state.author.display_name}</div>
          <div className="fb-post-sub">
            <span title={fbTimeFull(state.created_at)}>{fbTime(state.created_at)}</span>
            {state.edited_at && <><span className="dot">·</span><span>Edited</span></>}
            <span className="dot">·</span>
            <span title={aud.sub}>{aud.icon}</span>
          </div>
        </div>
        {canManage && (
          <div ref={menuRef}>
            <button type="button" className="fb-icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Post options">⋯</button>
            {menuOpen && (
              <div className="fb-menu">
                {state.can_edit && (
                  <button type="button" className="fb-menu-item" onClick={() => { setMenuOpen(false); onEdit(state); }}>
                    ✏️ Edit post
                  </button>
                )}
                <button type="button" className="fb-menu-item danger" onClick={remove}>🗑️ Delete post</button>
              </div>
            )}
          </div>
        )}
      </div>

      {state.body && (
        <div className={`fb-post-body${bigText ? ' big' : ''}`}>
          {shownBody}
          {long && !expanded && (
            <button
              type="button"
              className="fb-stat-btn"
              style={{ marginLeft: 6, fontWeight: 600 }}
              onClick={() => setExpanded(true)}
            >
              See more
            </button>
          )}
        </div>
      )}

      {state.image_data && (
        <img className="fb-post-image" src={state.image_data} alt="" onClick={() => setLightbox(true)} />
      )}

      {(state.reaction_total > 0 || state.comment_count > 0) && (
        <div className="fb-post-stats">
          {state.reaction_total > 0 && (
            <>
              <div className="fb-bubbles">
                {top.map((k) => (
                  <span className="fb-bubble" key={k} title={REACTION_BY_KEY[k].label}>{REACTION_BY_KEY[k].emoji}</span>
                ))}
              </div>
              <span style={{ marginLeft: 8 }}>{summary}</span>
            </>
          )}
          <div className="fb-stat-right">
            {state.comment_count > 0 && (
              <button
                type="button"
                className="fb-stat-btn"
                onClick={() => { setShowComments(true); setFocusComment(false); }}
              >
                {state.comment_count} comment{state.comment_count === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="fb-post-actions">
        <ReactionButton myReaction={state.my_reaction} onReact={react} />
        <button
          type="button"
          className="fb-action"
          onClick={() => { setShowComments(true); setFocusComment(true); }}
        >
          <span className="emoji">💬</span>Comment
        </button>
        <button
          type="button"
          className="fb-action"
          onClick={() => {
            const url = `${window.location.origin}/dashboard#post-${state.id}`;
            navigator.clipboard?.writeText(url);
            onChanged?.('Link copied to clipboard.');
          }}
        >
          <span className="emoji">↪</span>Share
        </button>
      </div>

      {showComments && (
        <CommentThread
          postId={state.id}
          initialComments={state.comments}
          total={state.comment_count}
          user={user}
          autoFocus={focusComment}
          onCountChange={(n) => setState((s) => ({ ...s, comment_count: n }))}
        />
      )}

      {lightbox && (
        <div className="fb-modal-backdrop" onClick={() => setLightbox(false)}>
          <img
            src={state.image_data}
            alt=""
            style={{ maxWidth: '95vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 8 }}
          />
        </div>
      )}
    </div>
  );
}
