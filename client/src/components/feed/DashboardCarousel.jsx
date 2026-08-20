import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';

// The carousel rail beside the feed: company images and short clips, cycling on their own.
//
// Media is referenced by id and streamed from /dashboard-carousel/:id/file rather than
// inlined, so the dashboard payload stays a few hundred bytes no matter how many photos are
// in it -- the same mistake the feed used to make with its post images.
const ROTATE_MS = 6000;
// Kept in step with MAX_IMAGE_BYTES / MAX_VIDEO_BYTES in routes/dashboardCarousel.js.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

export default function DashboardCarousel() {
  const [items, setItems] = useState([]);
  const [canUpload, setCanUpload] = useState(false);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/dashboard-carousel');
      setItems(data.items || []);
      setCanUpload(!!data.can_upload);
      setIndex((i) => (i < (data.items || []).length ? i : 0));
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const current = items[index];

  // Auto-advance, but never while a video is playing -- cutting a clip off mid-sentence to
  // show the next photo is worse than a carousel that waits.
  useEffect(() => {
    if (items.length < 2 || current?.media_type === 'video') return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [items.length, current?.media_type, index]);

  async function upload(file) {
    if (!file) return;
    // Checked here, before reading 16MB into memory and posting it. Too large a body is
    // rejected by the request parser BEFORE it reaches the route, so the reply carries no
    // JSON error to report -- the user just sees "could not upload" with no reason. Saying
    // the actual size against the actual limit is the whole difference.
    const isVideo = (file.type || '').startsWith('video/');
    const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (!isVideo && !(file.type || '').startsWith('image/')) {
      setError('Only an image or a short video can go in the carousel.');
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    if (file.size > limit) {
      setError(`${file.name} is ${(file.size / 1048576).toFixed(1)}MB — ${isVideo ? 'videos' : 'images'} must be ${limit / 1048576}MB or smaller.`);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
      });
      await api.post('/dashboard-carousel', {
        data, mime_type: file.type, file_name: file.name,
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error
        || (err.response?.status === 413 ? 'That file is too large to upload.' : `Could not upload ${file.name}.`));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove() {
    if (!current) return;
    // Says permanently, because it is: the row and its bytes are deleted, not hidden.
    if (!window.confirm(`Delete ${current.file_name || 'this item'} from the carousel? It is removed from the database permanently.`)) return;
    try {
      await api.delete(`/dashboard-carousel/${current.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that item.');
    }
  }

  // Nothing to show and nothing this user could add: draw nothing rather than an empty frame
  // taking up a column for everyone who cannot use it.
  if (!items.length && !canUpload) return null;

  return (
    <div className="fb-card fb-carousel">
      <div className="fb-rail-title">Spotlight</div>

      {current ? (
        <div className="fb-carousel-stage">
          {current.media_type === 'video' ? (
            // Controls, and no autoplay: an unexpected noise from a dashboard is startling,
            // and muted autoplay everywhere is its own kind of annoying.
            <video
              key={current.id}
              className="fb-carousel-media"
              src={`/api/dashboard-carousel/${current.id}/file`}
              controls
              preload="metadata"
            />
          ) : (
            <img
              key={current.id}
              className="fb-carousel-media"
              src={`/api/dashboard-carousel/${current.id}/file`}
              alt={current.caption || ''}
              loading="lazy"
            />
          )}

          {items.length > 1 && (
            <>
              <button type="button" className="fb-carousel-nav prev" aria-label="Previous"
                onClick={() => setIndex((i) => (i - 1 + items.length) % items.length)}>‹</button>
              <button type="button" className="fb-carousel-nav next" aria-label="Next"
                onClick={() => setIndex((i) => (i + 1) % items.length)}>›</button>
            </>
          )}
        </div>
      ) : (
        <div className="fb-carousel-empty muted">Nothing here yet.</div>
      )}

      {current?.caption && <div className="fb-carousel-caption">{current.caption}</div>}

      {items.length > 1 && (
        <div className="fb-carousel-dots">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              aria-label={`Show item ${i + 1}`}
              className={`fb-carousel-dot${i === index ? ' active' : ''}`}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}

      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}

      {canUpload && (
        <div className="fb-carousel-actions">
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*"
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy}
            onClick={() => fileInput.current?.click()}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
          {current && <button type="button" className="btn btn-sm" onClick={remove}>Delete</button>}
        </div>
      )}
      {canUpload && (
        <div className="fb-carousel-hint muted">Images up to 5MB · videos up to 25MB</div>
      )}
    </div>
  );
}
