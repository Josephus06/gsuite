import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

const STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed' };
const STATUS_BADGE = { open: 'badge-info', in_progress: 'badge-muted', resolved: 'badge-success', closed: 'badge-success' };

function formatDate(v) {
  return v ? new Date(v).toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

// Regular users mostly work through the floating chat widget (ChatWidget.jsx) rather
// than this page -- this is the queue view for department heads (departments.head_user_id,
// server/src/lib/ticketVisibility.js) to see, assign, and resolve what's routed to them.
// GET /tickets already scopes rows to what the viewer is allowed to see, so no extra
// client-side filtering is needed for visibility -- only for which action buttons to offer.
export default function Tickets() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [usersByDept, setUsersByDept] = useState({});
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  const headDepartmentIds = useMemo(
    () => new Set(departments.filter((d) => d.head_user_id === user?.id).map((d) => d.id)),
    [departments, user]
  );
  const isSystemAdminHead = useMemo(
    () => departments.some((d) => d.name === 'System Admin' && d.head_user_id === user?.id),
    [departments, user]
  );

  async function load() {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    const [t, d] = await Promise.all([
      api.get('/tickets', { params }),
      api.get('/tickets/meta/departments'),
    ]);
    setRows(t.data);
    setDepartments(d.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  function canManage(row) {
    return isSystemAdminHead || headDepartmentIds.has(row.department_id);
  }

  // A supervisor can only assign within their own department, not org-wide (see
  // server/src/routes/tickets.js's /meta/assignable-users). A System Admin head's
  // queue can span several departments, so this fetches per-department, once each,
  // for every department that actually appears among the manageable rows.
  useEffect(() => {
    const deptIds = [...new Set(rows.filter(canManage).map((r) => r.department_id))]
      .filter((id) => !(id in usersByDept));
    if (!deptIds.length) return;
    Promise.all(deptIds.map((id) => api.get('/tickets/meta/assignable-users', { params: { department_id: id } }).then(({ data }) => [id, data])))
      .then((pairs) => setUsersByDept((prev) => ({ ...prev, ...Object.fromEntries(pairs) })))
      .catch(() => {});
  }, [rows, headDepartmentIds, isSystemAdminHead]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAssign(row, assignee) {
    try {
      await api.put(`/tickets/${row.id}/assign`, { assigned_to_user_id: assignee.id });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Assign failed');
    }
  }

  async function handleResolve(row) {
    try {
      await api.put(`/tickets/${row.id}/status`, { status: 'resolved' });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Update failed');
    }
  }

  async function handleApprove(row) {
    try {
      await api.put(`/tickets/${row.id}/approve`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Approve failed');
    }
  }

  async function handleForward(row) {
    if (!confirm(`Forward ${row.ticket_no} to the General Manager for approval? It won't be assignable until they sign off.`)) return;
    try {
      await api.put(`/tickets/${row.id}/forward-to-gm`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Forward failed');
    }
  }

  async function handleGmApprove(row) {
    try {
      await api.put(`/tickets/${row.id}/gm-approve`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Approve failed');
    }
  }

  function isPending(row) {
    return !!row.approver_names && !row.approved_at;
  }

  function isGmPending(row) {
    return !!row.forwarded_to_gm_at && !row.gm_approved_at;
  }

  function isBlocked(row) {
    return isPending(row) || isGmPending(row);
  }

  const columns = [
    { key: 'ticket_no', label: 'Ticket #' },
    { key: 'department_name', label: 'Department' },
    { key: 'subject', label: 'Subject' },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <>
          <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{STATUS_LABELS[r.status] || r.status}</span>
          {isPending(r) && <span className="badge badge-danger" style={{ marginLeft: 6 }} title={`Awaiting: ${r.approver_names}`}>Pending Approval</span>}
          {isGmPending(r) && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Pending GM Approval</span>}
        </>
      ),
    },
    { key: 'created_by_name', label: 'Requested By', render: (r) => r.created_by_name || '—' },
    { key: 'assigned_to_name', label: 'Assigned To', render: (r) => r.assigned_to_name || '—' },
    { key: 'created_at', label: 'Created', render: (r) => formatDate(r.created_at) },
  ];

  async function handleDownloadReport() {
    try {
      const res = await api.get('/reports/tickets?format=csv', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ticket-report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to download report');
    }
  }

  async function handleShowSummary() {
    try {
      const res = await api.get('/reports/tickets');
      const { summary } = res.data;
      alert(`Total tickets: ${summary.total}\nResolved: ${summary.resolved}\nUnresolved: ${summary.unresolved}`);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to fetch summary');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Tickets</h1>
      </div>

      <div className="status-tabs">
        <button className={`status-tab ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}>All</button>
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <button key={key} className={`status-tab ${status === key ? 'active' : ''}`} onClick={() => setStatus(key)}>{label}</button>
        ))}
        <button className="status-tab" onClick={() => navigate('/reports/ticket-summary')}>Ticket Summary</button>
        <button className="status-tab" onClick={handleDownloadReport}>Download CSV</button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            emptyLabel="No tickets yet."
            actions={(row) => (
              <>
                <button className="btn btn-sm" onClick={() => navigate(`/tickets/${row.id}`)}>View</button>
                {row.is_my_approval && !row.approved_at && (
                  <button className="btn btn-sm btn-primary" onClick={() => handleApprove(row)}>Approve</button>
                )}
                {row.is_gm && isGmPending(row) && (
                  <button className="btn btn-sm btn-primary" onClick={() => handleGmApprove(row)}>GM Approve</button>
                )}
                {canManage(row) && !isBlocked(row) && (
                  <EntityPicker
                    label="Assign To" items={usersByDept[row.department_id] || []} value={row.assigned_to_user_id}
                    getLabel={(u) => u?.display_name}
                    columns={[{ key: 'display_name', label: 'Name' }, { key: 'username', label: 'Username' }]}
                    searchKeys={['display_name', 'username']}
                    onSelect={(u) => handleAssign(row, u)}
                    triggerLabel="Assign"
                    triggerClassName="btn btn-sm"
                  />
                )}
                {canManage(row) && !row.assigned_to_user_id && !row.forwarded_to_gm_at && (
                  <button className="btn btn-sm" onClick={() => handleForward(row)}>Forward to GM</button>
                )}
                {!isBlocked(row) && (canManage(row) || row.assigned_to_user_id === user?.id) && row.status !== 'resolved' && row.status !== 'closed' && (
                  <button className="btn btn-sm btn-primary" onClick={() => handleResolve(row)}>Resolve</button>
                )}
              </>
            )}
          />
        )}
      </div>
    </div>
  );
}
