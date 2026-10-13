import { useEffect, useRef, useState } from 'react';
import api from '../../api/client';

// A feed video (2026-10-13; server routes/feedVideos.js). The player streams it in pieces, so it
// starts at once and seeks anywhere without fetching the whole file. A <video> cannot send the login
// token, so the post first asks for a signed link -- only once it scrolls near the screen, so a long
// feed does not ask for every video at once.
const ORIGIN = String(api.defaults.baseURL || '').replace(/\/api\/?$/, ''); // '' on the web; the API host in the app

export default function FeedVideo({ video }) {
  const boxRef = useRef(null);
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  const retried = useRef(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || src) return undefined;
    let alive = true;
    const load = () => api.get(`/feed/videos/${video.id}/url`)
      .then(({ data }) => { if (alive) setSrc(`${ORIGIN}${data.url}`); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'This video could not be loaded.'); });
    if (!('IntersectionObserver' in window)) { load(); return () => { alive = false; }; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); }
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [video.id, src]);

  return (
    <div className="fb-post-video" ref={boxRef}>
      {error ? <div className="fb-post-video-msg">{error}</div>
        : src ? (
          // A link that expired while the page sat open: fetch a fresh one.
          <video controls preload="metadata" playsInline src={src}
            onError={() => {
              if (retried.current) { setError('This video could not be played.'); return; }
              retried.current = true;
              setSrc(null);
            }} />
        ) : <div className="fb-post-video-msg">Loading video…</div>}
    </div>
  );
}
