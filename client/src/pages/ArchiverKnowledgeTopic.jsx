import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatBytes, formatDateTime, fileKind } from '../utils/archiverLabels';
import { readFileAsBase64 } from '../utils/archiverUpload';
import { uploadInParts, abortUpload } from '../utils/largeUpload';

// Adding a card INSIDE this one. There is no section picker: a nested card inherits the section
// of the card it sits in, and the server takes it from the parent rather than the request, so
// offering the choice here would be offering a decision that is then ignored.
function NewChildModal({ parent, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!form.name.trim()) { setError('Give the card a name.'); return; }
    setError(''); setSaving(true);
    try {
      const { data } = await api.post('/archiver/knowledge-base/topics', { ...form, parent_topic_id: parent.id });
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not create the card.');
      setSaving(false);
    }
  }

  return (
    <Modal title={`New card inside ${parent.name}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Name *</label>
        <input
          value={form.name} autoFocus
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="Printheads, Roland VG3, Ink profiles..."
        />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea
          rows={3} value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What this card is for, so the next person knows whether to open it."
        />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Create'}</button>
      </div>
    </Modal>
  );
}

// Uploading into a card. Same two paths as everywhere else in the Archiver: small files into the
// database so the office can read them offline, large ones straight to object storage.
function UploadModal({ topic, onClose, onSaved }) {
  const [picked, setPicked] = useState(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');

  const allowed = topic.allowed_extensions || [];
  const dbMax = topic.db_max_bytes || 25 * 1024 * 1024;

  async function save() {
    if (!picked) { setError('Choose a file.'); return; }
    if (allowed.length && !allowed.some((ext) => picked.name.toLowerCase().endsWith(ext))) {
      setError(`That file type is not accepted. Allowed: ${allowed.join(', ')}.`);
      return;
    }
    setError(''); setSaving(true);

    if (picked.size <= dbMax) {
      try {
        const payload = await readFileAsBase64(picked, dbMax);
        await api.post(`/archiver/knowledge-base/topics/${topic.id}/files`, { ...payload, title, note });
        onSaved();
      } catch (e) {
        setError(e.response?.data?.error || e.message || 'Upload failed.');
        setSaving(false);
      }
      return;
    }

    if (!topic.storage_configured) {
      setError(`That file is ${formatBytes(picked.size)}, above the ${formatBytes(dbMax)} limit, and large-file storage is not configured on this server.`);
      setSaving(false);
      return;
    }

    let fileId = null;
    try {
      const { data: init } = await api.post(`/archiver/knowledge-base/topics/${topic.id}/files/init`, {
        file_name: picked.name, size_bytes: picked.size, title, note,
      });
      fileId = init.file_id;
      setProgress({ sent: 0, total: picked.size, part: 0, partCount: init.part_count });
      await uploadInParts({
        api, file: picked, versionId: fileId,
        partSize: init.part_size, partCount: init.part_count,
        onProgress: setProgress,
        // The knowledge base signs and completes on its own paths rather than the artist ones.
        basePath: '/archiver/knowledge-base/files',
      });
      onSaved();
    } catch (e) {
      if (fileId) await abortUpload(api, fileId, '/archiver/knowledge-base/files');
      setError(e.response?.data?.error || e.message || 'Upload failed.');
      setSaving(false);
      setProgress(null);
    }
  }

  return (
    <Modal title={`Upload to ${topic.name}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>File *</label>
        <input type="file" accept={allowed.join(',')} onChange={(e) => { setPicked(e.target.files?.[0] || null); setError(''); }} />
        {picked && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{picked.name} · {formatBytes(picked.size)}</div>}
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          PDF, Word, Excel, PowerPoint, images and text. Files over {formatBytes(dbMax)} go straight to archive storage.
        </div>
      </div>
      <div className="field">
        <label>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this is, if the filename does not say" />
      </div>
      <div className="field">
        <label>Note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Revision, source, anything worth knowing" />
      </div>

      {progress && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
            <strong>{formatBytes(progress.sent)} of {formatBytes(progress.total)} ({Math.floor((progress.sent / progress.total) * 100)}%)</strong>
            <span className="muted">part {progress.part} of {progress.partCount}</span>
          </div>
          <div className="loading-spinner-bar" style={{ width: '100%' }}>
            <span style={{ width: `${(progress.sent / progress.total) * 100}%` }} />
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Keep this tab open — closing it stops the transfer.
          </p>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !picked} onClick={save}>
          {saving ? (progress ? `Uploading ${Math.floor((progress.sent / progress.total) * 100)}%` : 'Uploading...') : 'Upload'}
        </button>
      </div>
    </Modal>
  );
}

