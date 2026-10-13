import api from '../api/client';

// Upload a feed video in pieces (2026-10-13; server lib/feedVideos.js). A piece that fails is retried
// after asking the server how much it already has, so a dropped connection costs one piece, not
// the whole file. onProgress(fraction 0..1); signal (AbortController) stops it.
export const MAX_VIDEO_BYTES = 5 * 1024 ** 3;
const RETRIES = 6;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function uploadFeedVideo(file, { onProgress, signal } = {}) {
  if (!file.type.startsWith('video/')) throw new Error('That is not a video file.');
  if (file.size > MAX_VIDEO_BYTES) throw new Error('Videos must be 5 GB or smaller.');
  const { data: start } = await api.post('/feed/videos/uploads', {
    file_name: file.name, size: file.size, mime_type: file.type,
  }, { signal });
  const { id, chunk_bytes: chunk } = start;
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    if (signal?.aborted) throw new Error('Upload cancelled.');
    const piece = file.slice(offset, Math.min(offset + chunk, file.size));
    try {
      const { data } = await api.put(`/feed/videos/uploads/${id}/chunk`, piece, {
        params: { offset },
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 10 * 60 * 1000,
        signal,
        onUploadProgress: (e) => onProgress?.(Math.min(1, (offset + (e.loaded || 0)) / file.size)),
      });
      offset = Number(data.received_bytes);
      failures = 0;
      onProgress?.(offset / file.size);
    } catch (err) {
      if (signal?.aborted) throw new Error('Upload cancelled.');
      // A refusal the server means (too big, finished, not found) is final.
      const status = err.response?.status;
      if (status && status !== 409 && status < 500) throw new Error(err.response?.data?.error || 'Upload failed.');
      failures += 1;
      if (failures > RETRIES) throw new Error('The connection keeps dropping -- the video could not be uploaded.');
      await wait(Math.min(30000, 1000 * 2 ** failures));
      try {
        const { data } = await api.get(`/feed/videos/uploads/${id}`, { signal });
        offset = Number(data.received_bytes);
      } catch { /* try the same piece again */ }
    }
  }
  return { id, file_name: file.name, size_bytes: file.size, mime_type: file.type };
}
