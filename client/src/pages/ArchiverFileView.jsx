import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { FILE_STATUS_LABELS, FILE_ACTION_LABELS, formatBytes, formatDate, formatDateTime, fileKind } from '../utils/archiverLabels';
import { readFileAsBase64 } from '../utils/archiverUpload';

// Adding a new copy of the document. Never replaces the previous bytes -- the point of archiving a
// signed contract is being able to show what it said before it was amended.
function NewVersionModal({ file, meta, onClose, onSaved }) {
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!picked) { setError('Choose a file.'); return; }
    setError(''); setSaving(true);
    try {
      const payload = await readFileAsBase64(picked, meta.max_bytes);
      await api.post(`/archiver/files/${file.id}/versions`, { ...payload, note });
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Upload failed.');
      setSaving(false);
    }
  }

  return (
    <Modal title={`New version — ${file.title}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        This becomes version {file.current_version + 1}. Version {file.current_version} stays downloadable.
      </p>
      <div className="field">
        <label>File *</label>
        <input type="file" onChange={(e) => setPicked(e.target.files?.[0] || null)} />
        {picked && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{picked.name} · {formatBytes(picked.size)}</div>}
      </div>
      <div className="field">
        <label>What changed?</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Renewed for 2027, countersigned copy..." />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !picked} onClick={save}>
          {saving ? 'Uploading...' : 'Upload Version'}
        </button>
      </div>
    </Modal>
  );
}

function ShareModal({ file, meta, onClose, onSaved }) {
  const [userId, setUserId] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const already = new Set([String(file.owner_user_id), ...(file.shares || []).map((s) => String(s.user_id))]);
  const available = (meta?.users || []).filter((u) => !already.has(String(u.id)));

  async function save() {
    if (!userId) { setError('Choose someone to share with.'); return; }
    setError(''); setSaving(true);
    try { await api.post(`/archiver/files/${file.id}/shares`, { user_id: userId, can_edit: canEdit }); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Could not share.'); setSaving(false); }
  }

  return (
    <Modal title={`Share — ${file.title}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>User *</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">--Select--</option>
          {available.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={canEdit} onChange={(e) => setCanEdit(e.target.checked)} />
          Can edit and add versions
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Sharing...' : 'Share'}</button>
      </div>
    </Modal>
  );
}

export default function ArchiverFileView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [file, setFile] = useState(null);
  const [meta, setMeta] = useState(null);
  const [logs, setLogs] = useState([]);
  const [tab, setTab] = useState('details');
  const [showVersion, setShowVersion] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.get(`/archiver/files/${id}`).then(({ data }) => { setFile(data); setLoading(false); }), [id]);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);
  useEffect(() => { api.get('/archiver/files/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);
  const loadLogs = useCallback(() => api.get(`/archiver/files/${id}/logs`).then(({ data }) => setLogs(data)), [id]);
  useEffect(() => { if (tab === 'log') loadLogs(); }, [tab, loadLogs]);

  // Downloads stream bytes, not JSON, so this fetches as a blob and hands it to the browser.
  // Authorization has to be attached explicitly -- a plain link would carry no bearer token.
  async function download(version) {
    setBusy(true); setError('');
    try {
      const res = await api.get(`/archiver/files/${id}/versions/${version.id}/download`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = version.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Released on the next tick: revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (tab === 'log') loadLogs();
    } catch (e) { setError(e.response?.data?.error || 'Download failed.'); }
    finally { setBusy(false); }
  }

  async function removeShare(userId, name) {
    if (!confirm(`Remove ${name}'s access to this document?`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/archiver/files/${id}/shares/${userId}`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not remove access.'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm('Delete this document and every version of it? This cannot be undone.')) return;
    setBusy(true); setError('');
    try { await api.delete(`/archiver/files/${id}`); navigate('/archiver/files'); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed.'); setBusy(false); }
  }

  if (loading || !file) return <LoadingSpinner />;
  const mine = file.my_access || {};
  const versions = file.versions || [];
  const current = versions.find((v) => v.version_no === file.current_version) || versions[0];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/archiver/files')}>Back to Lists</button>
          {current && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => download(current)}>Download</button>}
          {mine.can_edit && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/archiver/files/${id}/edit`)}>Edit</button>}
          {mine.can_edit && meta && <button className="btn btn-sm" onClick={() => setShowVersion(true)}>New Version</button>}
          {mine.can_edit && meta && <button className="btn btn-sm" onClick={() => setShowShare(true)}>Share</button>}
          {can('/archiver/files', 'can_delete') && (mine.via === 'owner' || mine.via === 'system_admin') && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={remove}>Delete</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{file.title}</h1>
          <span className="estimate-no">{file.file_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{FILE_STATUS_LABELS[file.status] || file.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Folder : <span className="hi">{file.folder_name || '—'}</span></div>
            <div>Reference : <span className="hi">{file.reference_no || '—'}</span></div>
            <div>Document date : <span className="hi">{formatDate(file.document_date)}</span></div>
          </div>
          <div>
            <div>File : <span className="hi">{current ? `${current.file_name}` : '—'}</span></div>
            <div>Type / size : <span className="hi">{current ? `${fileKind(current.mime_type)} · ${formatBytes(current.size_bytes)}` : '—'}</span></div>
            <div>Version : <span className="hi">v{file.current_version} of {versions.length}</span></div>
          </div>
          <div>
            <div>Owner : <span className="hi">{file.owner_name || '—'}</span></div>
            <div>Visibility : <span className="hi">{file.visibility === 'company' ? 'Company-wide' : 'Shared with named people'}</span></div>
            <div>Expires : <span className="hi">{formatDate(file.expires_on)}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>Details</button>
        <button className={`status-tab ${tab === 'versions' ? 'active' : ''}`} onClick={() => setTab('versions')}>Versions ({versions.length})</button>
        <button className={`status-tab ${tab === 'shares' ? 'active' : ''}`} onClick={() => setTab('shares')}>Access</button>
        <button className={`status-tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>Activity</button>
      </div>

      {/* The job order block only appears on an artist archive. These figures are the snapshot
          taken when the work was filed, NOT a live read of the job order -- which is the point,
          since the job order may since have been revised. */}
      {tab === 'details' && file.source_kind && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="page-header" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Job order</h2>
            <span className="muted" style={{ fontSize: 12 }}>as recorded when these files were archived</span>
          </div>
          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>{file.source_kind === 'NSTDJO' ? 'NSTDJO' : 'JO'} # : <span className="hi">{file.jo_no || '—'}</span></div>
            <div>Date : <span className="hi">{formatDate(file.jo_date)}</span></div>
            <div>Customer : <span className="hi">{file.customer_name || '—'}</span></div>
            <div>Sales Rep. : <span className="hi">{file.sales_rep_name || '—'}</span></div>
            <div>Artist : <span className="hi">{file.artist_name || '—'}</span></div>
            <div>Layout - Job Type : <span className="hi">{file.layout_job_type || '—'}</span></div>
          </div>
          <div style={{ marginTop: 8 }}>
            Job Desc. : <span className="hi">{file.job_description || '—'}</span>
          </div>
        </div>
      )}

      {tab === 'details' && (
        <div className="card">
          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div>
              <div>Department : <span className="hi">{file.department_name || '—'}</span></div>
              <div>Uploaded by : <span className="hi">{file.created_by_name || '—'}, {formatDateTime(file.created_at)}</span></div>
            </div>
            <div>
              <div>Last edited : <span className="hi">{file.updated_by_name ? `${file.updated_by_name}, ${formatDateTime(file.updated_at)}` : '—'}</span></div>
              <div>Checksum : <span className="hi" style={{ fontFamily: 'monospace', fontSize: 11 }}>{current?.checksum_sha256?.slice(0, 16) || '—'}…</span></div>
            </div>
          </div>
          {file.description && (
            <>
              <h3 style={{ margin: '18px 0 6px', fontSize: 14, color: '#334155' }}>Description</h3>
              <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{file.description}</p>
            </>
          )}
        </div>
      )}

      {tab === 'versions' && (
        <div className="card">
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Version</th><th>File</th><th>Type</th><th>Size</th><th>Uploaded</th><th>By</th><th>Note</th><th /></tr></thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} style={{ fontWeight: v.version_no === file.current_version ? 600 : undefined }}>
                    <td data-label="Version">v{v.version_no}{v.version_no === file.current_version ? ' · current' : ''}</td>
                    <td data-label="File" style={{ fontSize: 12 }}>{v.file_name}</td>
                    <td data-label="Type">{fileKind(v.mime_type)}</td>
                    <td data-label="Size">{formatBytes(v.size_bytes)}</td>
                    <td data-label="Uploaded">{formatDateTime(v.created_at)}</td>
                    <td data-label="By">{v.uploaded_by_name || '—'}</td>
                    <td data-label="Note">{v.note || '—'}</td>
                    <td><button className="btn btn-sm" disabled={busy} onClick={() => download(v)}>Download</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            Older versions are kept deliberately — replacing a document would destroy the record of what it used to say.
          </p>
        </div>
      )}

      {tab === 'shares' && (
        <div className="card">
          {file.visibility === 'company' && (
            <p className="muted" style={{ marginTop: 0 }}>
              This document is <strong>company-wide</strong>: anyone with the Files page can read it. The list below
              is who has extra rights on top of that.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Access</th><th>Can edit</th><th>Granted by</th><th /></tr></thead>
              <tbody>
                <tr><td><strong>{file.owner_name || '—'}</strong></td><td>Owner</td><td>Yes</td><td>—</td><td /></tr>
                {(file.shares || []).map((s) => (
                  <tr key={s.user_id}>
                    <td>{s.display_name}</td>
                    <td>Shared</td>
                    <td>{s.can_edit ? 'Yes' : <span className="muted">No</span>}</td>
                    <td>{s.granted_by_name || '—'}</td>
                    <td>
                      {mine.can_edit && (
                        <button className="btn btn-sm btn-warning" disabled={busy}
                          onClick={() => removeShare(s.user_id, s.display_name)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div className="card">
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
              <tbody>
                {logs.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No activity yet.</td></tr>}
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td data-label="When">{formatDateTime(l.created_at)}</td>
                    <td data-label="Who">{l.user_name || '—'}</td>
                    <td data-label="Action">{FILE_ACTION_LABELS[l.action] || l.action}</td>
                    <td data-label="Detail">{l.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showVersion && meta && <NewVersionModal file={file} meta={meta} onClose={() => setShowVersion(false)} onSaved={() => { setShowVersion(false); load(); }} />}
      {showShare && meta && <ShareModal file={file} meta={meta} onClose={() => setShowShare(false)} onSaved={() => { setShowShare(false); load(); }} />}
    </div>
  );
}
