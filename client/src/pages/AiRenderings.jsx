import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import EntityPicker from '../components/EntityPicker';
import Modal from '../components/Modal';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';

const ROUTE = '/ai-renderings';
const PAGE_SIZE = 12;
const QUALITY_OPTIONS = [
  { value: 'draft', label: 'Draft (fast, cheapest)' },
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High (slowest, best detail)' },
];
const SIZE_OPTIONS = [
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'square', label: 'Square' },
];
const EXAMPLE = 'Put a lighted circular signage with the logo above the main entrance, about 1.2m across, white acrylic face with LED backlight, shown at night.';
// Phone photos are often 4000px+ and several MB. The model works at ~1.5K anyway, so the site photo
// is scaled down before upload: a quicker upload and a smaller row to replicate.
const MAX_SIDE = 2048;

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

async function shrinkPhoto(file) {
  const dataUrl = await readFile(file);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That file is not a picture this browser can open.'));
    i.src = dataUrl;
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && file.size < 4 * 1024 * 1024) return { dataUrl, mime: file.type };
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), mime: 'image/jpeg' };
}

// Images are behind auth, so they are fetched as blobs and shown from object URLs.
function useImage(path) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!path) return undefined;
    let objectUrl = '';
    let cancelled = false;
    api.get(path, { responseType: 'blob' })
      .then(({ data }) => { if (!cancelled) { objectUrl = URL.createObjectURL(data); setUrl(objectUrl); } })
      .catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return url;
}

