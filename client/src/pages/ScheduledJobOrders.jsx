import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Two audiences share this one screen. A production employee gets their own personal
// task worklist (mode: 'tasks') -- every process line assigned to them, opening straight
// to their Play/Hold/Stop run screen. Anyone else with access (a department supervisor,
// admin) isn't themselves a valid assignee, so they instead see every currently
// in-process Job Order (mode: 'jobs') -- opening one goes to that JO's Task table to
// assign staff per process line, matching the real system's Scheduled JO screen.
function timerStatus(row) {
  if (row.assignment_ended_at) return 'Completed';
  if (row.is_running) return 'Running';
  if (row.assignment_started_at) return 'Held';
  return 'Not Started';
}

export default function ScheduledJobOrders() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('jobs');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/scheduled-jo');
    setMode(data.mode);
    setRows(data.rows);
    setPage(1);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Scheduled JO</h1>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : mode === 'jobs' ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>JO #</th>
                  <th>Customer</th>
                  <th>Job Desc.</th>
                  <th>Qty</th>
                  <th>Job Location</th>
                  <th>Delivery Date</th>
                  <th>Tasks Assigned</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Job Orders currently In-Process.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.job_order_no}</td>
                    <td>{row.customer_name}</td>
                    <td>{row.description}</td>
                    <td>{row.quantity} {row.units}</td>
                    <td>{row.job_location_name}</td>
                    <td>{row.delivery_date ? String(row.delivery_date).slice(0, 10) : ''}</td>
                    <td>{row.assigned_count} / {row.task_count}</td>
                    <td><button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/scheduled-jo/${row.id}`)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>JO #</th>
                  <th>Customer</th>
                  <th>Job Desc.</th>
                  <th>Process</th>
                  <th>Total</th>
                  <th>Minutes / Unit</th>
                  <th>Allotted Minutes</th>
                  <th>Timer Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No processes assigned to you right now.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.job_order_no}</td>
                    <td>{row.customer_name}</td>
                    <td>{row.description}</td>
                    <td>{row.process_name}</td>
                    <td>{row.total}</td>
                    <td>{row.minutes_per_unit ?? 0}</td>
                    <td>{Number(row.allotted_minutes || 0).toFixed(0)} mins</td>
                    <td>{timerStatus(row)}</td>
                    <td><button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/scheduled-jo/process/${row.id}`)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </div>
        )}
      </div>
    </div>
  );
}
