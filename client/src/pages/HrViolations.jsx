import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const SEVERITY_BADGE = { minor: 'badge-muted', major: 'badge-warning', grave: 'badge-danger' };
const STATUS_BADGE = {
  filed: 'badge-info',
  substantiated: 'badge-danger',
  unsubstantiated: 'badge-success',
  dismissed: 'badge-muted',
};

function fmtDate(v) { return v ? String(v).slice(0, 10) : ''; }
const pretty = (s) => (s ? String(s).replace(/_/g, ' ') : '');

// Charging an employee: find the person, pick the offence, say what happened.
//
// Employee search is server-side and debounced rather than a 275-row dropdown -- a supervisor
// types a name, not scrolls a payroll list.
function ChargeModal({ types, onClose, onSaved }) {
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState([]);
  const [employee, setEmployee] = useState(null);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({
    violation_type_id: '',
    violation_date: new Date().toISOString().slice(0, 10),
    place: '',
    details: '',
  });
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (employee) return undefined;
    const t = setTimeout(() => {
      setSearching(true);
      api.get('/hr-violations/employees', { params: { search: search || undefined } })
        .then(({ data }) => setMatches(data))
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search, employee]);

  // Their record so far, shown the moment a name is picked. Whoever is filing should see that this
  // is a fourth offence before they write the account of it, not afterwards.
  function pick(emp) {
    setEmployee(emp);
    setError('');
    api.get(`/hr-violations/employees/${emp.id}/history`)
      .then(({ data }) => setHistory(data)).catch(() => setHistory([]));
  }

  async function save() {
    if (!employee) { setError('Choose the employee being charged.'); return; }
    if (!form.violation_type_id) { setError('Choose the violation.'); return; }
    if (!form.violation_date) { setError('Enter the date it happened.'); return; }
    setError(''); setSaving(true);
    try {
      const { data } = await api.post('/hr-violations', { ...form, employee_id: employee.id });
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not file the violation.');
      setSaving(false);
    }
  }

  const chosen = types.find((t) => String(t.id) === String(form.violation_type_id));

  // Grouped in the order the server returns them, which is the code of conduct's own order.
  // Anything with no category falls under a plain heading rather than vanishing from the list.
  const grouped = [...types.reduce((m, t) => {
    const key = t.category || 'Uncategorised';
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(t);
    return m;
  }, new Map())];

  return (
    <Modal title="Charge a Violation" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}

      <div className="field">
        <label>Employee *</label>
        {employee ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>{employee.employee_name}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {employee.employee_code || '—'} · {employee.department_name || 'No department'}
              {employee.position_title ? ` · ${employee.position_title}` : ''}
            </span>
            <button type="button" className="btn btn-sm"
              onClick={() => { setEmployee(null); setHistory([]); setMatches([]); }}>Change</button>
          </div>
        ) : (
          <>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Type a name, employee code or department" />
            <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6 }}>
              <table>
                <tbody>
                  {searching && (
                    <tr><td className="muted" style={{ padding: 10 }}>Searching...</td></tr>
                  )}
                  {!searching && matches.length === 0 && (
                    <tr><td className="muted" style={{ padding: 10 }}>No active employee matches that.</td></tr>
                  )}
                  {!searching && matches.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <button type="button" className="link-btn" onClick={() => pick(m)}>{m.employee_name}</button>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {m.employee_code || '—'} · {m.department_name || 'No department'}
                          {Number(m.prior_violations) > 0 && (
                            <span style={{ color: '#b45309' }}> · {m.prior_violations} prior</span>
                          )}
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

      {employee && history.length > 0 && (
        <div className="card" style={{ marginBottom: 12, background: 'var(--bg)' }}>
          <strong style={{ fontSize: 13 }}>Prior record ({history.length})</strong>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            {history.slice(0, 5).map((h) => (
              <div key={h.id} className="muted">
                {fmtDate(h.violation_date)} · {h.violation_name}
                {h.recommendation ? ` · ${pretty(h.recommendation)}` : ''}
              </div>
            ))}
            {history.length > 5 && <div className="muted">…and {history.length - 5} more</div>}
          </div>
        </div>
      )}

      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="field">
          <label>Violation *</label>
          {/* Grouped under the code-of-conduct headings rather than prefixed with them. These run
              to 78 characters, so "heading — name" on every line would push the actual violation
              off the end of the dropdown. */}
          <select value={form.violation_type_id}
            onChange={(e) => setForm({ ...form, violation_type_id: e.target.value })}>
            <option value="">--Select--</option>
            {grouped.map(([category, items]) => (
              <optgroup key={category} label={category}>
                {items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </optgroup>
            ))}
          </select>
          {types.length === 0 && (
            <div style={{ color: '#b45309', fontSize: 12, marginTop: 4 }}>
              No violations defined yet. HR must set up the list first.
            </div>
          )}
          {chosen && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              <span className={`badge ${SEVERITY_BADGE[chosen.severity] || 'badge-muted'}`}>{chosen.severity}</span>
              {chosen.description ? ` ${chosen.description}` : ''}
            </div>
          )}
        </div>
        <div className="field">
          <label>Date of Violation *</label>
          <input type="date" value={form.violation_date}
            onChange={(e) => setForm({ ...form, violation_date: e.target.value })} />
        </div>
      </div>

      <div className="field">
        <label>Place</label>
        <input value={form.place} maxLength={200} placeholder="Where it happened"
          onChange={(e) => setForm({ ...form, place: e.target.value })} />
      </div>
      <div className="field">
        <label>What happened</label>
        <textarea rows={4} value={form.details} maxLength={4000}
          placeholder="The account HR will evaluate. Facts and what was observed."
          onChange={(e) => setForm({ ...form, details: e.target.value })} />
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Saving raises an Incident Report for HR to evaluate.
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !employee} onClick={save}>
          {saving ? 'Filing...' : 'File Violation'}
        </button>
      </div>
    </Modal>
  );
}