function Thumb({ id, onOpen, row }) {
  const url = useImage(`${ROUTE}/${id}/image/result`);
  return (
    <button type="button" onClick={onOpen} className="card"
      style={{ padding: 0, overflow: 'hidden', textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border, #e2e8f0)' }}>
      <div style={{ aspectRatio: '3 / 2', background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {url ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#64748b', fontSize: 12 }}>Loading…</span>}
      </div>
      <div style={{ padding: '8px 10px', fontSize: 12, lineHeight: 1.45 }}>
        <div style={{ fontWeight: 600 }}>{row.customer_name || 'No customer'}{row.estimate_no ? ` · ${row.estimate_no}` : ''}</div>
        <div style={{ color: 'var(--text-muted, #64748b)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{row.prompt}</div>
        <div style={{ color: 'var(--text-muted, #64748b)', marginTop: 2 }}>{row.created_by_name} · {displayDate(String(row.created_at).slice(0, 10))}</div>
      </div>
    </button>
  );
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

function RenderingModal({ row, onClose, onCreated, onDeleted, canAdd, canDelete, busy, setBusy }) {
  const result = useImage(`${ROUTE}/${row.id}/image/result`);
  const site = useImage(`${ROUTE}/${row.id}/image/site`);
  const [prompt, setPrompt] = useState(row.prompt);
  const [quality, setQuality] = useState(row.quality);
  const [size, setSize] = useState(row.size);
  const [error, setError] = useState('');

  const variation = async () => {
    setError(''); setBusy(true);
    try {
      const { data } = await api.post(`${ROUTE}/${row.id}/variation`, { prompt, quality, size }, { timeout: 300000 });
      onCreated(data);
    } catch (e) {
      setError(e.response?.data?.error || 'The rendering failed. Try again.');
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this rendering? A copy already filed on the estimate stays there.')) return;
    try { await api.delete(`${ROUTE}/${row.id}`); onDeleted(row.id); } catch (e) { setError(e.response?.data?.error || 'Could not delete it.'); }
  };

  return (
    <Modal title={`AI Rendering #${row.id}`} onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 16 }}>
        <div>
          {result ? <img src={result} alt="Rendering" style={{ width: '100%', borderRadius: 6 }} /> : <LoadingSpinner />}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" disabled={!result} onClick={() => download(result, `AI-Rendering-${row.id}.jpg`)}>Download</button>
            {canDelete && <button className="btn btn-sm btn-danger" onClick={remove}>Delete</button>}
          </div>
        </div>
        <div style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 6 }}><strong>Customer:</strong> {row.customer_name || '—'}</div>
          <div style={{ marginBottom: 6 }}><strong>Estimate:</strong> {row.estimate_no || '—'}{row.estimate_attachment_id ? ' (filed in its attachments)' : ''}</div>
          <div style={{ marginBottom: 6 }}><strong>By:</strong> {row.created_by_name}, {displayDate(String(row.created_at).slice(0, 10))}</div>
          <div style={{ marginBottom: 10 }}><strong>Model:</strong> {row.model}, {row.quality}{row.source_rendering_id ? ` · variation of #${row.source_rendering_id}` : ''}</div>
          <div style={{ marginBottom: 4 }}><strong>Original photo</strong></div>
          {site ? <img src={site} alt="Site" style={{ width: '100%', borderRadius: 6, marginBottom: 10 }} /> : null}
          {canAdd && (
            <>
              <div className="field">
                <label>Make a variation (same photo{row.has_logo ? ' and logo' : ''})</label>
                <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={quality} onChange={(e) => setQuality(e.target.value)}>{QUALITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                <select value={size} onChange={(e) => setSize(e.target.value)}>{SIZE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              </div>
              <button className="btn btn-primary" style={{ marginTop: 8 }} disabled={busy} onClick={variation}>
                {busy ? 'Rendering… (20–90 seconds)' : 'Make variation'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Design > AI Rendering: upload a photo of the client's site (and their logo), describe the
// signage, and OpenAI paints it into the photo. See server/src/routes/aiRenderings.js.
export default function AiRenderings() {
  const { can } = useAuth();
  const canAdd = can(ROUTE, 'can_add');
  const canDelete = can(ROUTE, 'can_delete');

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [allowance, setAllowance] = useState(null);
  const [page, setPage] = useState(1);
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);

  const [customers, setCustomers] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [estimates, setEstimates] = useState([]);
  const [estimateId, setEstimateId] = useState('');
  const [site, setSite] = useState(null);
  const [logo, setLogo] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState('standard');
  const [size, setSize] = useState('landscape');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get(ROUTE, { params: { page, limit: PAGE_SIZE, mine: mine ? 1 : undefined, search: search.trim() || undefined } })
      .then(({ data }) => { setRows(data.rows); setTotal(Number(data.total) || 0); setAllowance(data.allowance); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the renderings.'))
      .finally(() => setLoading(false));
  }, [page, mine, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const searchCustomers = useCallback((q) => {
    api.get(`${ROUTE}/customers`, { params: { search: q || undefined } }).then(({ data }) => setCustomers(data)).catch(() => {});
  }, []);
  useEffect(() => { searchCustomers(''); }, [searchCustomers]);
  // Keep the chosen customer in the list, so the picker still shows it after a new search.
  const customerItems = useMemo(
    () => (customer && !customers.some((c) => c.id === customer.id) ? [customer, ...customers] : customers),
    [customer, customers],
  );

  useEffect(() => {
    setEstimateId(''); setEstimates([]);
    if (!customer) return;
    api.get(`${ROUTE}/estimates`, { params: { customer_id: customer.id } }).then(({ data }) => setEstimates(data)).catch(() => {});
  }, [customer]);

  const pick = async (e, setter, shrink) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { setError('Use a PNG, JPG or WEBP picture.'); return; }
    if (file.size > 10 * 1024 * 1024 && !shrink) { setError('The logo must be 10MB or smaller.'); return; }
    try {
      setter(shrink ? await shrinkPhoto(file) : { dataUrl: await readFile(file), mime: file.type });
    } catch (err) { setError(err.message); }
  };

  const created = (data) => {
    setAllowance(data.allowance);
    setOpen(data.rendering);
    if (page === 1) load(); else setPage(1);
  };

  const generate = async () => {
    setError('');
    if (!customer) { setError('Choose the customer this rendering is for.'); return; }
    if (!site) { setError('Attach a photo of the site.'); return; }
    if (prompt.trim().length < 5) { setError('Describe what to render.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post(ROUTE, {
        customer_id: customer.id, estimate_id: estimateId || null, prompt, quality, size,
        site_image: site.dataUrl, site_mime: site.mime, logo_image: logo?.dataUrl || null, logo_mime: logo?.mime || null,
      }, { timeout: 300000 });
      created(data);
    } catch (e) {
      setError(e.response?.data?.error || (e.code === 'ECONNABORTED' ? 'The rendering took too long. Try Draft quality.' : 'The rendering failed. Try again.'));
    } finally { setBusy(false); }
  };

  const left = allowance && allowance.limit != null ? allowance.remaining : null;

  return (
    <div>
      <div className="page-header">
        <h1>AI Rendering</h1>
        {allowance && (
          <span style={{ fontSize: 13, color: 'var(--text-muted, #64748b)' }}>
            {left == null ? `${allowance.used} made today (no daily limit)` : `${left} of ${allowance.limit} renderings left today`}
          </span>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}

      {canAdd && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
            <div>
              <div className="field">
                <label>Customer *</label>
                <EntityPicker label="Customer" items={customerItems} value={customer?.id || ''} getLabel={(c) => c?.name}
                  columns={[{ key: 'name', label: 'Name' }, { key: 'customer_code', label: 'Code' }]} searchKeys={['name', 'customer_code']}
                  placeholder="--Select--" onSelect={setCustomer} onSearch={searchCustomers} />
              </div>
              <div className="field">
                <label>Estimate (optional — the rendering is also filed in its attachments)</label>
                <select value={estimateId} onChange={(e) => setEstimateId(e.target.value)} disabled={!customer}>
                  <option value="">{customer ? '-- None --' : 'Choose a customer first'}</option>
                  {estimates.map((e) => <option key={e.id} value={e.id}>{e.estimate_no}{e.contract_description ? ` — ${String(e.contract_description).slice(0, 60)}` : ''}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>Quality</label>
                  <select value={quality} onChange={(e) => setQuality(e.target.value)}>{QUALITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>Orientation</label>
                  <select value={size} onChange={(e) => setSize(e.target.value)}>{SIZE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[['Site photo *', site, setSite, true], ['Logo (optional)', logo, setLogo, false]].map(([label, value, setter, shrink]) => (
                <div className="field" key={label}>
                  <label>{label}</label>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 150, border: '2px dashed var(--border, #cbd5e1)', borderRadius: 8, cursor: 'pointer', overflow: 'hidden', background: 'var(--bg-subtle, #f8fafc)' }}>
                    {value ? <img src={value.dataUrl} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 12, color: '#64748b' }}>Click to choose a picture</span>}
                    <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => pick(e, setter, shrink)} />
                  </label>
                  {value && <button type="button" className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => setter(null)}>Remove</button>}
                </div>
              ))}
            </div>
          </div>
          <div className="field">
            <label>What should be rendered? *</label>
            <textarea rows={3} value={prompt} placeholder={EXAMPLE} onChange={(e) => setPrompt(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={generate} disabled={busy || left === 0}>
            {busy ? 'Rendering… (20–90 seconds)' : 'Generate rendering'}
          </button>
          {left === 0 && <span style={{ marginLeft: 10, fontSize: 13, color: '#b45309' }}>Today&rsquo;s allowance is used up.</span>}
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input placeholder="Search request, customer or estimate…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} style={{ maxWidth: 320 }} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} /> Only mine
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-muted, #64748b)' }}>{total} rendering(s)</span>
        </div>
        {loading && !rows.length ? <LoadingSpinner /> : rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>No renderings yet.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {rows.map((r) => <Thumb key={r.id} id={r.id} row={r} onOpen={() => setOpen(r)} />)}
          </div>
        )}
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onChange={setPage} />
      </div>

      {open && (
        <RenderingModal key={open.id} row={open} onClose={() => setOpen(null)} onCreated={created}
          onDeleted={() => { setOpen(null); load(); }} canAdd={canAdd} canDelete={canDelete} busy={busy} setBusy={setBusy} />
      )}
    </div>
  );
}
