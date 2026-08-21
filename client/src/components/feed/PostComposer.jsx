import { useEffect, useRef, useState } from 'react';
import Avatar from '../Avatar';
import { fileToScaledDataUrl } from '../../utils/image';
import { AUDIENCES, audienceMeta } from './audience';

// Kept in step with MAX_IMAGES_PER_POST on the server, which is what actually enforces it.
// This copy is so the picker can say no before spending time scaling files it will reject.
const MAX_IMAGES = 10;

// FB's "Create post" dialog. Doubles as the edit dialog when `editing` is a post -- same
// fields, so keeping one component avoids two copies of the audience/photo logic.
// `groups` arrives only for a System Admin -- the server sends the department list to nobody
// else, and its absence is what keeps the plain "My department" option for everyone else.
// One list, one source: the picker cannot offer a department the server would refuse.
export default function PostComposer({
  open, onClose, onSubmit, user, groupName, groupId, groups, editing,
}) {
  const [body, setBody] = useState('');
  const [images, setImages] = useState([]);
  const [audience, setAudience] = useState('public');
  const [targetGroupId, setTargetGroupId] = useState(null);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const textRef = useRef(null);
  const fileRef = useRef(null);

  // Reset to either a blank post or the one being edited each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setBody(editing?.body || '');
    setImages(editing?.images?.length
      ? editing.images
      : (editing?.image_data ? [editing.image_data] : []));
    setAudience(editing?.audience || 'public');
    // Editing reopens on the department the post actually went to, which for an admin is not
    // necessarily their own.
    setTargetGroupId(editing?.audience_group_id ?? groupId ?? null);
    setAudienceOpen(false);
    setError('');
    setBusy(false);
    // Focus after paint so the caret lands at the end of existing text.
    const id = setTimeout(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoGrow(el);
    }, 30);
    return () => clearTimeout(id);
  }, [open, editing, groupId]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  async function pickImages(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setError('');

    // Appended rather than replacing: picking photos from two different folders is one post
    // as far as the author is concerned, and a second trip to the picker should not wipe
    // the first. Trimmed to what is left rather than refused outright, so choosing twenty
    // still gives you ten and a message instead of nothing and a message.
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setError(`A post can have at most ${MAX_IMAGES} photos.`);
      return;
    }
    const taking = files.slice(0, room);
    try {
      // Scaled in parallel: these are independent canvas draws, and a set of ten run one at
      // a time is a visible wait on the Add photo button.
      const scaled = await Promise.all(taking.map((f) => fileToScaledDataUrl(f)));
      setImages((current) => [...current, ...scaled]);
      if (files.length > room) {
        setError(`Only the first ${room} photo${room === 1 ? '' : 's'} were added -- a post can have at most ${MAX_IMAGES}.`);
      }
    } catch (err) {
      setError(err.message || 'Could not read that image.');
    }
  }

  function removeImage(index) {
    setImages((current) => current.filter((_, i) => i !== index));
  }

  async function submit() {
    const text = body.trim();
    if (!text && !images.length) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        body: text,
        images,
        audience,
        audience_group_id: audience === 'department' ? targetGroupId : null,
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not publish your post.');
      setBusy(false);
    }
  }

  if (!open) return null;

  // An admin choosing another department must see that department on the button, not their
  // own -- the label is the only thing telling them where the post is about to go.
  const chosenGroupName = groups?.find((g) => g.id === targetGroupId)?.name || groupName;
  const meta = audienceMeta(audience, chosenGroupName);
  const canPost = Boolean(body.trim() || images.length) && !busy;
  // FB only uses the oversized text treatment for short, image-less posts.
  const bigText = !images.length && body.length <= 130;

  return (
    <div className="fb-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fb-modal" role="dialog" aria-modal="true" aria-label={editing ? 'Edit post' : 'Create post'}>
        <div className="fb-modal-head">
          {editing ? 'Edit post' : 'Create post'}
          <button type="button" className="fb-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="fb-modal-body">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <Avatar user={user} size={40} />
            <div style={{ position: 'relative' }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{user?.display_name}</div>
              <button type="button" className="fb-audience" onClick={() => setAudienceOpen((v) => !v)}>
                <span>{meta.icon}</span>{meta.label}<span style={{ fontSize: 10 }}>▾</span>
              </button>
              {audienceOpen && (
                <div className="fb-audience-menu" style={{ top: '100%', left: 0, marginTop: 4 }}>
                  {AUDIENCES.flatMap((a) => {
                    // For an admin the single "My department" row becomes one row per
                    // department, in place. Expanded here rather than nested behind a submenu
                    // so choosing a department is the same one click it is for everyone else.
                    if (a.key === 'department' && groups?.length) {
                      return groups.map((g) => (
                        <button
                          key={`department-${g.id}`}
                          type="button"
                          className="fb-audience-option"
                          onClick={() => {
                            setAudience('department');
                            setTargetGroupId(g.id);
                            setAudienceOpen(false);
                          }}
                        >
                          <span style={{ fontSize: 20 }}>{a.icon}</span>
                          <span>
                            {g.name}
                            <span className="sub">
                              {g.id === groupId ? 'Only my department' : 'Only that department'}
                            </span>
                          </span>
                          {audience === 'department' && targetGroupId === g.id
                            && <span style={{ marginLeft: 'auto', color: 'var(--fb-blue)' }}>✓</span>}
                        </button>
                      ));
                    }

                    const m = audienceMeta(a.key, groupName);
                    return [(
                      <button
                        key={a.key}
                        type="button"
                        className="fb-audience-option"
                        onClick={() => { setAudience(a.key); setAudienceOpen(false); }}
                      >
                        <span style={{ fontSize: 20 }}>{m.icon}</span>
                        <span>
                          {m.label}
                          <span className="sub">{a.sub}</span>
                        </span>
                        {audience === a.key && <span style={{ marginLeft: 'auto', color: 'var(--fb-blue)' }}>✓</span>}
                      </button>
                    )];
                  })}
                </div>
              )}
            </div>
          </div>

          <textarea
            ref={textRef}
            className={`fb-modal-textarea${bigText ? '' : ' small'}`}
            placeholder={`What's on your mind, ${(user?.display_name || '').split(' ')[0]}?`}
            value={body}
            onChange={(e) => { setBody(e.target.value); autoGrow(e.target); }}
          />

          {images.length > 0 && (
            <div className={`fb-preview-grid n${Math.min(images.length, 4)}`}>
              {images.map((img, i) => (
                /* Index as key: these are data URLs with no id of their own, and the same
                   photo can legitimately be added twice. */
                <div className="fb-preview-cell" key={i}>
                  <img src={img} alt={`Attachment ${i + 1}`} />
                  <button
                    type="button"
                    className="fb-preview-remove"
                    onClick={() => removeImage(i)}
                    aria-label={`Remove photo ${i + 1}`}
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          <div className="fb-attach-row">
            <span>Add to your post</span>
            <div className="fb-attach-btns">
              <button
                type="button"
                className="fb-attach-btn"
                title={images.length ? `Add photos (${images.length}/${MAX_IMAGES})` : 'Photo'}
                onClick={() => fileRef.current?.click()}
              >🖼️</button>
              <button type="button" className="fb-attach-btn" title="Tag people" onClick={() => setBody((b) => `${b}@`)}>🏷️</button>
              <button type="button" className="fb-attach-btn" title="Feeling" onClick={() => setBody((b) => `${b}😊`)}>😊</button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              onChange={pickImages}
              style={{ display: 'none' }}
            />
          </div>

          {error && <div className="fb-error" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
        </div>

        <div className="fb-modal-foot">
          <button type="button" className="fb-post-btn" disabled={!canPost} onClick={submit}>
            {busy ? 'Posting…' : editing ? 'Save' : 'Post'}
          </button>
        </div>
      </div>
    </div>
  );
}
