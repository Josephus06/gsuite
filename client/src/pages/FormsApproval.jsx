import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import SearchInput from '../components/SearchInput';
import Pagination from '../components/Pagination';
import { NO_ITEM_TYPES, STATUS_BADGE, TYPE_LABELS, fmtDate, money, pretty, statusLabel, releaseLabel, releaseBadge } from '../utils/requestForms';

// The approval queue -- what is waiting on a decision, rather than what you filed.
//
// A submitted form with no noter (none chosen, a fuel request, a leave with nobody to note it) sits
// under For Approval with the noted ones -- the server sorts that out (2026-10-28).
// Drafts never appear: a form nobody has submitted is its owner's business alone. Submitted opens
// first because it is where a form waits longest -- on its department head. Approved and Rejected
// are there to look back at, not to work through.
const TABS = [
  { key: 'submitted', label: 'For Noting' },
  { key: 'noted', label: 'For Approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

// Submitted date filter (asked 2026-11-24), the old system's way: "As of" a day (submitted on or
// before it) or "Period from" one day to another. Blank dates filter nothing. Compared on the day
// the Submitted column shows.
const EMPTY_RANGE = { mode: 'as_of', from: '', to: '' };
const dayOf = (r) => String(r.submitted_at || r.created_at || '').slice(0, 10);
function inRange(r, range) {
  const d = dayOf(r);
  if (range.mode === 'period' && range.from && (!d || d < range.from)) return false;
  if (range.to && (!d || d > range.to)) return false;
  return true;
}

// Extract (2026-11-24): the rows the filters show, every page of them, as a CSV Excel opens --
// with a BOM so names with ñ and the peso amounts come through intact.
function csvCell(v) {
  const t = v == null ? '' : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
function downloadCsv(filename, header, lines) {
  const body = [header, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n');
  const BOM = String.fromCharCode(0xfeff); // so Excel reads the file as UTF-8
  const url = URL.createObjectURL(new Blob([BOM + body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function FormsApproval() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [tab, setTab] = useState('submitted');
  const [type, setType] = useState('');
  // Search and Department (asked 2026-10-27) filter the loaded tab in place -- the queue is one
  // short list per tab, so there is nothing to page through on the server.
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [range, setRange] = useState(EMPTY_RANGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/forms/approval/queue', {
        params: { status: tab, type: type || undefined },
      });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the approval queue.'); }
    setLoading(false);
  }, [tab, type]);

  useEffect(() => { load(); }, [load]);

  const departments = useMemo(
    () => [...new Set(rows.map((r) => r.department).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (!department || r.department === department)
      && inRange(r, range)
      && (!q || [r.request_no, r.owner_name, r.department, TYPE_LABELS[r.type] || pretty(r.type)]
        .some((v) => String(v || '').toLowerCase().includes(q))));
  }, [rows, search, department, range]);

  function extract() {
    const tabLabel = (TABS.find((t) => t.key === tab) || {}).label || tab;
    const day = (v) => String(v || '').slice(0, 10);
    downloadCsv(
      `forms-${tabLabel.toLowerCase().replace(/s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['REQ #', 'Form', 'Filed By', 'Department', 'Submitted', 'Noted', 'Approved', 'Rejected', 'Amount', 'Status', 'Release', 'Rejection Reason'],
      shown.map((r) => [
        r.request_no, TYPE_LABELS[r.type] || pretty(r.type), r.owner_name || '', r.department || '',
        day(r.submitted_at), day(r.noted_at), day(r.approved_at), day(r.rejected_at),
        NO_ITEM_TYPES.includes(r.type) ? '' : Number(r.total_amount || 0).toFixed(2),
        r.status === 'noted' && Number(r.waiting_pre_approval) ? 'For Pre-Approval' : r.direct_approval ? 'For Approval' : statusLabel(r.status),
        releaseLabel(r.release_status), r.rejection_reason || '',
      ]),
    );
  }

  // Paged (asked 2026-11-17): Approved and Rejected keep every form ever decided, so the tab had
  // grown into one endless page. 20 a page, back to page 1 whenever the tab or a filter changes.
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [tab, type, search, department, range]);
  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const pageRows = shown.slice((Math.min(page, totalPages) - 1) * PAGE_SIZE, Math.min(page, totalPages) * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Forms Approval</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm btn-primary" disabled={loading || !shown.length} onClick={extract}
            title="Download the forms these filters show (all pages) as a spreadsheet">Extract</button>
          <Link className="btn btn-sm" to="/forms">My Forms</Link>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="status-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`status-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Form</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">--ALL--</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Department</label>
            <select value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">--ALL--</option>
              {department && !departments.includes(department) && <option value={department}>{department}</option>}
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Date Submitted</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={range.mode} onChange={(e) => setRange({ ...range, mode: e.target.value })} style={{ flex: '0 0 120px' }}>
                <option value="as_of">As of</option>
                <option value="period">Period from</option>
              </select>
              {range.mode === 'period' && (
                <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="Submitted from" />
              )}
              <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })}
                aria-label={range.mode === 'period' ? 'Submitted to' : 'Submitted as of'} />
              {(range.from || range.to) && (
                <button type="button" className="btn btn-sm" title="Clear the dates" onClick={() => setRange(EMPTY_RANGE)}>×</button>
              )}
            </div>
          </div>
          <div className="field">
            <label>Search</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="REQ #, name or department..." />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>REQ #</th>
                  <th>Form</th>
                  <th>Filed By</th>
                  <th>Department</th>
                  <th>Submitted</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    {rows.length ? 'Nothing matches.' : 'Nothing here.'}
                  </td></tr>
                )}
                {pageRows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="REQ #">{r.request_no}</td>
                    <td data-label="Form">{TYPE_LABELS[r.type] || pretty(r.type)}</td>
                    <td data-label="Filed By">{r.owner_name || '—'}</td>
                    <td data-label="Department">{r.department || '—'}</td>
                    <td data-label="Submitted">{fmtDate(r.submitted_at)}</td>
                    <td data-label="Amount">{NO_ITEM_TYPES.includes(r.type) ? '—' : money(r.total_amount)}</td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{r.status === 'noted' && Number(r.waiting_pre_approval) ? 'For Pre-Approval' : r.direct_approval ? 'For Approval' : statusLabel(r.status)}</span>
                      {releaseLabel(r.release_status) && <span className={`badge ${releaseBadge(r.release_status)}`} style={{ marginLeft: 4 }}>{releaseLabel(r.release_status)}</span>}
                    </td>
                    <td>
                      <Link className="btn btn-sm btn-primary" to={`/forms/${r.id}`}>Review</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                {(Math.min(page, totalPages) - 1) * PAGE_SIZE + 1}–{Math.min(Math.min(page, totalPages) * PAGE_SIZE, shown.length)} of {shown.length.toLocaleString()} forms
              </div>
            )}
            {totalPages > 1 && <Pagination page={Math.min(page, totalPages)} totalPages={totalPages} onChange={setPage} />}
          </div>
        )}
      </div>
    </div>
  );
}
