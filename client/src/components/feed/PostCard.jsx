import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import Avatar from '../Avatar';
import ReactionButton from './ReactionButton';
import CommentThread from './CommentThread';
import Linkify from './Linkify';
import {
  REACTION_BY_KEY, reactionSummary, topReactionKeys, reactorTooltip, allReactorNames,
} from './reactions';
import useFeedImages from './useFeedImages';
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
  // Index of the photo being viewed full-screen, or null for none. An index rather than a
  // boolean because a post can now hold several and the viewer pages between them.
  const [lightbox, setLightbox] = useState(null);
  const menuRef = useRef(null);
  const navigate = useNavigate();

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

  // Photos arrive as ids and are fetched separately -- see useFeedImages. state.images /
  // state.image_data are the older inline shapes, still honoured so a post already in memory
  // from a previous bundle keeps rendering.
  const fetched = useFeedImages(state.image_ids);
  const inline = state.images?.length ? state.images : (state.image_data ? [state.image_data] : []);
  // Only drop the nulls once loading has finished, or a post briefly renders as text-only and
  // then reflows when its photo lands.
  const images = state.image_ids?.length ? fetched.filter(Boolean) : inline;
  const imagesPending = Boolean(state.image_ids?.length) && images.length < state.image_ids.length;

  const long = state.body.length > FOLD_AT;
  const shownBody = long && !expanded ? `${state.body.slice(0, FOLD_AT).trimEnd()}…` : state.body;
  const bigText = !images.length && state.body.length <= 130;

  return (
    <div className="fb-card" style={{ position: 'relative' }}>
      <div className="fb-post-head">
        <span className="fb-link" onClick={() => navigate(`/profile/${state.author.id}`)}>
          <Avatar user={state.author} size={40} />
        </span>
        <div className="fb-post-headmeta">
          <div className="fb-post-author" onClick={() => navigate(`/profile/${state.author.id}`)}>
            {state.author.display_name}
          </div>
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
          <Linkify text={shownBody} />
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

      {/* One photo keeps its full-width treatment; several tile into a grid whose shape
          depends on how many there are, and anything past the fourth tile collapses into a
          "+N" overlay on the last one rather than shrinking every tile to a thumbnail. */}
      {/* Holds the space while the photo is still on its way, so the post does not jump as
          images land under the reader's cursor. */}
      {imagesPending && !images.length && <div className="fb-post-image-placeholder" />}
      {images.length === 1 && (
        <img className="fb-post-image" src={images[0]} alt="" loading="lazy" onClick={() => setLightbox(0)} />
      )}
      {images.length > 1 && (
        <div className={`fb-post-gallery n${Math.min(images.length, 4)}`}>
          {images.slice(0, 4).map((img, i) => {
            const hidden = i === 3 ? images.length - 4 : 0;
            return (
              <button type="button" className="fb-gallery-cell" key={i} onClick={() => setLightbox(i)}>
                <img src={img} alt="" />
                {hidden > 0 && <span className="fb-gallery-more">+{hidden}</span>}
              </button>
            );
          })}
        </div>
      )}

      {(state.reaction_total > 0 || state.comment_count > 0) && (
        <div className="fb-post-stats">
          {state.reaction_total > 0 && (
            <>
              <div className="fb-bubbles">
                {/* Hovering one emoji lists who chose THAT reaction; hovering the names
                    beside it lists everyone who reacted at all. */}
                {top.map((k) => (
                  <span
                    className="fb-bubble"
                    key={k}
                    title={reactorTooltip(state.reactors_by_type?.[k], state.reactions?.[k], REACTION_BY_KEY[k].label)}
                  >
                    {REACTION_BY_KEY[k].emoji}
                  </span>
                ))}
              </div>
              <span
                style={{ marginLeft: 8, cursor: 'default' }}
                title={reactorTooltip(allReactorNames(state.reactors_by_type, state.top_reactors), state.reaction_total)}
              >
                {summary}
              </span>
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

      {lightbox !== null && images[lightbox] && (
        <div className="fb-modal-backdrop" onClick={() => setLightbox(null)}>
          <img
            src={images[lightbox]}
            alt=""
            style={{ maxWidth: '95vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 8 }}
          />
          {images.length > 1 && (
            <>
              {/* stopPropagation, or paging would close the viewer on the backdrop click. */}
              <button
                type="button"
                className="fb-lightbox-nav prev"
                aria-label="Previous photo"
                onClick={(e) => { e.stopPropagation(); setLightbox((i) => (i - 1 + images.length) % images.length); }}
              >‹</button>
              <button
                type="button"
                className="fb-lightbox-nav next"
                aria-label="Next photo"
                onClick={(e) => { e.stopPropagation(); setLightbox((i) => (i + 1) % images.length); }}
              >›</button>
              <span className="fb-lightbox-count">{lightbox + 1} / {images.length}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
