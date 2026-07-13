import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Deliberately minimal Job Order detail -- mirrors the real system's layout (banner +
// grouped info fields + Processes/RWIP JO/Sub Con/Related Records/System Info tabs +
// Estimated GP footer). RWIP JO (rework-in-progress) and Sub Con (subcontracted
// materials) are shown as empty tables matching the real column headers -- the
// underlying transaction types (rework tracking, subcontract material allocation)
// aren't modeled here, so there's nothing to populate them with yet, same as this
// build has no job execution, quality inspection, delivery, invoicing, or Create TO
// (Transfer Order) functionality either.
const SO_STATUS_LABELS = {
  pending_for_jo: 'Pending for JO',
  jo_in_process: 'JO In-Process',
  pending_delivery: 'Pending Delivery',
  partially_delivered: 'Partially Delivered',
  pending_billing: 'Pending Billing',
  pending_billing_partially_delivered: 'Pending Billing / Partially Delivered',
  billed: 'Billed',
  cancelled: 'Cancelled',
};

// Mirrors ProductionJobOrderView.jsx's STAGE_LABELS -- once a JO is Released and
// tracked by production_stage, that's the more informative "where is it right now"
// signal than sub_status, which only ever meant something pre-Release (the Design/
// Layout approval steps) and otherwise stays frozen at "Approved" forever. Keeping this
// in sync so the same JO shows the same status whether opened from Sales > Job Orders
// or from Production > Production.
const STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.',
  for_revision: 'For Revision',
  in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process',
  for_qi: 'For QI',
  partially_completed: 'Part. Completed',
  completed: 'Completed',
  invoiced: 'Invoiced',
};

