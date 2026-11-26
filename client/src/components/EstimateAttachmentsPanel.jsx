import { useEffect, useState } from 'react';
import api from '../api/client';

// An estimate's attachments on its view page (2026-11-25): order-confirmation scans and the
// 3D Studio's day / night renders and drawing set. Images show as pictures, PDFs open in a tab.
// Files need the signed-in user's token, so they are fetched as blobs rather than linked.

function useBlobUrl(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let made = null;
    let cancelled = false;
    api.get(path, { responseType: 'blob' })
      .then(({ data }) => { if (!cancelled) { made = URL.createObjectURL(data); setUrl(made); } })
      .catch(() => {});
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  return url;
}

function ImageTile({ estimateId, file }) {
  const url = useBlobUrl(`/estimates/${estimateId}/attachments/${file.id}/file`);
  return (
    <a href={url || undefined} target="_blank" rel="noreferrer" title={file.file_name}
      style={{ display: 'block', width: 300, border: '1px solid var(--border, #e2e8f0)', borderRadius: 6, overflow: 'hidden', background: '#f8fafc' }}>
      {url
        ? <img src={url} alt={file.file_name} style={{ width: '100%', height: 220, objectFit: 'contain', display: 'block', background: '#fff' }} />
        : <div className="muted" style={{ height: 220, display: 'grid', placeItems: 'center' }}>Loading...</div>}
      <div style={{ padding: '6px 8px', fontSize: 12, wordBreak: 'break-all' }}>{file.file_name}</div>
    </a>
  );
}

async function openFile(estimateId, file, download = false) {
  const { data } = await api.get(`/estimates/${estimateId}/attachments/${file.id}/file`, { responseType: 'blob' });
  const url = URL.createObjectURL(data);
  if (download) {
    const a = document.createElement('a');
    a.href = url; a.download = file.file_name; a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function useEstimateAttachments(estimateId) {
  const [files, setFiles] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.get(`/estimates/${estimateId}/attachments`)
      .then(({ data }) => { if (!cancelled) setFiles(data.filter((f) => !f.archived_at)); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [estimateId]);
  return files;
}

export default function EstimateAttachmentsPanel({ estimateId, files }) {
  if (files === null) return <div className="card muted">Loading attachments...</div>;
  if (!files.length) return <div className="card"><p className="muted" style={{ margin: 0 }}>No attachments.</p></div>;
  const images = files.filter((f) => String(f.mime_type).startsWith('image/'));
  const others = files.filter((f) => !String(f.mime_type).startsWith('image/'));
  const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  return (
    <div className="card">
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: others.length ? 16 : 0 }}>
          {images.map((f) => <ImageTile key={f.id} estimateId={estimateId} file={f} />)}
        </div>
      )}
      {others.length > 0 && (
        <table>
          <thead><tr><th>File</th><th>Size</th><th>Added by</th><th></th></tr></thead>
          <tbody>
            {others.map((f) => (
              <tr key={f.id}>
                <td>{f.file_name}</td>
                <td>{size(f.size_bytes)}</td>
                <td>{f.uploaded_by_name || ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => openFile(estimateId, f)}>Open</button>{' '}
                  <button className="btn btn-sm" onClick={() => openFile(estimateId, f, true)}>Download</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
