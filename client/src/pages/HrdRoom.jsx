import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

const ROUTE = '/hrd';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(v) {
  return v ? new Date(v).toLocaleString() : '—';
}

// What a browser will render in a tab rather than offering as a download. Deliberately a
// short allowlist: offering "View" on a .docx or a .zip produces a tab of binary garbage,
// which reads as the file being corrupted.
function canPreview(mime) {
  const m = String(mime || '').toLowerCase();
  return m === 'application/pdf' || m.startsWith('image/') || m === 'text/plain';
}

// Inside one room: whatever has been uploaded, and a way to add more. Any file type is
// accepted, so there is no accept="" filter on the picker.
export default function HrdRoom() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const fileInput = useRef(null);
  const [room, setRoom] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get(`${ROUTE}/${id}`);
      setRoom(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this room.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Uploaded one at a time rather than as a single batch: a 10MB ceiling applies per file,
  // and one oversized file in a selection should not lose the others.
  async function upload(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setError('');
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`${file.name} is ${formatBytes(file.size)} — the limit is 10 MB per file.`);
        continue;
      }
      setUploading(file.name);
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read that file.'));
          reader.readAsDataURL(file);
        });
        await api.post(`${ROUTE}/${id}/files`, {
          file_name: file.name,
          mime_type: file.type || 'application/octet-stream',
          data,
        });
      } catch (err) {
        setError(err.response?.data?.error || `Could not upload ${file.name}.`);
      }
    }
    setUploading('');
    if (fileInput.current) fileInput.current.value = '';
    await load();
  }

  async function removeFile(file) {
    if (!window.confirm(`Delete ${file.file_name}? This cannot be undone.`)) return;
    try {
      await api.delete(`${ROUTE}/${id}/files/${file.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete that file.');
    }
  }

  // The file route needs an Authorization header, so a plain <a href> cannot reach it -- the
  // bytes are fetched and handed to the browser as an object URL. Fetched once per file and
  // reused, so viewing and then downloading the same document does not pull it twice.
  const blobUrls = useRef(new Map());
  async function fileUrl(file) {
    if (blobUrls.current.has(file.id)) return blobUrls.current.get(file.id);
    const res = await api.get(`${ROUTE}/${id}/files/${file.id}/file`, { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([res.data], { type: file.mime_type || 'application/octet-stream' }));
    blobUrls.current.set(file.id, url);
    return url;
  }

  // Opens in a new tab, for the types a browser can actually render. Anything else would just
  // show as a wall of binary, which is why View is offered only where it works.
  async function viewFile(file) {
    try {
      window.open(await fileUrl(file), '_blank', 'noopener');
    } catch {
      setError(`Could not open ${file.file_name}.`);
    }
  }

  async function downloadFile(file) {
    try {
      const a = document.createElement('a');
      a.href = await fileUrl(file);
      a.download = file.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError(`Could not download ${file.file_name}.`);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (!room) return <div className="error-banner">{error || 'Room not found.'}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>{room.name}</h1>
        <div>
          <button className="btn btn-sm" onClick={() => navigate(ROUTE)}>Back to HRD</button>{' '}
          {can(ROUTE, 'can_add') && (
            <button className="btn btn-primary" disabled={!!uploading} onClick={() => fileInput.current?.click()}>
              {uploading ? `Uploading ${uploading}…` : 'Upload Files'}
            </button>
          )}
        </div>
      </div>

      {room.description && <div className="card muted" style={{ marginBottom: 16 }}>{room.description}</div>}
      {error && <div className="error-banner">{error}</div>}

      <input
        ref={fileInput}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => upload(e.target.files)}
      />

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Size</th>
                <th>Uploaded By</th>
                <th>Uploaded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {room.files.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  Nothing in this room yet.
                </td></tr>
              )}
              {room.files.map((file) => (
                <tr key={file.id}>
                  <td>{file.file_name}</td>
                  <td className="muted">{file.mime_type}</td>
                  <td>{formatBytes(file.size_bytes)}</td>
                  <td>{file.uploaded_by_name || '—'}</td>
                  <td>{formatDateTime(file.created_at)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canPreview(file.mime_type) && (
                      <>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => viewFile(file)}>View</button>{' '}
                      </>
                    )}
                    <button type="button" className="btn btn-sm" onClick={() => downloadFile(file)}>Download</button>{' '}
                    {can(ROUTE, 'can_delete') && (
                      <button type="button" className="btn btn-sm" onClick={() => removeFile(file)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
