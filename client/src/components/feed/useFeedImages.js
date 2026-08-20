import { useEffect, useState } from 'react';
import api from '../../api/client';

// Feed photos are fetched by id instead of arriving inline with the posts, which is what
// keeps a page of feed at a few KB instead of ~3 MB. The API needs an Authorization header,
// so an <img src="/api/feed/images/1"> cannot work on its own -- the bytes are fetched and
// handed to the <img> as an object URL.
//
// Cached at module level, keyed by image id, and never revoked: an object URL is a few dozen
// bytes of bookkeeping, and revoking one that a still-mounted post is displaying blanks the
// photo. Scrolling the feed re-renders the same posts constantly, and without this each pass
// would re-download every photo.
const cache = new Map();
const inflight = new Map();

function loadImage(id) {
  if (cache.has(id)) return Promise.resolve(cache.get(id));
  if (inflight.has(id)) return inflight.get(id);

  const p = api.get(`/feed/images/${id}`, { responseType: 'blob' })
    .then(({ data }) => {
      const url = URL.createObjectURL(data);
      cache.set(id, url);
      inflight.delete(id);
      return url;
    })
    .catch(() => {
      // A deleted or no-longer-visible photo resolves to nothing rather than throwing, so one
      // missing image cannot take the whole feed down with it.
      inflight.delete(id);
      cache.set(id, null);
      return null;
    });
  inflight.set(id, p);
  return p;
}

// Resolves a post's image ids to displayable URLs. Returns them in the same order, with
// nulls for any that failed, so callers can index alongside the id list.
export default function useFeedImages(imageIds) {
  const key = (imageIds || []).join(',');
  const [urls, setUrls] = useState(() => (imageIds || []).map((id) => cache.get(id) ?? null));

  useEffect(() => {
    let stale = false;
    const ids = key ? key.split(',').map(Number) : [];
    if (!ids.length) { setUrls([]); return undefined; }

    Promise.all(ids.map(loadImage)).then((resolved) => {
      if (!stale) setUrls(resolved);
    });
    return () => { stale = true; };
  }, [key]);

  return urls;
}
