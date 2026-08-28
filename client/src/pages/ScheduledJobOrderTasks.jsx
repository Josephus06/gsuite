import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// A department supervisor's scheduling screen for one in-process Job Order: assign a
// production employee to each task (process line) and plan when each one runs, matching the
// real system's Scheduled JO detail layout. Read-only info about cost/qty/material is shown
// for context.
//
// The two editable things here are scoped differently on purpose:
//   - Assigned To, only on the lines worked at this user's own warehouse. A line belonging to
//     another warehouse (a Design or LFP line on a SIGN job) is shown with whoever holds it but
//     no picker: that department's scheduler staffs it, and the server refuses the assignment
//     anyway. can_assign comes from the API, which knows the user's scope.
//   - Planned Start/End, on EVERY line of the job regardless of where it is worked. Sequencing
//     the whole order is the planner's job -- a SIGN line waiting on a Design layout is the
//     dependency they are planning around -- so gating dates by warehouse would leave them
//     unable to plan the very lines they are planning against. can_schedule is per-user, not
//     per-line.
// assignee's own run screen (ScheduledJobOrderRun.jsx), reachable per row via Open.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
// DATE columns come back as plain 'YYYY-MM-DD' strings (the pool sets dateStrings), which is
// already what <input type="date"> wants -- no Date object in between, so nothing can shift a
// day across a timezone on the way to the field.
const day = (v) => (v ? String(v).slice(0, 10) : '');
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
  const [error, setError] = useState('');

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

  // One field at a time: the request carries only the date that changed, so setting Start
  // never disturbs a stored End (the server keeps whatever it isn't told about). A rejected
  // date -- End before Start -- reloads, putting the row back to what is actually saved
  // rather than leaving the input showing a value the server refused.
  async function setPlannedDate(processId, field, value) {
    setError('');
    try {
      await api.put(`/scheduled-jo/${id}/tasks/${processId}/planned-dates`, { [field]: value });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that date.');
    }
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
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
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
                <th>Planned Start</th>
                <th>Planned End</th>
                <th>Required Time</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>No tasks on this Job Order.</td></tr>
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
                      {t.can_assign ? (
                        <EntityPicker
                          label="Assigned To" items={employees} value={t.assigned_employee_id}
                          getLabel={(e) => `${e.first_name} ${e.last_name}`}
                          columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }, { key: 'department_name', label: 'Department' }]}
                          searchKeys={['first_name', 'last_name']}
                          placeholder="Unassigned"
                          onSelect={(e) => assignEmployee(t.id, e.id)}
                        />
                      ) : (
                        <span className="muted" title={`Staffed by ${t.location_name}`}>
                          {t.assigned_employee_name || 'Unassigned'}
                        </span>
                      )}
                    </td>
                    {/* Editable on every line, not just this warehouse's -- see the note at
                        the top of this file. min on Planned End is the same guard the server
                        enforces, kept here only so the calendar itself steers away from it. */}
                    <td>
                      {jo.can_schedule ? (
                        <input
                          type="date" value={day(t.planned_start_date)}
                          onChange={(e) => setPlannedDate(t.id, 'planned_start_date', e.target.value)}
                        />
                      ) : (day(t.planned_start_date) || <span className="muted">—</span>)}
                    </td>
                    <td>
                      {jo.can_schedule ? (
                        <input
                          type="date" value={day(t.planned_end_date)} min={day(t.planned_start_date) || undefined}
                          onChange={(e) => setPlannedDate(t.id, 'planned_end_date', e.target.value)}
                        />
                      ) : (day(t.planned_end_date) || <span className="muted">—</span>)}
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
