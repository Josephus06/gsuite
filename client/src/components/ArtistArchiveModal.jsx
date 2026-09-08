import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';
import { formatBytes, formatDate } from '../utils/archiverLabels';
import { readFileAsBase64 } from '../utils/archiverUpload';
import { uploadInParts, abortUpload } from '../utils/largeUpload';

// An artist files the working files for a job order they were assigned.
//
// Two steps rather than one form: pick the job order, then confirm what will be recorded against
// it. The details are read-only on purpose -- they are snapshotted from the job order server-side,
// and letting anyone type over them would make the archive say something the job order never did.
export default function ArtistArchiveModal({ onClose, onSaved, maxBytes }) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [reason, setReason] = useState('');
  const [chosen, setChosen] = useState(null);
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);
  const [abort, setAbort] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/archiver/files/my-job-orders', { params: search ? { search } : {} });
      setRows(data.rows || []);
      setIsAdmin(!!data.is_admin);
      setReason(data.reason || '');
    } catch (e) { setError(e.response?.data?.error || 'Could not load your job orders.'); }
    setLoading(false);
  }, [search]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Two paths, chosen by size.
  //
  // Small enough for the in-database route: one request, and the file stays in the database where
  // the office box can reach it with the internet down.
  //
  // Anything larger goes straight to object storage in parts. It has to: a MySQL LONGBLOB caps at
  // 4 GB, and layout archives for large-format work run to tens of gigabytes.
  async function save() {
    if (!chosen) { setError('Choose a job order.'); return; }
    if (!picked) { setError('Choose the .zip to upload.'); return; }
    if (!/\.zip$/i.test(picked.name)) { setError('The file must be a .zip.'); return; }
    setError(''); setSaving(true);

    if (picked.size <= maxBytes) {
      try {
        const payload = await readFileAsBase64(picked, maxBytes);
        const { data } = await api.post('/archiver/files/artist', {
          source_kind: chosen.source_kind, source_id: chosen.source_id, note, ...payload,
        });
        onSaved(data);
      } catch (e) {
        setError(e.response?.data?.error || e.message || 'Upload failed.');
        setSaving(false);
      }
      return;
    }

    const controller = new AbortController();
    setAbort(() => () => controller.abort());
    let versionId = null;
    try {
      const { data: init } = await api.post('/archiver/files/artist/init', {
        source_kind: chosen.source_kind, source_id: chosen.source_id, note,
        file_name: picked.name, size_bytes: picked.size,
      });
      versionId = init.version_id;
      setProgress({ sent: 0, total: picked.size, part: 0, partCount: init.part_count });

      await uploadInParts({
        api, file: picked, versionId,
        partSize: init.part_size, partCount: init.part_count,
        onProgress: setProgress, signal: controller.signal,
      });
      onSaved({ id: init.file_id, file_no: init.file_no, jo_no: init.jo_no });
    } catch (e) {
      // Always clean up at the storage end. Parts already sent sit in the bucket otherwise --
      // invisible, and still billed.
      if (versionId) await abortUpload(api, versionId);
      setError(e.response?.data?.error || e.message || 'Upload failed.');
      setSaving(false);
      setProgress(null);
      setAbort(null);
    }
  }

  const detail = (label, value) => (
    <div>
      {label} : <span className="hi">{value || <span className="muted">—</span>}</span>
    </div>
  );

  return (
    <Modal title="Archive layout files as artist" onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}

      {!chosen && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {isAdmin
              ? 'Showing every job order that has an artist assigned.'
              : 'Showing the job orders and NSTDJOs assigned to you.'}
            {' '}Pick the one these files belong to.
          </p>
          {reason && <div className="error-banner">{reason}</div>}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input style={{ flex: 1 }} value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="JO number, customer or description..." />
            <button type="button" className="btn btn-primary" onClick={load}>Search</button>
          </div>

          {loading ? <LoadingSpinner /> : (
            <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr><th>JO / NSTDJO #</th><th>Date</th><th>Customer</th><th>Layout - Job Type</th><th>Job Desc.</th><th>Archived</th></tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                      No job orders found. Try a different search.
                    </td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={`${r.source_kind}-${r.source_id}`} onClick={() => { setChosen(r); setError(''); }} style={{ cursor: 'pointer' }}>
                      <td>
                        <strong>{r.jo_no}</strong>
                        <div className="muted" style={{ fontSize: 11 }}>{r.source_kind}</div>
                      </td>
                      <td>{formatDate(r.jo_date)}</td>
                      <td>{r.customer_name || '—'}</td>
                      <td>{r.layout_job_type || '—'}</td>
                      <td style={{ maxWidth: 260, fontSize: 12 }}>{r.job_description || '—'}</td>
                      <td>{Number(r.archived_count) > 0 ? `${r.archived_count} file(s)` : <span className="muted">none</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}

      {chosen && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="page-header" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>What will be recorded</h2>
              <button type="button" className="btn btn-sm" onClick={() => setChosen(null)}>Change job order</button>
            </div>
            <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              {detail(`${chosen.source_kind === 'NSTDJO' ? 'NSTDJO' : 'JO'} #`, chosen.jo_no)}
              {detail('Date', formatDate(chosen.jo_date))}
              {detail('Customer', chosen.customer_name)}
              {detail('Sales Rep.', chosen.sales_rep_name)}
              {detail('Artist', chosen.artist_name)}
              {detail('Layout - Job Type', chosen.layout_job_type)}
            </div>
            <div style={{ marginTop: 8 }}>
              Job Desc. : <span className="hi">{chosen.job_description || <span className="muted">—</span>}</span>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              These are copied onto the archive as they stand today, so the record still reads correctly years
              from now even if the job order is revised or people move on.
            </p>
          </div>

          <div className="field">
            <label>Layout files (.zip) *</label>
            <input type="file" accept=".zip,application/zip" onChange={(e) => { setPicked(e.target.files?.[0] || null); setError(''); }} />
            {picked && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{picked.name} · {formatBytes(picked.size)}</div>}
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              One .zip holding the layout, its links and its fonts.
              {picked && picked.size > maxBytes
                ? ` This one is ${formatBytes(picked.size)}, so it goes straight to archive storage in parts rather than into the database.`
                : ` Files over ${formatBytes(maxBytes)} are uploaded straight to archive storage.`}
            </div>
          </div>
          <div className="field">
            <label>Note</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Final approved layout, revision 2..." />
          </div>

          {/* A 150GB upload runs for hours. Without a live figure the dialog is indistinguishable
              from a hung one, and somebody will close the tab and lose the whole transfer. */}
          {progress && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                <strong>
                  {formatBytes(progress.sent)} of {formatBytes(progress.total)}
                  {' '}({Math.floor((progress.sent / progress.total) * 100)}%)
                </strong>
                <span className="muted">part {progress.part} of {progress.partCount}</span>
              </div>
              <div className="loading-spinner-bar" style={{ width: '100%' }}>
                <span style={{ width: `${(progress.sent / progress.total) * 100}%` }} />
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                Uploading straight to storage. Keep this tab open — closing it stops the transfer.
                A failed part is retried on its own, so a brief drop-out will not restart the whole file.
              </p>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => { if (abort) abort(); onClose(); }}>
              {saving ? 'Cancel upload' : 'Cancel'}
            </button>
            <button type="button" className="btn btn-primary" disabled={saving || !picked} onClick={save}>
              {saving ? (progress ? `Uploading ${Math.floor((progress.sent / progress.total) * 100)}%` : 'Starting...') : 'Archive Files'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