function RenameModal({ topic, onClose, onSaved }) {
  const [form, setForm] = useState({ name: topic.name, description: topic.description || '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!form.name.trim()) { setError('A name is required.'); return; }
    setError(''); setSaving(true);
    try { await api.put(`/archiver/knowledge-base/topics/${topic.id}`, form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); setSaving(false); }
  }

  return (
    <Modal title={`Edit ${topic.name}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Name *</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

export default function ArchiverKnowledgeTopic() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [topic, setTopic] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [showNewChild, setShowNewChild] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    () => api.get(`/archiver/knowledge-base/topics/${id}`).then(({ data }) => { setTopic(data); setLoading(false); }),
    [id],
  );
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  // A stored file streams from the app; a large one comes back as a signed URL to storage. Both
  // end up saved by the browser, so the difference is invisible here beyond one extra hop.
  async function download(file) {
    setBusy(true); setError('');
    try {
      if (file.storage === 'spaces') {
        const { data } = await api.get(`/archiver/knowledge-base/files/${file.id}/download`);
        window.open(data.url, '_blank', 'noopener');
      } else {
        const res = await api.get(`/archiver/knowledge-base/files/${file.id}/download`, { responseType: 'blob' });
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url; a.download = file.file_name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { setError(e.response?.data?.error || 'Download failed.'); }
    finally { setBusy(false); }
  }

  async function removeFile(file) {
    if (!confirm(`Delete "${file.file_name}"? This cannot be undone.`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/archiver/knowledge-base/files/${file.id}`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed.'); }
    finally { setBusy(false); }
  }

  async function removeTopic() {
    if (!confirm(`Delete the card "${topic.name}"?`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/archiver/knowledge-base/topics/${id}`); navigate('/archiver/knowledge-base'); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed.'); setBusy(false); }
  }

  if (loading || !topic) return <LoadingSpinner />;
  const files = topic.files || [];
  const children = topic.children || [];
  const ancestors = topic.ancestors || [];
  // The card this one sits in, if any -- the last ancestor is the immediate parent.
  const parent = ancestors.length ? ancestors[ancestors.length - 1] : null;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* Back to the card this one sits in, not all the way out -- three levels deep, the
              front page is rarely where you meant to go. */}
          <button
            className="btn btn-sm"
            onClick={() => navigate(parent ? `/archiver/knowledge-base/${parent.id}` : '/archiver/knowledge-base')}
          >
            {parent ? `Back to ${parent.name}` : 'Back to Knowledge Base'}
          </button>
          {can('/archiver/knowledge-base', 'can_add') && (
            <button className="btn btn-sm" onClick={() => setShowNewChild(true)}>Add Card Inside</button>
          )}
          {can('/archiver/knowledge-base', 'can_add') && (
            <button className="btn btn-sm btn-primary" onClick={() => setShowUpload(true)}>Upload File</button>
          )}
          {can('/archiver/knowledge-base', 'can_edit') && (
            <button className="btn btn-sm" onClick={() => setShowRename(true)}>Edit</button>
          )}
          {can('/archiver/knowledge-base', 'can_delete') && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={removeTopic}>Delete Card</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{topic.name}</h1>
          <span className="estimate-no">{topic.section_name}</span>
        </div>
        {/* Where this card actually sits. Nesting is unbounded, so without a trail a card three
            levels down is indistinguishable from one on the front page. */}
        {ancestors.length > 0 && (
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            {topic.section_name}
            {ancestors.map((a) => (
              <span key={a.id}>
                {' / '}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => navigate(`/archiver/knowledge-base/${a.id}`)}
                >
                  {a.name}
                </button>
              </span>
            ))}
            {' / '}{topic.name}
          </div>
        )}
        {topic.description && (
          <div style={{ marginTop: 10, opacity: 0.9 }}>{topic.description}</div>
        )}
      </div>

      {/* Cards before files: a card that holds other cards is a folder, and what somebody wants
          from a folder is usually the next folder down. Hidden entirely when there are none, so a
          plain card looks exactly as it did before. */}
      {children.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="page-header" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Cards inside ({children.length})</h2>
          </div>
          {/* Same auto-fill grid as the front page, so a nested card looks like a card. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {children.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate(`/archiver/knowledge-base/${c.id}`)}
                style={{
                  textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 10,
                  border: '1px solid var(--border, #e2e8f0)', background: 'transparent', color: 'inherit',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
                {c.description && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{c.description}</div>}
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {Number(c.child_count) > 0
                    ? `${c.child_count} card${Number(c.child_count) === 1 ? '' : 's'}`
                    : Number(c.file_count) === 0
                      ? 'Empty'
                      : `${c.file_count} file${Number(c.file_count) === 1 ? '' : 's'}`}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Files ({files.length})</h2>
        </div>

        <div className="table-wrap">
          <table className="responsive-cards">
            <thead>
              <tr><th>File</th><th>Type</th><th>Size</th><th>Note</th><th>Uploaded</th><th>By</th><th /></tr>
            </thead>
            <tbody>
              {files.length === 0 && (
                <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  Nothing here yet. Upload the manual, spec sheet or photos that belong to this card.
                </td></tr>
              )}
              {files.map((f) => (
                <tr key={f.id}>
                  <td data-label="File">
                    <strong>{f.title || f.file_name}</strong>
                    {f.title && <div className="muted" style={{ fontSize: 11 }}>{f.file_name}</div>}
                    {f.upload_status !== 'complete' && (
                      <div style={{ color: '#b45309', fontSize: 11 }}>upload {f.upload_status}</div>
                    )}
                  </td>
                  <td data-label="Type">{fileKind(f.mime_type)}</td>
                  <td data-label="Size">{formatBytes(f.size_bytes)}</td>
                  <td data-label="Note">{f.note || '—'}</td>
                  <td data-label="Uploaded">{formatDateTime(f.created_at)}</td>
                  <td data-label="By">{f.uploaded_by_name || '—'}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    {f.upload_status === 'complete' && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => download(f)}>Download</button>
                    )}
                    {can('/archiver/knowledge-base', 'can_delete') && (
                      <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => removeFile(f)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showUpload && <UploadModal topic={topic} onClose={() => setShowUpload(false)} onSaved={() => { setShowUpload(false); load(); }} />}
      {showRename && <RenameModal topic={topic} onClose={() => setShowRename(false)} onSaved={() => { setShowRename(false); load(); }} />}
      {/* Reloads this card rather than navigating into the new one: you usually add several cards
          in a row, and being thrown a level deeper after each is the wrong end of that. */}
      {showNewChild && (
        <NewChildModal
          parent={topic}
          onClose={() => setShowNewChild(false)}
          onSaved={() => { setShowNewChild(false); load(); }}
        />
      )}
    </div>
  );
}
