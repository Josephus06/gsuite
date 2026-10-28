import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import AutoCorrectTextarea from '../components/AutoCorrectTextarea';
import { useAuth } from '../context/useAuth';
import { displayDate } from '../utils/dates';

const SEVERITY_BADGE = { minor: 'badge-muted', major: 'badge-warning', grave: 'badge-danger' };
const STATUS_BADGE = {
  for_evaluation: 'badge-warning',
  under_review: 'badge-info',
  substantiated: 'badge-danger',
  unsubstantiated: 'badge-success',
  dismissed: 'badge-muted',
};
const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'for_evaluation', label: 'For Evaluation' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'substantiated', label: 'Substantiated' },
  { key: 'unsubstantiated', label: 'Unsubstantiated' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
];

function fmtDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
const pretty = (s) => (s ? String(s).replace(/_/g, ' ') : '');

// Editing a report's charge while it is still For Evaluation (2026-10-28): the date, place and what
// happened. The employee and the violation stay as filed -- a different charge is a new report.
function EditChargeModal({ report, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get(`/hr-incident-reports/${report.id}`)
      .then(({ data }) => setForm({
        violation_date: data.violation_date ? String(data.violation_date).slice(0, 10) : '',
        place: data.place || '', details: data.details || '',
      }))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the report.'));
  }, [report.id]);

  async function save() {
    setError(''); setSaving(true);
    try { await api.put(`/hr-incident-reports/${report.id}/charge`, form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); setSaving(false); }
  }

  return (
    <Modal title={`Edit ${report.incident_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="muted" style={{ marginBottom: 10 }}>
        {report.employee_name} — {report.violation_name} <span className="muted">({report.violation_no})</span>
      </div>
      {!form ? <LoadingSpinner /> : (
        <>
          <div className="field">
            <label>Date of Violation *</label>
            <input type="date" value={form.violation_date} onChange={(e) => setForm({ ...form, violation_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Place</label>
            <input value={form.place} maxLength={200} placeholder="Where it happened" onChange={(e) => setForm({ ...form, place: e.target.value })} />
          </div>
          <div className="field">
            <label>What happened</label>
            <AutoCorrectTextarea rows={5} value={form.details} maxLength={4000}
              placeholder="The account HR will evaluate. Facts and what was observed."
              onChange={(e) => setForm((x) => ({ ...x, details: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function HrIncidentReports() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [data, setData] = useState({ rows: [], counts: {} });
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const canDelete = can('/hrd/incident-reports', 'can_delete');
  const canEdit = can('/hrd/incident-reports', 'can_edit');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/hr-incident-reports', {
        params: { status, search: search || undefined },
      });
      setData(d);
    } catch (e) { setError(e.response?.data?.error || 'Could not load incident reports.'); }
    setLoading(false);
  }, [status, search]);

  useEffect(() => { load(); }, [load]);
  const counts = data.counts || {};

  // Said plainly, because the charge goes with the report and there is no undo: an employee's
  // conduct record loses this entry entirely.
  async function remove(r) {
    if (!confirm(`Delete ${r.incident_no} and the charge behind it (${r.violation_no} — ${r.employee_name})?\n\nThis cannot be undone.`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/hr-incident-reports/${r.id}`); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not delete that incident report.'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Incident Report</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/hrd">Files</Link>
          <Link className="btn btn-sm" to="/hrd/violations">Violations</Link>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* The queue at a glance. What is waiting is the number that matters -- a report nobody has
          picked up is an employee waiting to hear what happens to them. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[['for_evaluation', 'For Evaluation', counts.for_evaluation],
          ['under_review', 'Under Review', counts.under_review],
          ['all', 'Closed', counts.closed]].map(([key, label, n]) => (
            <button key={key} type="button" onClick={() => setStatus(key)}
              style={{
                textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 10, color: 'inherit',
                border: status === key ? '2px solid var(--accent, #4f46e5)' : '1px solid var(--border, #e2e8f0)',
                background: 'transparent',
              }}>
              <div className="muted" style={{ fontSize: 12 }}>{label}</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{Number(n || 0)}</div>
            </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0, flex: '1 1 260px' }}>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Employee, violation, IR or VIO number" />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <button key={f.key} className={`btn btn-sm ${status === f.key ? 'btn-primary' : ''}`}
                onClick={() => setStatus(f.key)}>{f.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>IR #</th><th>Date</th><th>Employee</th><th>Department</th>
                  <th>Violation</th><th>Severity</th><th>Status</th><th>Recommendation</th><th />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing in this view.
                  </td></tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="IR #">
                      <strong>{r.incident_no}</strong>
                      <div className="muted" style={{ fontSize: 11 }}>{r.violation_no}</div>
                    </td>
                    <td data-label="Date">{fmtDate(r.violation_date)}</td>
                    <td data-label="Employee">
                      <strong>{r.employee_name}</strong>
                      {r.employee_code && <div className="muted" style={{ fontSize: 11 }}>{r.employee_code}</div>}
                    </td>
                    <td data-label="Department">{r.department_name || '—'}</td>
                    <td data-label="Violation">{r.violation_name}</td>
                    <td data-label="Severity">
                      <span className={`badge ${SEVERITY_BADGE[r.violation_severity] || 'badge-muted'}`}>
                        {r.violation_severity}
                      </span>
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{pretty(r.status)}</span>
                    </td>
                    <td data-label="Recommendation">{pretty(r.recommendation) || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Link className="btn btn-sm btn-primary"
                          to={`/hrd/incident-reports/${r.id}`}>Evaluate</Link>
                        {canEdit && r.status === 'for_evaluation' && (
                          <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>
                        )}
                        {canDelete && (
                          <button className="btn btn-sm btn-danger" disabled={busy}
                            onClick={() => remove(r)}>Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <EditChargeModal report={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}
