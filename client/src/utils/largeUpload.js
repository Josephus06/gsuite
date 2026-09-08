// Uploads a very large file straight to object storage, one part at a time.
//
// The file is never read into memory. `File.slice()` returns a lazy view, so each part is read
// from disk only as it is sent -- reading a 150 GB file into a Blob would kill the tab instantly.
//
// Each part is PUT directly to storage on a presigned URL. The application server signs the URLs
// and never sees the bytes, which is the only way an upload this size is survivable: proxying it
// through Node would occupy a connection for hours.
//
// Parts are retried individually. Over a multi-hour upload some part WILL fail on a domestic
// connection, and restarting 150 GB because part 900 timed out is not acceptable.

const MAX_ATTEMPTS = 4;

function backoffMs(attempt) {
  // 1s, 2s, 4s. Long enough for a blip to clear, short enough not to stall the whole upload.
  return 1000 * 2 ** (attempt - 1);
}

// Sends one part, retrying transient failures. Returns the ETag, which S3 requires to assemble
// the object -- an upload that loses an ETag cannot be completed.
async function putPart({ url, blob, signal }) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('Upload cancelled.');
    try {
      const res = await fetch(url, { method: 'PUT', body: blob, signal });
      if (!res.ok) throw new Error(`Storage rejected the part (HTTP ${res.status}).`);
      // The ETag header is exposed by S3/Spaces CORS as a matter of course, but if the bucket's
      // CORS rules omit ExposeHeaders the browser hides it -- and the upload cannot be completed.
      // Worth failing loudly here rather than at the very end of a 150 GB transfer.
      const etag = res.headers.get('etag');
      if (!etag) {
        throw new Error(
          'Storage did not return an ETag for this part. The bucket\'s CORS rules must expose the '
          + 'ETag header, or large uploads cannot be assembled.',
        );
      }
      return etag.replaceAll('"', '');
    } catch (err) {
      if (signal?.aborted) throw new Error('Upload cancelled.');
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => { setTimeout(r, backoffMs(attempt)); });
      }
    }
  }
  throw lastError || new Error('The part could not be uploaded.');
}

// Drives the whole upload.
//
//   api        the axios client, used only for the small control calls
//   file       the browser File
//   versionId  from /artist/init
//   partSize / partCount  the plan the server worked out
//   onProgress({ sent, total, part, partCount })
//   signal     an AbortSignal, so a cancel actually stops mid-transfer
export async function uploadInParts({ api, file, versionId, partSize, partCount, onProgress, signal }) {
  const parts = [];
  let sent = 0;

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (signal?.aborted) throw new Error('Upload cancelled.');

    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const blob = file.slice(start, end);

    // Signed as we reach it, not all up front: a presigned URL expires, and the last of 1,500
    // would be long dead by the time a slow line got to it.
    const { data } = await api.get(`/archiver/files/upload/${versionId}/part`, {
      params: { part_number: partNumber },
      signal,
    });

    const etag = await putPart({ url: data.url, blob, signal });
    parts.push({ part_number: partNumber, etag });

    sent += end - start;
    onProgress?.({ sent, total: file.size, part: partNumber, partCount });
  }

  const { data } = await api.post(`/archiver/files/upload/${versionId}/complete`, { parts }, { signal });
  return data;
}

// Best-effort cleanup. Called when an upload fails or is cancelled, so the parts already in the
// bucket are discarded -- abandoned multipart uploads are invisible and still billed.
export async function abortUpload(api, versionId) {
  try { await api.post(`/archiver/files/upload/${versionId}/abort`); }
  catch { /* the upload may already be gone; nothing useful to do with a failure here */ }
}

export default uploadInParts;