const PROCESS_COLUMNS = [
  { key: 'process_name', label: 'Process' },
  { key: 'process_qty', label: 'Process Qty' },
  { key: 'process_uom', label: 'Process UOM' },
  { key: 'item_name', label: 'Item' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' },
  { key: 'uom', label: 'UOM' },
  { key: 'qty', label: 'Qty' },
  { key: 'total', label: 'Total' },
  { key: 'unit', label: 'Unit' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'process_cost', label: 'Process Cost' },
  { key: 'material_cost', label: 'Material Cost' },
  { key: 'total_cost', label: 'Total Cost' },
];

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function JobOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [jo, setJo] = useState(null);
  const [tab, setTab] = useState('processes');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);

  const [showAssign, setShowAssign] = useState(false);
  const [pmsJobTypes, setPmsJobTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [assignForm, setAssignForm] = useState({ layout_job_type_id: '', artist_id: '', planned_start_at: '' });
  const [assignError, setAssignError] = useState('');

  function load() {
    return api.get(`/job-orders/${id}`).then(({ data }) => { setJo(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/job-orders/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleHold() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/hold`); await load(); } finally { setBusy(false); }
  }

  async function handleResume() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/resume`); await load(); } finally { setBusy(false); }
  }

  async function handleForwardToDesign() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/forward-to-design`); await load(); } finally { setBusy(false); }
  }

  function openAssign() {
    setAssignForm({ layout_job_type_id: '', artist_id: '', planned_start_at: '' });
    setAssignError('');
    setShowAssign(true);
    if (pmsJobTypes.length === 0) api.get('/pms-job-types').then(({ data }) => setPmsJobTypes(data));
    if (employees.length === 0) api.get('/employees').then(({ data }) => setEmployees(data));
  }

  async function handleAssignDesign(e) {
    e.preventDefault();
    setAssignError('');
    try {
      await api.put(`/job-orders/${id}/assign-design`, assignForm);
      setShowAssign(false);
      await load();
    } catch (err) {
      setAssignError(err.response?.data?.error || 'Assign failed');
    }
  }

  async function handleSalesApproval() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/sales-approval`); await load(); } finally { setBusy(false); }
  }

  async function handleApproveSales() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/approve-sales`); await load(); } finally { setBusy(false); }
  }

  async function handleRequestRevision() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/request-revision`); await load(); } finally { setBusy(false); }
  }

  if (loading || !jo) return <LoadingSpinner />;

  const canEdit = can('/job-orders', 'can_edit');
  const canApprove = can('/job-orders', 'can_approve');
  const isTerminal = jo.status === 'Completed' || jo.status === 'Cancelled';
  const isOnHold = !!jo.is_on_hold;
  // The artist a JO is assigned to needs to be able to send their own completed layout
  // to Sales for sign-off even without generic can_edit on Job Orders -- they shouldn't
  // need broader edit rights over the JO just to do that one thing.
  const isAssignedArtist = !!user?.employee_id && jo.artist_id === user.employee_id;

  const processes = jo.processes || [];
  const totalCost = processes.reduce((s, p) => s + num(p.total_cost), 0);
  // The Job Order's own Processes tab has no price/discount columns (matching the real
  // system) -- revenue comes from the originating Sales Order line instead, so GP here
  // is that line's net-of-discount amount minus this JO's total process cost.
  const revenue = num(jo.line_subtotal) - num(jo.line_disc_amount);
  const gpAmount = revenue - totalCost;
  const gpRate = revenue ? (gpAmount / revenue) * 100 : 0;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/job-orders')}>Back to Lists</button>
          {canEdit && jo.status !== 'Cancelled' && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/job-orders/${id}/edit`)}>Edit</button>}
          {canEdit && jo.sub_status === 'Pending' && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleForwardToDesign}>Forward to Design Supervisor</button>
          )}
          {canEdit && jo.sub_status === 'For Design Supervisor' && !!user?.is_design_supervisor && (
            <button className="btn btn-sm btn-primary" onClick={openAssign}>Assign Layout Job Type / Artist</button>
          )}
          {(canEdit || isAssignedArtist) && (jo.sub_status === 'For Artist' || jo.sub_status === 'For Artist (Revision)') && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleSalesApproval}>Sales Approval</button>
          )}
          {canApprove && jo.sub_status === 'Sales Approval' && (
            <>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApproveSales}>Approved</button>
              <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleRequestRevision}>For Revision</button>
            </>
          )}
          {canEdit && !isOnHold && !isTerminal && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleHold}>Hold</button>}
          {canEdit && isOnHold && !isTerminal && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleResume}>Resume</button>}
        </div>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Job Order</h1>
          <span className="estimate-no">{jo.job_order_no}</span>
        </div>
        <div className="estimate-status">
          {jo.status} <span style={{ opacity: 0.7 }}>{STAGE_LABELS[jo.production_stage] || jo.sub_status}</span>
          {isOnHold && <span className="estimate-so-link" style={{ background: 'rgba(245, 159, 0, 0.35)' }}>On Hold</span>}
          <button type="button" className="estimate-so-link" onClick={() => navigate(`/sales-orders/${jo.sales_order_id}`)}>
            {jo.sales_order_no}
          </button>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer</h4>
            <div className="hi">{jo.customer_name}</div>
            <div>Contact Person : <span className="hi">{jo.contact_name}</span></div>
            <div>Contact Email : <span className="hi">{jo.contact_email}</span></div>
            <div>Contact Title : <span className="hi">{jo.contact_title}</span></div>
            <div>Contact Phone : <span className="hi">{jo.contact_phone}</span></div>
          </div>
          <div>
            <div>JO # : <span className="hi">{jo.job_order_no}</span></div>
            <div>Date Created : <span className="hi">{jo.created_at ? String(jo.created_at).slice(0, 10) : ''}</span></div>
            <div>Office Location : <span className="hi">{jo.office_location_name}</span></div>
            <div>Sales Division : <span className="hi">{jo.sales_division_name}</span></div>
            <div>Shipping Address : <span className="hi">{jo.shipping_address}</span></div>
            <div>Sales Rep. : <span className="hi">{jo.sales_rep_name}</span></div>
          </div>
          <div>
            <div>Job Location : <span className="hi">{jo.job_location_name}</span></div>
            <div>Job Type : <span className="hi">{jo.job_type_name}</span></div>
            <div>Job Desc. : <span className="hi">{jo.description}</span></div>
            <div>Layout - Job Type : <span className="hi">{jo.layout_job_type_name}</span></div>
            <div>Artist : <span className="hi">{jo.artist_name}</span></div>
            <div>Qty : <span className="hi">{jo.quantity} {jo.units}</span> Qty Built: <span className="hi">{jo.quantity_built} {jo.units}</span> Qty Inspected: <span className="hi">{jo.quantity_inspected} {jo.units}</span></div>
            <div>Length : <span className="hi">{jo.length ?? 0}</span> Width : <span className="hi">{jo.width ?? 0}</span> Height : <span className="hi">{jo.height ?? ''}</span></div>
            <div>Memo : <span className="hi">{jo.memo}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>Processes</button>
        <button className={`status-tab ${tab === 'rwip' ? 'active' : ''}`} onClick={() => setTab('rwip')}>RWIP JO</button>
        <button className={`status-tab ${tab === 'subcon' ? 'active' : ''}`} onClick={() => setTab('subcon')}>Sub Con</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'processes' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th>{PROCESS_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {processes.length === 0 && (
                  <tr><td colSpan={PROCESS_COLUMNS.length + 1} className="muted" style={{ textAlign: 'center', padding: 20 }}>No processes.</td></tr>
                )}
                {processes.map((p, idx) => (
                  <tr key={p.id}>
                    <td>{idx + 1}</td>
                    {PROCESS_COLUMNS.map((c) => <td key={c.key}>{c.key.endsWith('cost') ? money(p[c.key]) : p[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'rwip' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Transaction #</th><th>Qty</th><th>Unit</th><th>Status</th></tr></thead>
              <tbody>
                <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No RWIP transactions.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'subcon' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item Code</th><th>Description</th></tr></thead>
              <tbody>
                <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No subcontracted materials.</td></tr>
              </tbody>
            </table>
          </div>
          <button type="button" className="btn" style={{ marginTop: 12 }} disabled>Add Material</button>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Transaction #</th><th>Qty</th><th>Unit</th><th>Status</th></tr></thead>
              <tbody>
                <tr>
                  <td>{jo.created_at ? String(jo.created_at).slice(0, 10) : ''}</td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${jo.sales_order_id}`)}>
                      {jo.sales_order_no}
                    </button>
                  </td>
                  <td>0.00</td>
                  <td></td>
                  <td>{SO_STATUS_LABELS[jo.sales_order_status] || jo.sales_order_status}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => new Date(r.set_at).toLocaleString() },
              { key: 'set_by_name', label: 'Set By' },
              { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' },
              { key: 'old_value', label: 'Old Value' },
              { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}

      <div className="estimate-footer card">
        <div><span className="muted">Estimated GP Rate</span><div className="hi-lg">{gpRate.toFixed(2)}%</div></div>
        <div><span className="muted">Estimated GP Amount</span><div className="hi-lg">{money(gpAmount)}</div></div>
      </div>

      {showAssign && (
        <Modal title="Assign Layout Job Type / Artist" onClose={() => setShowAssign(false)}>
          <form onSubmit={handleAssignDesign}>
            {assignError && <div className="error-banner">{assignError}</div>}
            <div className="field">
              <label>Layout - Job Type</label>
              <EntityPicker
                label="Layout - Job Type" items={pmsJobTypes} value={assignForm.layout_job_type_id} getLabel={(p) => p.display_name}
                columns={[{ key: 'code', label: 'Code' }, { key: 'display_name', label: 'Display Name' }, { key: 'minutes_consume', label: 'Minutes Consume' }]}
                searchKeys={['code', 'display_name']}
                onSelect={(p) => setAssignForm({ ...assignForm, layout_job_type_id: p.id })}
              />
            </div>
            <div className="field">
              <label>Artist</label>
              <EntityPicker
                label="Artist" items={employees} value={assignForm.artist_id} getLabel={(e) => `${e.first_name} ${e.last_name}`}
                columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }, { key: 'position_title', label: 'Position' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={(e) => setAssignForm({ ...assignForm, artist_id: e.id })}
              />
            </div>
            <div className="field">
              <label>Planned Start</label>
              <input
                type="datetime-local" required
                value={assignForm.planned_start_at}
                onChange={(e) => setAssignForm({ ...assignForm, planned_start_at: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Planned End <span className="muted">(auto-computed)</span></label>
              <input readOnly tabIndex={-1} value={(() => {
                const minutes = pmsJobTypes.find((p) => p.id === Number(assignForm.layout_job_type_id))?.minutes_consume;
                if (!assignForm.planned_start_at || !minutes) return '';
                const end = new Date(new Date(assignForm.planned_start_at).getTime() + Number(minutes) * 60 * 1000);
                return end.toLocaleString();
              })()} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setShowAssign(false)}>Close</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
