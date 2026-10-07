import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { displayDateTime } from '../utils/dates';

// Files attached to a form -- every type (2026-10-07): the receipt behind a liquidation, the
// billing behind a Request for Payment, the bank slip behind a Fund Transfer Request Form.
//
// Anyone who can open the form can attach to it. Removing is decided per file by the server
// (can_remove): the person who attached it, until the form is approved, or a System Admin. Same
// look and the same in-database storage as the Job Order attachments.
const MAX_BYTES = 10 * 1024 * 1024;

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

export default function FormAttachments({ formId }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  function load() {
    return api.get(`/forms/${formId}/attachments`).then(({ data }) => setRows(data || [])).catch(() => {});
  }

  useEffect(() => { load(); }, [formId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(file) {
    if (!file) return;
    setError('');
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
      await api.post(`/forms/${formId}/attachments`, {
        file_name: file.name, data, mime_type: file.type || 'application/octet-stream',
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(r) {
    if (!confirm(`Remove "${r.file_name}"?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.delete(`/forms/${formId}/attachments/${r.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that file');
    } finally {
      setBusy(false);
    }
  }

  // Through the API so the request carries the login -- a bare link would be refused.
  async function open(id) {
    setError('');
    try {
      const { data } = await api.get(`/forms/${formId}/attachments/${id}/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError('Could not open that file');
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="att-head">
        <div><h3>Attachments</h3></div>
        {rows.length > 0 && <span className="att-count">{rows.length} file{rows.length === 1 ? '' : 's'}</span>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {rows.length === 0 ? (
        <div className="att-empty">
          <div className="att-empty-mark">📎</div>
          <strong>No files attached yet</strong>
          <span>Attach receipts, billings or any supporting document.</span>
        </div>
      ) : (
        <div className="att-list">
          {rows.map((r) => (
            <div className="att-item" key={r.id}>
              <div className="att-icon">{fileExt(r.file_name)}</div>
              <div className="att-body">
                <button type="button" className="att-name" onClick={() => open(r.id)}>{r.file_name}</button>
                <div className="att-meta">
                  {fileSize(r.size_bytes)} · {r.uploaded_by_name || 'Unknown'}
                  {r.created_at ? ` · ${displayDateTime(r.created_at)}` : ''}
                </div>
              </div>
              {r.can_remove && (
                <button type="button" className="btn btn-sm btn-warning" disabled={busy} onClick={() => remove(r)}>Remove</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="att-upload">
        <label
          className={`att-drop${dragOver ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files?.[0]); }}
        >
          <input ref={fileRef} type="file" onChange={(e) => upload(e.target.files?.[0])} disabled={busy} />
          <div className="att-drop-main">{busy ? 'Uploading…' : <><em>Choose a file</em> or drag it here</>}</div>
          <div className="att-drop-hint">Any file type · up to 10MB</div>
        </label>
      </div>
    </div>
  );
}
