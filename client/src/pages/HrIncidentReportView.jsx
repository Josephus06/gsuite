import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

const SEVERITY_BADGE = { minor: 'badge-muted', major: 'badge-warning', grave: 'badge-danger' };
const STATUS_BADGE = {
  for_evaluation: 'badge-warning',
  under_review: 'badge-info',
  substantiated: 'badge-danger',
  unsubstantiated: 'badge-success',
  dismissed: 'badge-muted',
};

// The three endings are kept distinct on purpose: it happened, it did not, or HR closed it without
// ruling. Collapsing them would lose the difference between an employee cleared and one never heard.
const OUTCOMES = [
  { key: 'under_review', label: 'Under Review', hint: 'Picked up, still being looked into.' },
  { key: 'substantiated', label: 'Substantiated', hint: 'The violation is found to have happened.' },
  { key: 'unsubstantiated', label: 'Unsubstantiated', hint: 'The evidence does not support the charge.' },
  { key: 'dismissed', label: 'Dismissed', hint: 'Closed without a finding.' },
];

function fmtDate(v) { return v ? String(v).slice(0, 10) : ''; }
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 16).replace('T', ' ')
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const pretty = (s) => (s ? String(s).replace(/_/g, ' ') : '');

export default function HrIncidentReportView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [ir, setIr] = useState(null);
  const [options, setOptions] = useState({ recommendations: [] });
  const [form, setForm] = useState({ hr_findings: '', recommendation: '', recommendation_notes: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const canEvaluate = can('/hrd/incident-reports', 'can_edit');

  const load = useCallback(() => api.get(`/hr-incident-reports/${id}`).then(({ data }) => {
    setIr(data);
    setForm({
      hr_findings: data.hr_findings || '',
      recommendation: data.recommendation || '',
      recommendation_notes: data.recommendation_notes || '',
    });
    setLoading(false);
  }), [id]);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);
  useEffect(() => {
    api.get('/hr-incident-reports/meta/options').then(({ data }) => setOptions(data)).catch(() => {});
  }, []);

  async function patch(body, note) {
    setBusy(true); setError(''); setSaved('');
    try { await api.put(`/hr-incident-reports/${id}`, body); await load(); setSaved(note || 'Saved.'); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
    finally { setBusy(false); }
  }

  if (loading) return <LoadingSpinner />;
  if (!ir) return <div className="error-banner">Incident report not found.</div>;

  const history = ir.history || [];
  const decided = !!ir.evaluated_at;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => navigate('/hrd/incident-reports')}>Back</button>
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="muted" style={{ marginBottom: 8 }}>{saved}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Incident Report</h1>
          <span className="estimate-no">{ir.incident_no}</span>
        </div>
        <div className="estimate-status">
          <span className={`badge ${STATUS_BADGE[ir.status] || 'badge-muted'}`}>{pretty(ir.status)}</span>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Employee</h4>
            <div className="hi">{ir.employee_name}</div>
            <div>Code : <span className="hi">{ir.employee_code || '—'}</span></div>
            <div>Department : <span className="hi">{ir.department_name || '—'}</span></div>
            <div>Position : <span className="hi">{ir.position_title || '—'}</span></div>
          </div>
          <div>
            <h4>Violation</h4>
            <div className="hi">{ir.violation_name}</div>
            <div>Category : <span className="hi">{ir.violation_category || '—'}</span></div>
            <div>Severity : <span className="hi">{ir.violation_severity}</span></div>
            <div>Date : <span className="hi">{fmtDate(ir.violation_date)}</span></div>
            <div>Place : <span className="hi">{ir.place || '—'}</span></div>
          </div>
          <div>
            <h4>Filed</h4>
            <div>Charge : <span className="hi">{ir.violation_no}</span></div>
            <div>By : <span className="hi">{ir.reported_by_name || '—'}</span></div>
            <div>On : <span className="hi">{fmtDateTime(ir.created_at)}</span></div>
            {decided && (
              <>
                <div>Evaluated By : <span className="hi">{ir.evaluated_by_name || '—'}</span></div>
                <div>Evaluated On : <span className="hi">{fmtDateTime(ir.evaluated_at)}</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>What was reported</h3>
        <div style={{ whiteSpace: 'pre-wrap' }}>
          {ir.details || <span className="muted">No account was given when the charge was filed.</span>}
        </div>
      </div>

      {/* The employee's record, on the screen where the decision is made. A first offence and a
          fourth call for different answers, and HR should not have to go looking. */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>
          Prior record ({history.length})
        </h3>
        {history.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No other violations on record for this employee.</p>
        ) : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Date</th><th>VIO #</th><th>Violation</th><th>Severity</th><th>Outcome</th><th>Recommendation</th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td data-label="Date">{fmtDate(h.violation_date)}</td>
                    <td data-label="VIO #">{h.violation_no}</td>
                    <td data-label="Violation">{h.violation_name}</td>
                    <td data-label="Severity">
                      <span className={`badge ${SEVERITY_BADGE[h.violation_severity] || 'badge-muted'}`}>
                        {h.violation_severity}
                      </span>
                    </td>
                    <td data-label="Outcome">
                      <span className={`badge ${STATUS_BADGE[h.status] || 'badge-muted'}`}>{pretty(h.status) || '—'}</span>
                    </td>
                    <td data-label="Recommendation">{pretty(h.recommendation) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>HR Evaluation</h3>
        {!canEvaluate ? (
          <p className="muted" style={{ margin: 0 }}>
            You can read this report but not rule on it. Evaluating needs Can Update on Incident Reports.
          </p>
        ) : (
          <>
            <div className="field">
              <label>Findings</label>
              <textarea rows={5} value={form.hr_findings} maxLength={4000}
                placeholder="What HR established, and on what basis."
                onChange={(e) => setForm({ ...form, hr_findings: e.target.value })} />
            </div>
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <div className="field">
                <label>Recommendation</label>
                <select value={form.recommendation}
                  onChange={(e) => setForm({ ...form, recommendation: e.target.value })}>
                  <option value="">--None yet--</option>
                  {(options.recommendations || []).map((r) => (
                    <option key={r} value={r}>{pretty(r)}</option>
                  ))}
                </select>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  The wording of any actual sanction belongs in the NTE that follows.
                </div>
              </div>
              <div className="field">
                <label>Notes</label>
                <input value={form.recommendation_notes} maxLength={1000}
                  onChange={(e) => setForm({ ...form, recommendation_notes: e.target.value })} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <button className="btn btn-sm btn-primary" disabled={busy}
                onClick={() => patch(form, 'Evaluation saved.')}>Save Evaluation</button>
            </div>

            <h4 style={{ marginBottom: 6 }}>Outcome</h4>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {OUTCOMES.map((o) => (
                <button key={o.key} title={o.hint}
                  className={`btn btn-sm ${ir.status === o.key ? 'btn-primary' : ''}`}
                  disabled={busy}
                  onClick={() => patch({ ...form, status: o.key }, `Marked ${o.label.toLowerCase()}.`)}>
                  {o.label}
                </button>
              ))}
              {decided && (
                <button className="btn btn-sm btn-warning" disabled={busy}
                  onClick={() => patch({ ...form, status: 'for_evaluation' }, 'Reopened.')}>
                  Reopen
                </button>
              )}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {decided
                ? 'This report has been decided, so the charge behind it can no longer be withdrawn.'
                : 'Deciding a report stamps who ruled and when, and locks the charge from being withdrawn.'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
