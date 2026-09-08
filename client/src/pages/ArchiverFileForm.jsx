import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { FILE_STATUS_LABELS, formatBytes } from '../utils/archiverLabels';
import { readFileAsBase64 } from '../utils/archiverUpload';

const EMPTY = {
  title: '', folder_id: '', description: '', reference_no: '', document_date: '', expires_on: '',
  owner_user_id: '', department_id: '', visibility: 'shared', status: 'active',
};

// Upload a document, or edit one's details.
//
// Editing never touches the bytes: a replacement copy is a new VERSION, added from the document's
// own page. Letting an edit swap the file would quietly destroy the record being archived.
export default function ArchiverFileForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [picked, setPicked] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data: m } = await api.get('/archiver/files/meta');
      setMeta(m);
      if (id) {
        const { data: f } = await api.get(`/archiver/files/${id}`);
        if (!f.my_access?.can_edit) { navigate(`/archiver/files/${id}`, { replace: true }); return; }
        setForm({
          title: f.title || '', folder_id: f.folder_id || '', description: f.description || '',
          reference_no: f.reference_no || '',
          document_date: f.document_date ? String(f.document_date).slice(0, 10) : '',
          expires_on: f.expires_on ? String(f.expires_on).slice(0, 10) : '',
          owner_user_id: f.owner_user_id || '', department_id: f.department_id || '',
          visibility: f.visibility || 'shared', status: f.status || 'active',
        });
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setError('');
    if (!form.title.trim()) { setError('A title is required.'); return; }
    if (!id && !picked) { setError('Choose a file to upload.'); return; }
    setSaving(true);
    try {
      const body = {
        ...form,
        folder_id: form.folder_id || null,
        owner_user_id: form.owner_user_id || null,
        department_id: form.department_id || null,
        document_date: form.document_date || null,
        expires_on: form.expires_on || null,
      };
      if (id) {
        await api.put(`/archiver/files/${id}`, body);
        navigate(`/archiver/files/${id}`);
      } else {
        const payload = await readFileAsBase64(picked, meta.max_bytes);
        const { data } = await api.post('/archiver/files', { ...body, ...payload });
        navigate(`/archiver/files/${data.id}`);
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Save failed.');
      setSaving(false);
    }
  }

  if (loading || !meta) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Files</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(id ? `/archiver/files/${id}` : '/archiver/files')}>Back</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ margin: '0 0 2px', color: '#334155' }}>{id ? form.title : 'Upload Document'}</h2>
        <div className="muted" style={{ marginBottom: 16 }}>
          {id
            ? 'Editing the details. To replace the document itself, add a new version from its page.'
            : 'Contracts, permits, licences, receipts — anything the company must be able to produce later.'}
        </div>

        {!id && (
          <div className="field">
            <label>File *</label>
            <input type="file" onChange={(e) => { setPicked(e.target.files?.[0] || null); setError(''); }} />
            {picked && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{picked.name} · {formatBytes(picked.size)}</div>}
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Up to {formatBytes(meta.max_bytes)}. PDF, images, Office documents, text, CSV and ZIP.
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Title *</label>
            <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Adobe CC agreement 2026-2027" />
          </div>
          <div className="field">
            <label>Folder</label>
            <select value={form.folder_id} onChange={(e) => set({ folder_id: e.target.value })}>
              <option value="">--None--</option>
              {meta.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Reference No</label>
            <input value={form.reference_no} onChange={(e) => set({ reference_no: e.target.value })} placeholder="Contract or permit number" />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
              {Object.entries(FILE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Document Date</label>
            <input type="date" value={form.document_date} onChange={(e) => set({ document_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Expires On</label>
            <input type="date" value={form.expires_on} onChange={(e) => set({ expires_on: e.target.value })} />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Permits and licences show up in the expiring filter.</div>
          </div>
          <div className="field">
            <label>Department</label>
            <select value={form.department_id} onChange={(e) => set({ department_id: e.target.value })}>
              <option value="">--None--</option>
              {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Owner</label>
            <select value={form.owner_user_id} onChange={(e) => set({ owner_user_id: e.target.value })}>
              <option value="">--Me--</option>
              {meta.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Who can read it</label>
            <select value={form.visibility} onChange={(e) => set({ visibility: e.target.value })}>
              <option value="shared">Only people I share it with</option>
              <option value="company">Anyone with the Files page</option>
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {form.visibility === 'company'
                ? 'Every user who has the Files page will be able to read and download this.'
                : 'Only you and the people you share it with. Share from the document’s page after saving.'}
            </div>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Description</label>
            <textarea rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })}
              placeholder="What this document is, and anything someone finding it in two years would need to know." />
          </div>
        </div>
      </div>
    </div>
  );
}
