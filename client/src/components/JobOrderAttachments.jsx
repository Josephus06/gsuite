import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import ArchivedTag, { blobErrorMessage } from './ArchivedTag';
import { displayDateTime } from '../utils/dates';

// Files attached to a Job Order. Two different sets live against the same JO and the same
// endpoint, told apart by `kind`:
//
//   Artist Attachment      the perspective drawing and Cutting List / Bill of Materials, on
//                          the Sales-side Job Order view. Sales approves against these, so the
//                          Sales Approval transition is refused server-side until one exists.
//   Production Attachment  the planner's own files, on the Production JO view. Nothing is
//                          approved against them and no transition depends on them.
//
// The endpoint returns every attachment on the JO regardless of kind, so each tab filters to
// its OWN kinds. Without that, a planner's file would show up under Artist Attachment and be
// read as a drawing Sales had approved. The two lists are disjoint on the server
// (ARTIST_ATTACHMENT_KINDS / PRODUCTION_ATTACHMENT_KINDS in routes/jobOrders.js) -- keep them
// that way, because this filter is what depends on it.
const MAX_BYTES = 10 * 1024 * 1024;

export const ARTIST_KINDS = ['Perspective', 'Bill of Materials', 'Other'];
// Production uploads are PAR or Picture (2026-11-09); the older production kinds are still LISTED, so the
// files already filed under them stay visible and removable, but are not offered for new uploads.
export const PRODUCTION_UPLOAD_KINDS = ['PAR', 'Picture'];
export const PRODUCTION_KINDS = [...PRODUCTION_UPLOAD_KINDS, 'Production Plan', 'Reference', 'PAR & Pics', 'Other (Production)'];

// Short extension badge for the row icon: "PDF", "XLSX", or "FILE" when there is none.
function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
}

function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// canUpload / canDelete are decided by the caller, because the two tabs answer to different
// people -- the assigned artist on one, the production planner on the other. The server
// enforces the same split by kind; these only decide what to draw.
export default function JobOrderAttachments({
  jobOrderId,
  kinds = ARTIST_KINDS,
  // The kinds offered in "Document type" -- by default every kind listed.
  uploadKinds,
  // A note under the drop box, e.g. that images are saved as PNG.
  uploadNote,
  title = 'Artist Attachment',
  description,
  emptyHint,
  canUpload,
  // Why uploading is unavailable, when it is unavailable for a reason the viewer can act on --
  // as opposed to simply not being their job. Shown in place of the upload box.
  uploadBlockedHint,
  canDelete,
  onChange,
}) {
  const [rows, setRows] = useState([]);
  const offered = uploadKinds || kinds;
  const [kind, setKind] = useState(offered[0]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  function load() {
    return api.get(`/job-orders/${jobOrderId}/attachments`)
      .then(({ data }) => setRows((data || []).filter((r) => kinds.includes(r.kind))));
  }

  useEffect(() => { load(); }, [jobOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleFile(e) {
    await upload(e.target.files);
  }

  // Several files at once (2026-11-09), sent one after another under the chosen type. A file that is
  // refused -- too big, or the server says no -- is named in the error and the rest still go up.
  async function upload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError('');
    const failed = [];
    let sent = 0;
    for (const [i, file] of files.entries()) {
      // Size is checked here as well as on the server so the user finds out before spending a
      // minute uploading a file that will be refused.
      if (file.size > MAX_BYTES) { failed.push(`"${file.name}" is ${fileSize(file.size)} -- files must be 10MB or smaller.`); continue; }
      setBusy(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…');
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read that file'));
          reader.readAsDataURL(file);
        });
        await api.post(`/job-orders/${jobOrderId}/attachments`, {
          file_name: file.name, kind, data, mime_type: file.type || 'application/octet-stream',
        });
        sent += 1;
      } catch (err) {
        failed.push(err.response?.data?.error || `"${file.name}": ${err.message || 'upload failed'}`);
      }
    }
    setBusy('');
    if (fileRef.current) fileRef.current.value = '';
    if (failed.length) setError(`${sent ? `${sent} of ${files.length} uploaded. ` : ''}${failed.join(' ')}`);
    if (sent) { await load(); onChange?.(); }
  }

  async function handleDelete(attachmentId, name) {
    if (!confirm(`Remove "${name}"?`)) return;
    setBusy('Removing…');
    setError('');
    try {
      await api.delete(`/job-orders/${jobOrderId}/attachments/${attachmentId}`);
      await load();
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that file');
    } finally {
      setBusy('');
    }
  }

  // Opened through the API so the request carries the auth header -- a bare href would be
  // an unauthenticated GET.
  async function handleOpen(attachmentId) {
    setError('');
    try {
      const { data } = await api.get(`/job-orders/${jobOrderId}/attachments/${attachmentId}/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      window.open(url, '_blank');
      // Revoked on a delay: revoking immediately can beat the new tab to the object.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(await blobErrorMessage(err, 'Could not open that file'));
    }
  }

  return (
    <div className="card">
      <div className="att-head">
        <div>
          <h3>{title}</h3>
          {description && <p className="att-sub">{description}</p>}
        </div>
        {rows.length > 0 && <span className="att-count">{rows.length} file{rows.length === 1 ? '' : 's'}</span>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {rows.length === 0 ? (
        <div className="att-empty">
          <div className="att-empty-mark">📎</div>
          <strong>No files attached yet</strong>
          <span>{canUpload ? (emptyHint || 'Attach a file to get started.') : (uploadBlockedHint || 'Nothing has been attached yet.')}</span>
        </div>
      ) : (
        <div className="att-list">
          {rows.map((r) => (
            <div className="att-item" key={r.id}>
              <div className="att-icon">{fileExt(r.file_name)}</div>
              <div className="att-body">
                <button type="button" className="att-name" onClick={() => handleOpen(r.id)}>{r.file_name}</button>
                <ArchivedTag at={r.archived_at} />
                <div className="att-meta">
                  {fileSize(r.size_bytes)} · {r.uploaded_by_name || 'Unknown'}
                  {r.created_at ? ` · ${displayDateTime(r.created_at)}` : ''}
                </div>
              </div>
              <span className="att-kind">{r.kind}</span>
              {canDelete && (
                <button type="button" className="btn btn-sm btn-warning" disabled={!!busy} onClick={() => handleDelete(r.id, r.file_name)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Said here too, not only in the empty state: once a file exists the empty state is gone,
          and the upload box simply vanishing is the least informative way to refuse someone. */}
      {!canUpload && uploadBlockedHint && rows.length > 0 && (
        <div className="muted" style={{ marginTop: 12 }}>{uploadBlockedHint}</div>
      )}

      {canUpload && (
        <div className="att-upload">
          <div className="att-field">
            <label htmlFor={`att-kind-${jobOrderId}`}>Document type</label>
            <select id={`att-kind-${jobOrderId}`} value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!busy}>
              {offered.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <label
            className={`att-drop${dragOver ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
          >
            <input ref={fileRef} type="file" multiple onChange={handleFile} disabled={!!busy}
              accept={kind === 'Picture' ? 'image/*' : undefined} />
            <div className="att-drop-main">
              {busy || <><em>Choose files</em> or drag them here</>}
            </div>
            <div className="att-drop-hint">
              {kind === 'Picture' ? 'Images only' : 'Any file type'} · several at once · up to 10MB each{uploadNote ? ` · ${uploadNote}` : ''}
            </div>
          </label>
        </div>
      )}
    </div>
  );
}
