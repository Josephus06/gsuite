import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Artist's personal worklist: every JO currently assigned to them (Sub Status "For
// Artist" / "For Artist (Revision)"). This is an index only -- Play/Hold/Stop and the
// live countdown happen on the per-JO run screen (AssignedJobOrderRun.jsx), not here.
function formatDateTime(v) {
  return v ? new Date(v).toLocaleString() : '—';
}

function timerStatus(row) {
  if (row.layout_ended_at) return 'Completed';
  if (row.is_running) return 'Running';
  if (row.layout_started_at) return 'Held';
  return 'Not Started';
}

export default function AssignedJobOrders() {
  const navigate = useNavigate();
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

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Assigned JO</h1>
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
                  <th>Planned Start</th>
                  <th>Planned End</th>
                  <th>Timer Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Job Orders assigned to you right now.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.job_order_no}</td>
                    <td>{row.customer_name}</td>
                    <td>{row.description}</td>
                    <td>{row.sub_status}</td>
                    <td>{row.pms_job_type_name ? `${row.pms_job_type_code} — ${row.pms_job_type_name}` : '—'}</td>
                    <td>{row.minutes_consume ?? 0} mins</td>
                    <td>{formatDateTime(row.planned_start_at)}</td>
                    <td>{formatDateTime(row.planned_end_at)}</td>
                    <td>{timerStatus(row)}</td>
                    <td><button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/assigned-jo/${row.id}`)}>Open</button></td>
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
