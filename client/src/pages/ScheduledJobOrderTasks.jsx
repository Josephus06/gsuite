import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// A department supervisor's scheduling screen for one in-process Job Order: assign a
// production employee to each task (process line), matching the real system's Scheduled
// JO detail layout. Read-only info about cost/qty/material is shown for context; the
// only thing editable here is Assigned To. Running the actual clock happens on the
// assignee's own run screen (ScheduledJobOrderRun.jsx), reachable per row via Open.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function taskStatus(t) {
  if (t.assignment_ended_at) return 'Completed';
  if (t.is_running) return 'Running';
  if (t.assignment_started_at) return 'Held';
  if (t.assigned_employee_id) return 'Assigned';
  return 'New';
}
const STATUS_CLASS = {
  New: 'badge-muted',
  Assigned: 'badge-muted',
  Running: 'badge-success',
  Held: 'badge-muted',
  Completed: 'badge-success',
};

export default function ScheduledJobOrderTasks() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [jo, setJo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);

  function load() {
    return api.get(`/scheduled-jo/${id}`).then(({ data }) => { setJo(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    api.get('/scheduled-jo/production-employees').then(({ data }) => setEmployees(data));
  }, []);

  async function assignEmployee(processId, employeeId) {
    await api.put(`/scheduled-jo/${id}/tasks/${processId}/assign`, { employee_id: employeeId });
    await load();
  }

  if (loading || !jo) return <LoadingSpinner />;

  const tasks = jo.tasks || [];

  return (
    <div>
      <div className="page-header">
        <h1>Scheduled JO — {jo.job_order_no}</h1>
        <button className="btn btn-sm" onClick={() => navigate('/scheduled-jo')}>Back to Scheduled JO</button>
      </div>

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="item"><div className="label">Customer</div><div className="value">{jo.customer_name}</div></div>
          <div className="item"><div className="label">Job Desc.</div><div className="value">{jo.description}</div></div>
          <div className="item"><div className="label">Qty</div><div className="value">{jo.quantity} {jo.units}</div></div>
          <div className="item"><div className="label">Job Location</div><div className="value">{jo.job_location_name}</div></div>
          <div className="item"><div className="label">Delivery Date</div><div className="value">{jo.delivery_date ? String(jo.delivery_date).slice(0, 10) : ''}</div></div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Task</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Location</th>
                <th>Task</th>
                <th>Qty</th>
                <th>Material</th>
                <th>Process Cost</th>
                <th>Material Cost</th>
                <th>Assigned To</th>
                <th>Required Time</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No tasks on this Job Order.</td></tr>
              )}
              {tasks.map((t, idx) => {
                const status = taskStatus(t);
                return (
                  <tr key={t.id}>
                    <td>{idx + 1}</td>
                    <td>{t.location_name}</td>
                    <td>{t.process_name}</td>
                    <td>{t.qty}</td>
                    <td>{t.item_name}</td>
                    <td>{money(t.process_cost)}</td>
                    <td>{money(t.material_cost)}</td>
                    <td style={{ minWidth: 160 }}>
                      <EntityPicker
                        label="Assigned To" items={employees} value={t.assigned_employee_id}
                        getLabel={(e) => `${e.first_name} ${e.last_name}`}
                        columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }, { key: 'department_name', label: 'Department' }]}
                        searchKeys={['first_name', 'last_name']}
                        placeholder="Unassigned"
                        onSelect={(e) => assignEmployee(t.id, e.id)}
                      />
                    </td>
                    <td>{Number(t.allotted_minutes || 0).toFixed(0)} mins</td>
                    <td><span className={`badge ${STATUS_CLASS[status]}`}>{status}</span></td>
                    <td><button type="button" className="btn btn-sm" onClick={() => navigate(`/scheduled-jo/process/${t.id}`)}>Open</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
