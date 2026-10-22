import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';

// HRD > Certificate of Employment (2026-10-22). The company's two COE templates, issued from the
// employee record: the plain COE and the COE with rating (the separation certificate with the
// Performance Appraisal table). Print opens the certificate on the letterhead, ready for signing.

const TYPE_LABEL = { standard: 'COE', with_rating: 'COE with rating' };
const today = () => new Date().toISOString().slice(0, 10);
function fmtDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
const pronounFromSex = (sex) => {
  const s = String(sex || '').trim().toLowerCase();
  if (s.startsWith('m')) return 'he';
  if (s.startsWith('f')) return 'she';
  return 'either';
};

function blankForm(criteria) {
  return {
    coe_type: 'standard',
    employee_id: null,
    employee_name: '',
    position_title: '',
    date_from: '',
    date_to: '',
    pronoun: 'either',
    issued_to: '',
    issued_date: today(),
    ratings: criteria.map((c) => ({ key: c.key, label: c.label, rating: '', remarks: c.remarks })),
    mode_of_separation: '',
    clearance_status: '',
    signatory_name: 'JIMMY W. WU',
    signatory_title: 'General Manager',
    remarks: '',
  };
}

function CoeModal({ criteria, existing, onClose, onSaved }) {
  const [form, setForm] = useState(() => {
    if (!existing) return blankForm(criteria);
    const base = blankForm(criteria);
    const ratings = base.ratings.map((r) => ({ ...r, ...((existing.ratings || []).find((x) => x.key === r.key) || {}) }));
    const pick = (k) => {
      if (existing[k] == null) return base[k];
      return /date/.test(k) ? String(existing[k]).slice(0, 10) : existing[k];
    };
    return {
      ...base,
      ...Object.fromEntries(Object.keys(base).filter((k) => k !== 'ratings').map((k) => [k, pick(k)])),
      employee_id: existing.employee_id,
      ratings,
    };
  });
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const chosen = !!form.employee_name;

  useEffect(() => {
    if (chosen) return undefined;
    const t = setTimeout(() => {
      setSearching(true);
      api.get('/hr-coe/employees', { params: { search: search || undefined } })
        .then(({ data }) => setMatches(data))
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search, chosen]);

  // Everything the certificate says about the person comes from their record; HR can still change
  // any of it before saving (a position title worded differently on paper, say).
  function pickEmployee(e) {
    const mi = e.middle_initial ? ` ${String(e.middle_initial).replace(/\.?$/, '.')}` : '';
    const name = [e.first_name, mi.trim(), e.last_name].filter(Boolean).join(' ').toUpperCase();
    set({
      employee_id: e.id,
      employee_name: name,
      position_title: e.position_title || '',
      date_from: e.date_hired ? String(e.date_hired).slice(0, 10) : '',
      date_to: e.date_separated ? String(e.date_separated).slice(0, 10) : '',
      pronoun: pronounFromSex(e.sex),
      issued_to: form.issued_to || name,
    });
  }

  function setRating(i, patch) {
    setForm((f) => ({ ...f, ratings: f.ratings.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  }

  async function save() {
    setError(''); setSaving(true);
    try {
      const { data } = existing
        ? await api.put(`/hr-coe/${existing.id}`, form)
        : await api.post('/hr-coe', form);
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the certificate.');
      setSaving(false);
    }
  }

  const rating = form.coe_type === 'with_rating';

  return (
    <Modal title={existing ? `Edit ${existing.coe_no}` : 'New Certificate of Employment'} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}

      <div className="field">
        <label>Certificate *</label>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {Object.entries(TYPE_LABEL).map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
              <input type="radio" name="coe_type" checked={form.coe_type === k} onChange={() => set({ coe_type: k })} />
              {label}
            </label>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {rating
            ? 'For a separated employee: "was employed with…", the Performance Appraisal prior to separation, Mode of Separation and Clearance Status.'
            : 'The plain certificate: "has been employed with… from … to …". Leave To empty for a current employee ("to present").'}
        </div>
      </div>

      <div className="field">
        <label>Employee *</label>
        {chosen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>{form.employee_name}</strong>
            <button type="button" className="btn btn-sm"
              onClick={() => { set({ employee_id: null, employee_name: '' }); setMatches([]); }}>Change</button>
          </div>
        ) : (
          <>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Type a name, employee code, department or position" />
            <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6 }}>
              <table>
                <tbody>
                  {searching && <tr><td className="muted" style={{ padding: 10 }}>Searching...</td></tr>}
                  {!searching && matches.length === 0 && (
                    <tr><td className="muted" style={{ padding: 10 }}>No employee matches that.</td></tr>
                  )}
                  {!searching && matches.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <button type="button" className="link-btn" onClick={() => pickEmployee(m)}>{m.employee_name}</button>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {m.employee_code || '—'} · {m.department_name || 'No department'}
                          {m.position_title ? ` · ${m.position_title}` : ''}
                          {m.date_hired ? ` · hired ${fmtDate(m.date_hired)}` : ''}
                          {!m.is_active && <span style={{ color: '#b45309' }}> · separated{m.date_separated ? ` ${fmtDate(m.date_separated)}` : ''}</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {chosen && (
        <>
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div className="field">
              <label>Name as printed *</label>
              <input value={form.employee_name} maxLength={200} onChange={(e) => set({ employee_name: e.target.value })} />
            </div>
            <div className="field">
              <label>Position</label>
              <input value={form.position_title} maxLength={150} onChange={(e) => set({ position_title: e.target.value })} />
            </div>
            <div className="field">
              <label>From (date hired) *</label>
              <input type="date" value={form.date_from} onChange={(e) => set({ date_from: e.target.value })} />
            </div>
            <div className="field">
              <label>To {rating ? '(last day) *' : '(empty = present)'}</label>
              <input type="date" value={form.date_to} onChange={(e) => set({ date_to: e.target.value })} />
            </div>
            <div className="field">
              <label>{rating ? 'Issued upon request of' : 'Issued to'}</label>
              <input value={form.issued_to} maxLength={200} onChange={(e) => set({ issued_to: e.target.value })} />
            </div>
            <div className="field">
              <label>Date issued *</label>
              <input type="date" value={form.issued_date} onChange={(e) => set({ issued_date: e.target.value })} />
            </div>
            <div className="field">
              <label>His / Her</label>
              <select value={form.pronoun} onChange={(e) => set({ pronoun: e.target.value })}>
                <option value="either">his/her (as on the template)</option>
                <option value="he">his</option>
                <option value="she">her</option>
              </select>
            </div>
          </div>

          {rating && (
            <>
              <h3 style={{ margin: '12px 0 6px', fontSize: 14 }}>Performance Appraisal prior to separation</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th style={{ width: '30%' }} /><th style={{ width: 130 }}>Rating</th><th>Remarks</th></tr></thead>
                  <tbody>
                    {form.ratings.map((r, i) => (
                      <tr key={r.key}>
                        <td style={{ fontSize: 12 }}>{r.label}</td>
                        <td><input value={r.rating} maxLength={40} placeholder="e.g. 4 / Good" onChange={(e) => setRating(i, { rating: e.target.value })} /></td>
                        <td><textarea rows={2} value={r.remarks} maxLength={500} onChange={(e) => setRating(i, { remarks: e.target.value })} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginTop: 10 }}>
                <div className="field">
                  <label>Mode of Separation</label>
                  <input value={form.mode_of_separation} maxLength={150} placeholder="e.g. Resignation, End of Contract"
                    onChange={(e) => set({ mode_of_separation: e.target.value })} />
                </div>
                <div className="field">
                  <label>Clearance Status</label>
                  <input value={form.clearance_status} maxLength={150} placeholder="e.g. Cleared"
                    onChange={(e) => set({ clearance_status: e.target.value })} />
                </div>
              </div>
            </>
          )}

          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div className="field">
              <label>Signatory</label>
              <input value={form.signatory_name} maxLength={150} onChange={(e) => set({ signatory_name: e.target.value })} />
            </div>
            <div className="field">
              <label>Signatory title</label>
              <input value={form.signatory_title} maxLength={150} onChange={(e) => set({ signatory_title: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Internal remarks (not printed)</label>
            <input value={form.remarks} maxLength={500} onChange={(e) => set({ remarks: e.target.value })} />
          </div>
        </>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !chosen} onClick={save}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

export default function HrCoe() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [criteria, setCriteria] = useState([]);
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null = closed, {} = new, row = edit

  const canAdd = can('/hrd/coe', 'can_add');
  const canEdit = can('/hrd/coe', 'can_edit');
  const canDelete = can('/hrd/coe', 'can_delete');
  const canPrint = can('/hrd/coe', 'can_print');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/hr-coe', { params: { type: type || undefined, search: search || undefined } });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load certificates.'); }
    setLoading(false);
  }, [type, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/hr-coe/meta').then(({ data }) => setCriteria(data.criteria)).catch(() => {}); }, []);

  const print = (r) => window.open(`/hrd/coe/${r.id}/print`, '_blank');

  async function remove(r) {
    if (!confirm(`Delete ${r.coe_no} (${r.employee_name})?`)) return;
    try { await api.delete(`/hr-coe/${r.id}`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not delete that certificate.'); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Certificate of Employment</h1>
        {canAdd && criteria.length > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>New Certificate</button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input style={{ flex: '1 1 240px' }} placeholder="Search COE #, employee, position or requested by"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={{ flex: '0 0 220px', width: 220 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All certificates</option>
          <option value="standard">COE</option>
          <option value="with_rating">COE with rating</option>
        </select>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>COE #</th><th>Certificate</th><th>Employee</th><th>Position</th>
                <th>Employed</th><th>Issued</th><th>Issued To</th><th>By</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={9} className="muted" style={{ padding: 16, textAlign: 'center' }}>No certificates yet.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.coe_no}</td>
                  <td><span className={`badge ${r.coe_type === 'with_rating' ? 'badge-warning' : 'badge-info'}`}>{TYPE_LABEL[r.coe_type]}</span></td>
                  <td>{r.employee_name}{r.employee_code ? <div className="muted" style={{ fontSize: 11 }}>{r.employee_code}</div> : null}</td>
                  <td>{r.position_title}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date_from)} – {r.date_to ? fmtDate(r.date_to) : 'present'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.issued_date)}</td>
                  <td>{r.issued_to}</td>
                  <td>{r.created_by_name}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {canPrint && <button type="button" className="btn btn-sm" onClick={() => print(r)}>Print</button>}{' '}
                    {canEdit && <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>}{' '}
                    {canDelete && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(r)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CoeModal
          criteria={criteria}
          existing={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={(saved) => { setEditing(null); load(); if (canPrint) print(saved); }}
        />
      )}
    </div>
  );
}
