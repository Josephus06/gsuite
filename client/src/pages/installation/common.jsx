import { useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { blobErrorMessage } from '../../components/ArchivedTag';

// Shared by the Installation Planner pages (server: routes/installationPlanner.js).
export const API = '/installation-planner';
export const ROUTE = '/installation-planner';

export const STATUS_LABEL = { pending: 'Pending', ongoing: 'Ongoing', 'on-hold': 'On Hold', done: 'Done', cancelled: 'Cancelled' };
export const STATUS_BADGE = { pending: 'badge-muted', ongoing: 'badge-info', 'on-hold': 'badge-warning', done: 'badge-success', cancelled: 'badge-danger' };
// Calendar bar colours, one per status (PLANNER showed the status in the title; here it is the colour too).
export const STATUS_COLOR = { pending: '#64748b', ongoing: '#2563eb', 'on-hold': '#d97706', done: '#16a34a', cancelled: '#dc2626' };
export const BOM_LABEL = { not_ready: 'Not Ready', ready: 'Ready', done: 'Done' };

export const errorOf = (err) => err.response?.data?.error || err.message;
export const personName = (e) => (e ? [e.first_name, e.last_name].filter(Boolean).join(' ') : '');
export const vehicleLabel = (v) => {
  const name = [v.make, v.model].filter(Boolean).join(' ') || v.asset_name || v.reference_no || `Asset #${v.id}`;
  return v.plate_no ? `${name} (${v.plate_no})` : name;
};

// What the Crew & Vehicle Schedule books (2026-11-09): three kinds of employee, by Position Code, and the
// Assets > Fleet vehicles. `flag` is the employee's flag from /meta.
export const RESOURCES = {
  installer: { one: 'Installer', plural: 'Installers', flag: 'is_installer', code: 'INSTALLER' },
  subcon: { one: 'Subcon', plural: 'Subcons', flag: 'is_subcon', code: 'SUBCON' },
  driver: { one: 'Driver', plural: 'Drivers', flag: 'is_driver', code: 'DRIVER' },
  vehicle: { one: 'Vehicle', plural: 'Vehicles' },
};
for (const [k, r] of Object.entries(RESOURCES)) {
  r.key = k;
  r.none = k === 'vehicle'
    ? 'No vehicles yet -- add them in Assets > Fleet.'
    : `No ${r.plural.toLowerCase()} yet -- set Position Code ${r.code} on their employee records.`;
}
// A slot's (or a list entry's) key: 'v<asset id>' for a vehicle, 'e<employee id>' for a person.
export const resourceKey = (s) => (s.role === 'vehicle' ? `v${s.asset_id}` : `e${s.employee_id}`);
export const resourceName = (s) => (s.role === 'vehicle'
  ? vehicleLabel({ ...s, id: s.asset_id })
  : [s.first_name, s.last_name].filter(Boolean).join(' '));
// Everyone (or every vehicle) of one kind, as { key, id, name }.
export function resourceList(kind, { employees = [], vehicles = [] }) {
  if (kind === 'vehicle') return vehicles.map((v) => ({ key: `v${v.id}`, id: v.id, name: vehicleLabel(v) }));
  const flag = RESOURCES[kind].flag;
  // Two employee records with the same name are one person on the calendar (asked 2026-11-10: ALLAN
  // RAMAN twice) -- one row / column, both records' bookings in it. Keyed on the first record.
  const byName = new Map();
  for (const e of employees.filter((x) => x[flag])) {
    const name = personName(e);
    const k = name.trim().replace(/s+/g, ' ').toLowerCase();
    if (byName.has(k)) byName.get(k).ids.push(e.id);
    else byName.set(k, { key: `e${e.id}`, id: e.id, ids: [e.id], name });
  }
  return [...byName.values()];
}

// Bookings re-keyed onto the merged people above, so a slot on either record lands in the one column.
export function mergeSlots(list, slots) {
  const alias = new Map();
  for (const p of list) for (const id of p.ids || []) if (id !== p.id) alias.set(Number(id), p.id);
  if (!alias.size) return slots;
  return slots.map((s) => (s.role !== 'vehicle' && alias.has(Number(s.employee_id)) ? { ...s, employee_id: alias.get(Number(s.employee_id)) } : s));
}

// "13:30:00" -> "1:30 PM"
export function timeText(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  if (Number.isNaN(h)) return '';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
export const slotHours = (s) => {
  const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  return (mins(s.end_time) - mins(s.start_time)) / 60;
};

// A checkbox at its native size beside its label. The app's input rule (36px tall, full width) is
// for text fields; on a bare checkbox it draws a big empty box.
const CHECK_STYLE = { width: 16, height: 16, minHeight: 0, flex: 'none', margin: 0, padding: 0 };
export function Check({ checked, onChange, children, style }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0, ...style }}>
      <input type="checkbox" style={CHECK_STYLE} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// A work type's chip (2026-11-11): its colour and name -- Assembling, Installation, ...
export function WorkChip({ name, color }) {
  if (!name) return <span className="muted">—</span>;
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: color || '#b4c7e7', color: '#1f2937', border: '1px solid rgba(0,0,0,0.15)', whiteSpace: 'nowrap' }}>
      {name}
    </span>
  );
}

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_BADGE[status] || 'badge-muted'}`}>{STATUS_LABEL[status] || status}</span>;
}

export function ProgressBar({ value, height }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="progress-bar" style={{ position: 'relative', ...(height ? { height } : {}) }}>
      <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      <div className="progress-bar-label">{pct}%</div>
    </div>
  );
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

export const MAX_BYTES = 10 * 1024 * 1024;

export async function filePayload(file) {
  if (file.size > MAX_BYTES) throw new Error(`"${file.name}" is over 10MB.`);
  return { file_name: file.name, mime_type: file.type || 'application/octet-stream', data: await readFileAsDataUrl(file) };
}

// Opens a file the API serves (picture, permit, BOM PDF, progress photo) in a new tab.
export async function openBlob(path) {
  try {
    const { data } = await api.get(path, { responseType: 'blob' });
    window.open(URL.createObjectURL(data), '_blank');
    return null;
  } catch (err) {
    return blobErrorMessage(err, 'Could not open that file');
  }
}

// An image the API serves, shown inline (the auth header rules out a plain <img src>).
export function BlobImage({ path, alt, style }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    let made = null;
    api.get(path, { responseType: 'blob' })
      .then(({ data }) => { if (live) { made = URL.createObjectURL(data); setUrl(made); } })
      .catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  if (!url) return <div className="muted" style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>…</div>;
  return <img src={url} alt={alt || ''} style={{ objectFit: 'cover', borderRadius: 8, ...style }} />;
}

// PLANNER's "select multiple" dropdown with checkboxes: a button listing what is chosen, opening a
// searchable list of checkboxes.
export function MultiPick({ items, value, onChange, getLabel, getSub, placeholder }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const chosen = new Set(value.map(Number));
  const picked = items.filter((i) => chosen.has(Number(i.id)));
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => `${getLabel(i)} ${getSub ? getSub(i) || '' : ''}`.toLowerCase().includes(needle)) : items;
  const toggle = (id) => onChange(chosen.has(Number(id)) ? value.filter((v) => Number(v) !== Number(id)) : [...value, Number(id)]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="btn" onClick={() => setOpen(!open)}
        style={{ width: '100%', textAlign: 'left', justifyContent: 'flex-start', whiteSpace: 'normal', minHeight: 36, fontWeight: 400 }}>
        {picked.length ? picked.map(getLabel).join(', ') : <span className="muted">{placeholder || 'Select...'}</span>}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', zIndex: 30, left: 0, right: 0, top: '100%', marginTop: 4, padding: 8, maxHeight: 320, overflowY: 'auto', textAlign: 'left', minWidth: 260 }}>
          <input type="search" placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6 }} autoFocus />
          {picked.length > 0 && (
            <button type="button" className="btn btn-sm" style={{ marginBottom: 6 }} onClick={() => onChange([])}>Clear ({picked.length})</button>
          )}
          {shown.length === 0 && <div className="muted" style={{ padding: 6 }}>Nothing matches.</div>}
          {shown.slice(0, 300).map((i) => (
            <Check key={i.id} checked={chosen.has(Number(i.id))} onChange={() => toggle(i.id)}
              style={{ display: 'flex', padding: '4px 2px', textAlign: 'left' }}>
              {getLabel(i)}{getSub && getSub(i) ? <span className="muted" style={{ fontSize: 12 }}> · {getSub(i)}</span> : null}
            </Check>
          ))}
        </div>
      )}
    </div>
  );
}
