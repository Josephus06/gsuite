import { useEffect, useState } from 'react';
import api from '../../api/client';

// Uploaded flipbook pages are fetched by id and handed to the <img> as an object URL.
//
// /product-flipbook/:id/file needs an Authorization header and a browser sends none for
// <img src>, so pointing the tag straight at the API gets a 401 and a broken-image icon.
// This is the third module to hit that -- the feed and the dashboard carousel resolve their
// bytes the same way.
//
// Cached at module level and never revoked: turning back and forth through a brochure would
// otherwise re-download every page, and revoking a URL that a mounted leaf is still showing
// blanks the page.
const cache = new Map();
const inflight = new Map();

export function loadPageImage(id) {
  if (cache.has(id)) return Promise.resolve(cache.get(id));
  if (inflight.has(id)) return inflight.get(id);
  const p = api.get(`/product-flipbook/${id}/file`, { responseType: 'blob' })
    .then(({ data }) => {
      const url = URL.createObjectURL(data);
      cache.set(id, url);
      inflight.delete(id);
      return url;
    })
    .catch(() => { inflight.delete(id); cache.set(id, null); return null; });
  inflight.set(id, p);
  return p;
}

// Dropped when a page is deleted, so re-uploading in its place cannot show the old artwork
// from a stale entry.
export function forgetPageImage(id) {
  const url = cache.get(id);
  if (url) URL.revokeObjectURL(url);
  cache.delete(id);
  inflight.delete(id);
}

export default function useFlipbookImage(id) {
  const [url, setUrl] = useState(() => cache.get(id) ?? null);
  useEffect(() => {
    if (!id) { setUrl(null); return undefined; }
    let stale = false;
    setUrl(cache.get(id) ?? null);
    loadPageImage(id).then((u) => { if (!stale) setUrl(u); });
    return () => { stale = true; };
  }, [id]);
  return url;
}
