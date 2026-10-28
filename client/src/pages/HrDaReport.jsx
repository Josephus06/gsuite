import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayAuditTime } from '../utils/dates';

// HRD > DA Report (2026-10-28). HR's Discipline Management Report on the company's sheet, kept as one
// form per period -- a Monthly report and a Weekly one (Monday to Sunday) -- each a section per stage
// of the disciplinary action (NOTICE TO EXPLAIN, ...) with its rows of EMPLOYEE NAME / VIOLATION /
// SECTION VIOLATED / FINAL SANCTION.

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const parts = (v) => { const [y, m, d] = String(v || '').slice(0, 10).split('-').map(Number); return { y, m, d }; };

// "OCTOBER 2026" for a month; "OCTOBER 20 – 26, 2026" for a week (with both months, or both years,
// when the week runs across them).
export function periodTitle(type, from, to) {
  if (!from) return '';
  const a = parts(from);
  if (type !== 'weekly') return `${MONTHS[a.m - 1]} ${a.y}`;
  const b = parts(to);
  if (a.y !== b.y) return `${MONTHS[a.m - 1]} ${a.d}, ${a.y} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
  if (a.m !== b.m) return `${MONTHS[a.m - 1]} ${a.d} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
  return `${MONTHS[a.m - 1]} ${a.d} – ${b.d}, ${a.y}`;
}

const TABS = [{ key: 'monthly', label: 'Monthly' }, { key: 'weekly', label: 'Weekly' }];

export default function HrDaReport() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [type, setType] = useState(() => { try { return localStorage.getItem('daReportType') || 'monthly'; } catch { return 'monthly'; } });
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setRows(null);
    api.get('/hr-da-reports', { params: { type } })
      .then(({ data }) => setRows(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the reports.'));
  }, [type]);
  useEffect(() => { load(); try { localStorage.setItem('daReportType', type); } catch { /* private window */ } }, [type, load]);

  async function remove(r) {
    if (!confirm(`Delete ${r.report_no} (${periodTitle(r.report_type, r.period_from, r.period_to)}) and all its rows?`)) return;
    try { await api.delete(`/hr-da-reports/${r.id}`); load(); }
    catch (e) { alert(e.response?.data?.error || 'Could not delete it.'); }
  }

  const label = TABS.find((t) => t.key === type)?.label;

  return (
    <div>
      <div className="page-header">
        <h1>DA Report</h1>
        {can('/hrd/da-report', 'can_add') && (
          <button className="btn btn-primary" onClick={() => navigate(`/hrd/da-report/new?type=${type}`)}>New {label} Report</button>
        )}
      </div>

      <div className="status-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`status-tab ${type === t.key ? 'active' : ''}`} onClick={() => setType(t.key)}>{t.label}</button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {!rows ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Report #</th><th>{type === 'weekly' ? 'Week' : 'Month'}</th><th>Sections</th><th style={{ textAlign: 'right' }}>Rows</th><th>Prepared By</th><th>Last Saved</th><th /></tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No {label.toLowerCase()} reports yet.</td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Report #">{r.report_no}</td>
                    <td data-label={type === 'weekly' ? 'Week' : 'Month'} style={{ fontWeight: 600 }}>{periodTitle(r.report_type, r.period_from, r.period_to)}</td>
                    <td data-label="Sections">{r.stages}</td>
                    <td data-label="Rows" style={{ textAlign: 'right' }}>{r.line_count}</td>
                    <td data-label="Prepared By">{r.created_by_name}</td>
                    <td data-label="Last Saved">{displayAuditTime(r.updated_at)}</td>
                    <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {can('/hrd/da-report', 'can_print') && <button className="btn btn-sm" onClick={() => window.open(`/hrd/da-report/${r.id}/print`, '_blank')}>Print</button>}
                      <Link className="btn btn-sm btn-primary" to={`/hrd/da-report/${r.id}`}>{can('/hrd/da-report', 'can_edit') ? 'Open' : 'View'}</Link>
                      {can('/hrd/da-report', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => remove(r)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
