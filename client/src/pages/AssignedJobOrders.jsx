import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Artist's personal worklist, covering the whole of their involvement rather than only the
// part still in their hands: work not yet begun, work under way or paused, work sent to
// Sales, and work Sales has signed off -- which is the point the incentive is earned. The
// tabs separate those four. This is an index only; Play/Hold/Stop and the live countdown
// happen on the per-JO run screen (AssignedJobOrderRun.jsx), not here.
function formatDateTime(v) {
  return v ? new Date(v).toLocaleString() : '—';
}

// A Non-Standard Job Order with no priced materials lines yet legitimately earns nothing,
// so 0 is shown as 0.00 rather than a dash -- a dash would read as "not calculated".
function formatIncentive(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

// The four stages of the artist's involvement, in the order the work moves through them.
// Stage is read from sub_status and the timer together, because the two answer different
// questions: sub_status says whose hands the order is in, the timer says how far the
// artist got with it.
const STAGES = [
  { key: 'not_started', label: 'Not Started' },
  { key: 'in_progress', label: 'Started / On Hold' },
  { key: 'sales_approval', label: 'Sales Approval' },
  { key: 'approved', label: 'Approved / Completed' },
];

function stageOf(row) {
  if (row.sub_status === 'Approved' || row.status === 'COMPLETED') return 'approved';
  if (row.sub_status === 'Sales Approval') return 'sales_approval';
  // Still with the artist: which side of the timer they are on decides the tab. A finished
  // timer that has not been sent for approval yet still belongs here -- the order is theirs
  // until they hand it over.
  return row.layout_started_at ? 'in_progress' : 'not_started';
}

function timerStatus(row) {
  if (row.layout_ended_at) return 'Completed';
  if (row.is_running) return 'Running';
  if (row.layout_started_at) return 'Held';
  return 'Not Started';
}

export default function AssignedJobOrders() {
  const navigate = useNavigate();
  const [stage, setStage] = useState('not_started');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/assigned-jo');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Counted from every row, not from the filtered set, so each tab keeps showing its own
  // total while another one is selected.
  const counts = STAGES.reduce((acc, t) => ({ ...acc, [t.key]: rows.filter((r) => stageOf(r) === t.key).length }), {});
  const stageRows = rows.filter((r) => stageOf(r) === stage);
  const totalPages = Math.max(1, Math.ceil(stageRows.length / PAGE_SIZE));
  const pageRows = stageRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function pickStage(key) {
    setStage(key);
    setPage(1);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Assigned JO</h1>
      </div>

      <div className="status-tabs">
        {STAGES.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${stage === t.key ? 'active' : ''}`}
            onClick={() => pickStage(t.key)}
          >
            {t.label} <span className="badge badge-muted">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>JO #</th>
                  <th>Customer</th>
                  <th>Job Desc.</th>
                  <th>Sub Status</th>
                  <th>Layout - Job Type</th>
                  <th>Minutes Consume</th>
                  <th>Incentive</th>
                  <th>Planned Start</th>
                  <th>Planned End</th>
                  <th>Timer Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing in {(STAGES.find((t) => t.key === stage) || {}).label}.</td></tr>
                )}
                {/* Job Orders and Non-Standard Job Orders have independent id sequences,
                    so the key has to include the kind or the two can collide. */}
                {pageRows.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td>{row.job_order_no}</td>
                    <td>{row.customer_name}</td>
                    <td>{row.description}</td>
                    <td>{row.sub_status}</td>
                    <td>{row.pms_job_type_name ? `${row.pms_job_type_code} — ${row.pms_job_type_name}` : '—'}</td>
                    <td>{row.minutes_consume ?? 0} mins</td>
                    {/* Amount first, then what it is made of -- a flat 7.50 per layout on a
                        Job Order, 5% of each materials line on a Non-Standard one. */}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {formatIncentive(row.incentive_amount)}
                      {row.incentive_basis && <div className="muted" style={{ fontSize: '0.85em' }}>{row.incentive_basis}</div>}
                    </td>
                    <td>{formatDateTime(row.planned_start_at)}</td>
                    <td>{formatDateTime(row.planned_end_at)}</td>
                    <td>{timerStatus(row)}</td>
                    <td><button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(row.kind === 'NSTDJO' ? `/assigned-jo/nstdjo/${row.id}` : `/assigned-jo/${row.id}`)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
