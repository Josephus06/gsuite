import { useRef, useState } from 'react';
import api from '../../api/client';
import useFlipbookImage, { MAX_PAGE_BYTES, forgetPageImage } from './flipbookImages';

function Thumb({ page }) {
  const url = useFlipbookImage(page.id);
  return url
    ? <img src={url} alt="" className="pf-manage-thumb" />
    : <span className="pf-manage-thumb is-empty" aria-hidden="true" />;
}

// Managing the artwork: upload the exported pages, put them in reading order, drop the ones
// that are wrong. Only rendered when the API says can_manage, so nobody is shown controls
// that will 403.
export default function FlipbookManager({ pages, onChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef(null);

  async function upload(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    setError('');
    // Sorted by name so page-01..page-24 lands in reading order -- a multi-select hands them
    // over in whatever order the file dialog felt like.
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      setBusy(`Uploading ${i + 1} of ${list.length}…`);
      if (!(file.type || '').startsWith('image/')) {
        setError(`${file.name} is not an image — flipbook pages must be PNG, JPG, WEBP or GIF.`);
        break;
      }
      if (file.size > MAX_PAGE_BYTES) {
        setError(`${file.name} is ${(file.size / 1048576).toFixed(1)}MB — pages must be ${MAX_PAGE_BYTES / 1048576}MB or smaller.`);
        break;
      }
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read that file.'));
          reader.readAsDataURL(file);
        });
        // Sequential rather than Promise.all: twenty-four 8MB pages fired at once is ~200MB
        // of request bodies in flight, and the progress line would be meaningless.
        await api.post('/product-flipbook', { data, mime_type: file.type, file_name: file.name });
      } catch (err) {
        setError(err.response?.data?.error
          || (err.response?.status === 413 ? `${file.name} is too large to upload.` : `Could not upload ${file.name}.`));
        break;
      }
    }
    setBusy('');
    if (fileInput.current) fileInput.current.value = '';
    await onChange();
  }

  // Reordering sends the whole list, so what the server stores is exactly what is on screen.
  async function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= pages.length) return;
    const ids = pages.map((p) => p.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusy('Saving order…');
    try {
      await api.put('/product-flipbook/order', { ids });
      await onChange();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the new order.');
    } finally { setBusy(''); }
  }

  async function remove(page) {
    if (!window.confirm(`Delete page ${page.position} permanently? The image is removed from the database.`)) return;
    setBusy('Deleting…');
    try {
      await api.delete(`/product-flipbook/${page.id}`);
      forgetPageImage(page.id);
      await onChange();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete that page.');
    } finally { setBusy(''); }
  }

  return (
    <div className={`pf-manage${open ? ' is-open' : ''}`}>
      <button type="button" className="btn btn-sm pf-manage-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? 'Close artwork manager' : `Manage artwork${pages.length ? ` (${pages.length} pages)` : ''}`}
      </button>

      {open && (
        <div className="pf-manage-body">
          <div className="pf-manage-head">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={!!busy}
              onChange={(e) => upload(e.target.files)}
            />
            <span className="muted">
              {pages.length
                ? 'Uploaded pages replace the built-in profile. Delete them all to bring it back.'
                : 'Showing the built-in 2025 profile. Upload page images to use the real brochure instead.'}
            </span>
          </div>

          {busy && <div className="pf-manage-busy">{busy}</div>}
          {error && <div className="pf-manage-error">{error}</div>}

          <div className="pf-manage-list">
            {pages.map((p, i) => (
              <div className="pf-manage-item" key={p.id}>
                <Thumb page={p} />
                <div className="pf-manage-meta">
                  <div className="pf-manage-name">{p.position}. {p.file_name || 'page'}</div>
                  <div className="muted">{(p.size_bytes / 1024).toFixed(0)} KB{p.uploaded_by_name ? ` · ${p.uploaded_by_name}` : ''}</div>
                </div>
                <div className="pf-manage-actions">
                  <button type="button" className="btn btn-sm" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} aria-label="Move earlier">↑</button>
                  <button type="button" className="btn btn-sm" disabled={i === pages.length - 1 || !!busy} onClick={() => move(i, 1)} aria-label="Move later">↓</button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => remove(p)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
