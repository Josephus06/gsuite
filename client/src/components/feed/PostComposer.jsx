import { useEffect, useRef, useState } from 'react';
import Avatar from '../Avatar';
import { fileToScaledDataUrl } from '../../utils/image';
import { AUDIENCES, audienceMeta } from './audience';

// FB's "Create post" dialog. Doubles as the edit dialog when `editing` is a post -- same
// fields, so keeping one component avoids two copies of the audience/photo logic.
export default function PostComposer({ open, onClose, onSubmit, user, groupName, editing }) {
  const [body, setBody] = useState('');
  const [image, setImage] = useState(null);
  const [audience, setAudience] = useState('public');
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const textRef = useRef(null);
  const fileRef = useRef(null);

  // Reset to either a blank post or the one being edited each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setBody(editing?.body || '');
    setImage(editing?.image_data || null);
    setAudience(editing?.audience || 'public');
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
  }, [open, editing]);

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

  async function pickImage(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      setImage(await fileToScaledDataUrl(file));
    } catch (err) {
      setError(err.message || 'Could not read that image.');
    }
  }

  async function submit() {
    const text = body.trim();
    if (!text && !image) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ body: text, image_data: image, audience });
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not publish your post.');
      setBusy(false);
    }
  }

  if (!open) return null;

  const meta = audienceMeta(audience, groupName);
  const canPost = Boolean(body.trim() || image) && !busy;
  // FB only uses the oversized text treatment for short, image-less posts.
  const bigText = !image && body.length <= 130;

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
                  {AUDIENCES.map((a) => {
                    const m = audienceMeta(a.key, groupName);
                    return (
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
                    );
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

          {image && (
            <div className="fb-preview-wrap">
              <img src={image} alt="Attachment preview" />
              <button type="button" className="fb-preview-remove" onClick={() => setImage(null)} aria-label="Remove photo">✕</button>
            </div>
          )}

          <div className="fb-attach-row">
            <span>Add to your post</span>
            <div className="fb-attach-btns">
              <button type="button" className="fb-attach-btn" title="Photo" onClick={() => fileRef.current?.click()}>🖼️</button>
              <button type="button" className="fb-attach-btn" title="Tag people" onClick={() => setBody((b) => `${b}@`)}>🏷️</button>
              <button type="button" className="fb-attach-btn" title="Feeling" onClick={() => setBody((b) => `${b}😊`)}>😊</button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={pickImage}
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
