import { useEffect, useRef, useState } from 'react';
import api from '../api/client';

// The artist's files for a job order -- the perspective drawing and the Cutting List / Bill
// of Materials, in whatever format they were produced. Sales approves against these, so the
// Sales Approval transition is refused server-side until at least one exists.
//
// Uploads go up as base64 in a JSON body (there is no multipart handler on the server); the
// API mounts a larger body parser on this one endpoint to fit them.
const KINDS = ['Perspective', 'Bill of Materials', 'Other'];
const MAX_BYTES = 10 * 1024 * 1024;

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

// canUpload: the assigned artist (or a design supervisor / admin acting for them).
// canDelete: System Admin only -- an attachment is the record Sales approved against.
export default function ArtistAttachments({ jobOrderId, canUpload, canDelete, onChange }) {
  const [rows, setRows] = useState([]);
  const [kind, setKind] = useState(KINDS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  function load() {
    return api.get(`/job-orders/${jobOrderId}/attachments`).then(({ data }) => setRows(data));
  }

  useEffect(() => { load(); }, [jobOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleFile(e) {
    await upload(e.target.files?.[0]);
  }

  async function upload(file) {
    if (!file) return;
    setError('');

    // Size is checked here as well as on the server so the user finds out before spending a
    // minute uploading a file that will be refused. Type is not restricted.
    if (file.size > MAX_BYTES) {
      setError(`"${file.name}" is ${fileSize(file.size)}. Files must be 10MB or smaller.`);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    setBusy(true);
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
      await load();
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleDelete(attachmentId, name) {
    if (!confirm(`Remove "${name}"?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.delete(`/job-orders/${jobOrderId}/attachments/${attachmentId}`);
      await load();
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that file');
    } finally {
      setBusy(false);
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
    } catch {
      setError('Could not open that file');
    }
  }

  return (
    <div className="card">
      <div className="att-head">
        <div>
          <h3>Artist Attachment</h3>
          <p className="att-sub">
            The perspective drawing and the Cutting List / Bill of Materials. Sales approves
            against these, so at least one file is required before this Job Order can be sent
            for Sales Approval.
          </p>
        </div>
        {rows.length > 0 && <span className="att-count">{rows.length} file{rows.length === 1 ? '' : 's'}</span>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {rows.length === 0 ? (
        <div className="att-empty">
          <div className="att-empty-mark">📎</div>
          <strong>No files attached yet</strong>
          <span>{canUpload ? 'Attach the perspective and Bill of Materials to continue.' : 'The assigned artist has not attached anything yet.'}</span>
        </div>
      ) : (
        <div className="att-list">
          {rows.map((r) => (
            <div className="att-item" key={r.id}>
              <div className="att-icon">{fileExt(r.file_name)}</div>
              <div className="att-body">
                <button type="button" className="att-name" onClick={() => handleOpen(r.id)}>{r.file_name}</button>
                <div className="att-meta">
                  {fileSize(r.size_bytes)} · {r.uploaded_by_name || 'Unknown'}
                  {r.created_at ? ` · ${new Date(r.created_at).toLocaleString()}` : ''}
                </div>
              </div>
              <span className="att-kind">{r.kind}</span>
              {canDelete && (
                <button type="button" className="btn btn-sm btn-warning" disabled={busy} onClick={() => handleDelete(r.id, r.file_name)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canUpload && (
        <div className="att-upload">
          <div className="att-field">
            <label htmlFor="att-kind">Document type</label>
            <select id="att-kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <label
            className={`att-drop${dragOver ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files?.[0]); }}
          >
            <input ref={fileRef} type="file" onChange={handleFile} disabled={busy} />
            <div className="att-drop-main">
              {busy ? 'Uploading…' : <><em>Choose a file</em> or drag it here</>}
            </div>
            <div className="att-drop-hint">Any file type · up to 10MB</div>
          </label>
        </div>
      )}
    </div>
  );
}