// The lookup. Every violation an employee may be charged with, kept by HR.
function TypesModal({ onClose, onChanged, canEdit, canDelete }) {
  const empty = { name: '', code: '', category: '', severity: 'minor', description: '', sort_order: 0 };
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => api.get('/hr-violations/types', { params: { include_inactive: 1 } })
    .then(({ data }) => setRows(data)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/hr-violations/meta/categories')
      .then(({ data }) => setCategories(data.categories || [])).catch(() => setCategories([]));
  }, []);

  async function save() {
    if (!form.name.trim()) { setError('A violation name is required.'); return; }
    setError(''); setNotice(''); setBusy(true);
    try {
      if (editing) await api.put(`/hr-violations/types/${editing}`, form);
      else await api.post('/hr-violations/types', form);
      setForm(empty); setEditing(null);
      await load(); onChanged();
    } catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
    finally { setBusy(false); }
  }

  async function remove(t) {
    if (!confirm(`Remove "${t.name}" from the violation list?`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data } = await api.delete(`/hr-violations/types/${t.id}`);
      if (data.retired) {
        setNotice(`"${t.name}" has ${data.charges} charge(s) on record, so it was retired rather than deleted.`);
      }
      await load(); onChanged();
    } catch (e) { setError(e.response?.data?.error || 'Could not remove.'); }
    finally { setBusy(false); }
  }

  async function toggle(t) {
    setBusy(true);
    try { await api.put(`/hr-violations/types/${t.id}`, { ...t, is_active: !t.is_active }); await load(); onChanged(); }
    catch (e) { setError(e.response?.data?.error || 'Could not update.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Manage Violations" onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="muted" style={{ marginBottom: 8 }}>{notice}</div>}

      {rows.length === 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>The list starts empty on purpose.</strong>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            These are the offences your company&apos;s code of conduct actually defines. Nothing is
            pre-filled, so nobody can be charged under a rule the company never adopted.
          </div>
        </div>
      )}

      {canEdit && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="field">
              <label>Violation *</label>
              <input value={form.name} maxLength={150} placeholder="e.g. Habitual tardiness"
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Code</label>
              <input value={form.code || ''} maxLength={30} placeholder="e.g. A-01"
                onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </div>
            <div className="field">
              <label>Category</label>
              {/* Fetched rather than hard-coded here, so the wording exists in one place and the
                  dropdown can never offer something the server would reject. */}
              <select value={form.category || ''}
                onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="">--Select--</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Severity</label>
              <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="grave">Grave</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Description</label>
            <textarea rows={2} value={form.description || ''} maxLength={1000}
              placeholder="How the handbook defines it, so whoever files a charge cites the right rule."
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={save}>
              {editing ? 'Save Violation' : 'Add Violation'}
            </button>
            {editing && (
              <button className="btn btn-sm" onClick={() => { setEditing(null); setForm(empty); }}>Cancel edit</button>
            )}
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="responsive-cards">
          <thead>
            <tr><th>Code</th><th>Violation</th><th>Category</th><th>Severity</th><th>Charged</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                No violations defined yet.
              </td></tr>
            )}
            {rows.map((t) => (
              <tr key={t.id} style={t.is_active ? undefined : { opacity: 0.55 }}>
                <td data-label="Code">{t.code || '—'}</td>
                <td data-label="Violation">
                  <strong>{t.name}</strong>
                  {t.description && <div className="muted" style={{ fontSize: 11 }}>{t.description}</div>}
                </td>
                <td data-label="Category">{t.category || '—'}</td>
                <td data-label="Severity">
                  <span className={`badge ${SEVERITY_BADGE[t.severity] || 'badge-muted'}`}>{t.severity}</span>
                </td>
                <td data-label="Charged">{Number(t.times_charged) || 0}</td>
                <td data-label="Status">
                  {t.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Retired</span>}
                </td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {canEdit && (
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => { setEditing(t.id); setForm({ ...t }); }}>Edit</button>
                  )}
                  {canEdit && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => toggle(t)}>
                      {t.is_active ? 'Retire' : 'Reinstate'}
                    </button>
                  )}
                  {canDelete && t.is_active && (
                    <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => remove(t)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export default function HrViolations() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [types, setTypes] = useState([]);
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCharge, setShowCharge] = useState(false);
  const [showTypes, setShowTypes] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/hr-violations', {
        params: { search: search || undefined, severity: severity || undefined },
      });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load violations.'); }
    setLoading(false);
  }, [search, severity]);

  const loadTypes = useCallback(() => api.get('/hr-violations/types')
    .then(({ data }) => setTypes(data)).catch(() => setTypes([])), []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTypes(); }, [loadTypes]);

  return (
    <div>
      <div className="page-header">
        <h1>Violation</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/hrd">Files</Link>
          <Link className="btn btn-sm" to="/hrd/incident-reports">Incident Reports</Link>
          {can('/hrd/violations', 'can_edit') && (
            <button className="btn btn-sm" onClick={() => setShowTypes(true)}>Manage Violations</button>
          )}
          {can('/hrd/violations', 'can_add') && (
            <button className="btn btn-primary" onClick={() => setShowCharge(true)}>Charge a Violation</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="muted" style={{ marginBottom: 8 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0, flex: '1 1 260px' }}>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Employee, violation or VIO number" />
          </div>
          <div className="field" style={{ margin: 0, width: 160 }}>
            <label>Severity</label>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All</option>
              <option value="minor">Minor</option>
              <option value="major">Major</option>
              <option value="grave">Grave</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>VIO #</th><th>Date</th><th>Employee</th><th>Department</th>
                  <th>Violation</th><th>Severity</th><th>Incident Report</th><th>Filed By</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No violations on record.
                  </td></tr>
                )}
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td data-label="VIO #">{v.violation_no}</td>
                    <td data-label="Date">{fmtDate(v.violation_date)}</td>
                    <td data-label="Employee">
                      <strong>{v.employee_name}</strong>
                      {v.employee_code && <div className="muted" style={{ fontSize: 11 }}>{v.employee_code}</div>}
                    </td>
                    <td data-label="Department">{v.department_name || '—'}</td>
                    <td data-label="Violation">
                      {v.violation_name}
                      {v.violation_category && <div className="muted" style={{ fontSize: 11 }}>{v.violation_category}</div>}
                    </td>
                    <td data-label="Severity">
                      <span className={`badge ${SEVERITY_BADGE[v.violation_severity] || 'badge-muted'}`}>
                        {v.violation_severity}
                      </span>
                    </td>
                    <td data-label="Incident Report">
                      {v.incident_report_id ? (
                        <button type="button" className="link-btn"
                          onClick={() => navigate(`/hrd/incident-reports/${v.incident_report_id}`)}>
                          {v.incident_no}
                        </button>
                      ) : <span className="muted">—</span>}
                      <div>
                        <span className={`badge ${STATUS_BADGE[v.status] || 'badge-muted'}`}>{pretty(v.incident_status || v.status)}</span>
                      </div>
                    </td>
                    <td data-label="Filed By">{v.reported_by_name || '—'}</td>
                    <td>
                      <button className="btn btn-sm btn-primary"
                        onClick={() => navigate(`/hrd/incident-reports/${v.incident_report_id}`)}
                        disabled={!v.incident_report_id}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCharge && (
        <ChargeModal types={types} onClose={() => setShowCharge(false)}
          onSaved={(d) => {
            setShowCharge(false);
            setNotice(`${d.violation_no} filed. ${d.incident_no} raised for HR to evaluate.`);
            load();
          }} />
      )}
      {showTypes && (
        <TypesModal onClose={() => setShowTypes(false)} onChanged={loadTypes}
          canEdit={can('/hrd/violations', 'can_edit')} canDelete={can('/hrd/violations', 'can_delete')} />
      )}
    </div>
  );
}
