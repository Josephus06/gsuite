import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import NonStandardJobOrderFormModal from '../components/NonStandardJobOrderFormModal';

const ROUTE = '/non-standard-job-orders';
const CANCELLED = 'Cancelled';
// Sub Status is what advances through the design stage -- Status stays "Planned -
// Pending for BOM" throughout. An order sitting on "For Design Supervisor" is waiting
// for an artist; "For Artist" means one is assigned and layout is under way.
const SUB_PENDING = 'Pending';
const SUB_SBU_APPROVAL = 'SBU Approval';
// Bounced back by an approver. Sales can edit freely here; saving returns it to approval.
const SUB_SALES_REVISION = 'Sales Revision';
// Approved but not yet handed over -- this is where Forward becomes available. Pending
// covers orders whose department has no approvers, so there was never a gate to clear.
const SUB_SBU_APPROVED = 'SBU Approved';
const FORWARDABLE = [SUB_PENDING, SUB_SBU_APPROVED];
const SUB_FOR_DESIGN = 'For Design Supervisor';
const SUB_FOR_ARTIST = 'For Artist';
// The artist's finished layout waiting on Sales. Signing it off completes the order --
// a Non-Standard Job Order has nothing downstream of the layout.
const SUB_SALES_APPROVAL = 'Sales Approval';

// Mirrors the Materials grid on the form, minus the two lookup pickers -- a saved line
// shows the resolved Process and Item names instead.
const MATERIAL_COLUMNS = [
  { key: 'process_name', label: 'Process' },
  { key: 'process_qty', label: 'Qty' },
  { key: 'item_name', label: 'Item' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' },
  { key: 'qty', label: 'Qty' },
  { key: 'uom', label: 'UOM' },
  { key: 'total', label: 'Total' },
  { key: 'unit', label: 'Unit' },
  { key: 'process_price', label: 'Process Price' },
  { key: 'artist_incentive', label: 'Artist Incentive' },
  { key: 'artist_remarks', label: 'Artist Remarks' },
  { key: 'sales_remarks', label: 'Sales Remarks' },
];

const date = (value) => (value ? String(value).slice(0, 10) : '');
// A blank field reads as "-" here rather than as an empty gap, matching the live view.
const show = (value) => (value === null || value === undefined || value === '' ? '-' : value);

export default function NonStandardJobOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [order, setOrder] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [pmsJobTypes, setPmsJobTypes] = useState([]);
  const [artists, setArtists] = useState([]);
  const [tab, setTab] = useState('processes');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignForm, setAssignForm] = useState({ layout_job_type_id: '', artist_employee_id: '', layout_qty: 1, planned_start_at: '' });
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionRemarks, setRevisionRemarks] = useState('');
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get(`${ROUTE}/${id}`);
    setOrder(data);
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get(`${ROUTE}/meta`).then(({ data }) => setPmsJobTypes(data.pmsJobTypes)); }, []);
  useEffect(() => {
    if (tab === 'system') api.get(`${ROUTE}/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
  }, [tab, id]);

  async function act(path, method = 'post') {
    setBusy(true);
    setError('');
    try {
      await api[method](`${ROUTE}/${id}/${path}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete that action.');
    } finally {
      setBusy(false);
    }
  }

  // Sales already chose a PMS Job Type at creation, so the Layout - Job Type starts from
  // that rather than blank -- the supervisor only touches it when they want a different
  // one. Reassigning likewise reopens on the current values, so swapping just the artist
  // doesn't mean re-entering the rest.
  function openAssign() {
    setAssignForm({
      layout_job_type_id: order.layout_job_type_id || order.pms_job_type_id || '',
      artist_employee_id: order.artist_employee_id || '',
      layout_qty: order.layout_qty || 1,
      planned_start_at: order.planned_start_at ? String(order.planned_start_at).slice(0, 16).replace(' ', 'T') : '',
    });
    setError('');
    setAssignOpen(true);
    if (artists.length === 0) {
      api.get('/employees', { params: { account_type: 'Artist' } }).then(({ data }) => setArtists(data));
    }
  }

  async function requestRevision() {
    setBusy(true);
    setError('');
    try {
      await api.put(`${ROUTE}/${id}/request-revision`, { remarks: revisionRemarks });
      setRevisionOpen(false);
      setRevisionRemarks('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send this job order back for revision.');
    } finally {
      setBusy(false);
    }
  }

  async function assignArtist(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put(`${ROUTE}/${id}/assign-artist`, assignForm);
      setAssignOpen(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not assign the artist.');
    } finally {
      setBusy(false);
    }
  }

  // Same cascade the creation form applies: only PMS job types belonging to this order's
  // job type. (CUTTING LIST has none, so that list is legitimately empty -- the server
  // treats Layout - Job Type as optional for exactly that reason.)
  //
  // The currently-selected job type is seeded from the order's own detail payload rather
  // than waited for from /meta. EntityPicker renders its label by looking the value up in
  // `items`, so before /meta lands that list is empty and the pre-filled Layout - Job Type
  // renders blank -- it reads as "nothing was pre-filled" even though the id is set and
  // would save correctly. Seeding it makes the selection visible immediately; the real
  // /meta entry takes over as soon as it arrives.
  const layoutJobTypes = useMemo(() => {
    if (!order) return [];
    const list = pmsJobTypes.filter((jobType) => String(jobType.job_type_id) === String(order.job_type_id));
    const selectedId = assignForm.layout_job_type_id;
    if (!selectedId || list.some((jobType) => String(jobType.id) === String(selectedId))) return list;
    const isLayout = String(order.layout_job_type_id) === String(selectedId);
    return [{
      id: selectedId,
      job_type_id: order.job_type_id,
      code: isLayout ? order.layout_job_type_code : order.pms_job_type_code,
      display_name: isLayout ? order.layout_job_type_name : order.pms_job_type_name,
      minutes_consume: isLayout ? order.layout_job_type_minutes : order.pms_job_type_minutes,
    }, ...list];
  }, [pmsJobTypes, order, assignForm.layout_job_type_id]);

  if (!order) return <LoadingSpinner />;

  const canEdit = can(ROUTE, 'can_edit');
  const isCancelled = order.status === CANCELLED;
  // Nothing moves toward Design until an SBU approver signs off.
  const awaitingApproval = order.sub_status === SUB_SBU_APPROVAL;
  const inRevision = order.sub_status === SUB_SALES_REVISION;
  const canApprove = awaitingApproval && !isCancelled && !!order.is_my_approval;
  // Sales signing off the finished layout -- this is what completes the order.
  const canApproveSales = order.sub_status === SUB_SALES_APPROVAL && !isCancelled && can(ROUTE, 'can_approve');
  // The assigned artist can hand their layout to Sales from here as well as from the
  // Assigned JO run screen -- they may well be looking at the order itself.
  const canSendSalesApproval = order.sub_status === SUB_FOR_ARTIST && !isCancelled && !!order.is_my_assignment;
  // Forward only becomes available once the order is sitting on SBU Approved (or was
  // never gated). Approval unlocks the handoff; pressing Forward is what performs it.
  const sbuCleared = FORWARDABLE.includes(order.sub_status);
  // Editing is open only while an approver has it parked in Sales Revision -- once
  // approved, the details it was signed off against must not shift -- and only to the
  // person who raised it. A supervisor can see a subordinate's order but not change it.
  const canRevise = inRevision && !isCancelled && canEdit && !!order.is_mine;
  // Picking the artist belongs to the Design Supervisor alone -- edit rights on this page
  // (which Sales has) deliberately do not offer it. The server keeps a can_edit fallback
  // so an admin who isn't personally flagged can still unstick an order, but nobody else
  // is shown the control.
  const canAssignArtist = !isCancelled
    && !!user?.is_design_supervisor
    && [SUB_FOR_DESIGN, SUB_FOR_ARTIST].includes(order.sub_status);

  const plannedEnd = (() => {
    const minutes = layoutJobTypes.find((j) => String(j.id) === String(assignForm.layout_job_type_id))?.minutes_consume;
    const qty = Number(assignForm.layout_qty);
    if (!assignForm.planned_start_at || !minutes || !qty) return '';
    return new Date(new Date(assignForm.planned_start_at).getTime() + Number(minutes) * qty * 60 * 1000).toLocaleString();
  })();

  return (
    <div>
      <div className="page-header">
        <h1>{order.job_location_name || 'Head Office'}</h1>
        <div className="spreadsheet-row-actions">
          <button className="btn btn-sm" onClick={() => navigate(ROUTE)}>Back</button>
          {canApprove && <>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('approve', 'put')}>Approve</button>
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setRevisionOpen(true)}>Revision</button>
          </>}
          {canSendSalesApproval && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('sales-approval', 'put')}>Sales Approval</button>
          )}
          {canApproveSales && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('approve-sales', 'put')}>Approve (Sales)</button>
          )}
          {canRevise && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditOpen(true)}>Edit</button>
          )}
          {/* Only once the SBU gate is cleared -- neither while awaiting an approver nor
              while parked with Sales for changes. The server refuses both regardless. */}
          {canEdit && !isCancelled && sbuCleared && !order.forwarded_at && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('forward')}>Forward to Design Supervisor</button>
          )}
          {canAssignArtist && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={openAssign}>
              {order.artist_employee_id ? 'Reassign Artist' : 'Assign Artist'}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>
          {canEdit && !isCancelled && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => act('cancel')}>Cancel</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Non-Standard Job Order</h1>
          <span className="estimate-no">{order.nstdjo_no}</span>
        </div>
        <div className="estimate-status">
          {order.status} <span style={{ opacity: 0.7 }}>{order.sub_status}</span>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer</h4>
            <div className="hi">{order.customer_name}</div>
            <div>Contact Person : <span className="hi">{show(order.contact_person_name)}</span></div>
            <div>Contact Email : <span className="hi">{show(order.contact_email)}</span></div>
            <div>Contact Title : <span className="hi">{show(order.contact_title)}</span></div>
            <div>Contact Phone : <span className="hi">{show(order.contact_phone)}</span></div>
            <div>Memo : <span className="hi">{order.memo || ''}</span></div>
          </div>
          <div>
            <div>Date Created : <span className="hi">{date(order.date_created)}</span></div>
            <div>Delivery Date : <span className="hi">{date(order.delivery_date)}</span></div>
            <div>Delivery Time : <span className="hi">{order.delivery_time || ''}</span></div>
            <div>Sales Division : <span className="hi">{show(order.sales_division_name)}</span></div>
            <div>Sales Rep. : <span className="hi">{show(order.sales_rep_name)}</span></div>
            {order.approver_names && (
              <div>{order.approved_at ? 'Approved By' : 'For Approval By'} : <span className="hi">
                {order.approved_at ? order.approved_by_name : order.approver_names}
              </span></div>
            )}
          </div>
          <div>
            <div>Job Type : <span className="hi">{order.job_type}</span></div>
            <div>Job Desc. : <span className="hi">{order.description}</span></div>
            <div>PMS - Job Type : <span className="hi">{show(order.pms_job_type_name)}</span></div>
            <div>Artist : <span className="hi">{order.artist_name || ''}</span></div>
            {order.artist_employee_id && <>
              <div>Layout - Job Type : <span className="hi">{order.layout_job_type_name || ''}</span></div>
              <div>Layout Qty : <span className="hi">{order.layout_qty ?? 1}</span></div>
              <div>Planned : <span className="hi">{order.planned_start_at ? new Date(order.planned_start_at).toLocaleString() : ''}</span>
                {order.planned_end_at && <> → <span className="hi">{new Date(order.planned_end_at).toLocaleString()}</span></>}</div>
            </>}
            <div>Quantity : <span className="hi">{order.quantity}</span></div>
            <div>{order.job_type === 'SITE INSPECTION' ? 'Site Address' : 'Optional Address'} : <span className="hi">{order.shipping_address || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>Processes</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'processes' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th>{MATERIAL_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {order.materials.length === 0 && (
                  <tr><td colSpan={MATERIAL_COLUMNS.length + 1} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials.</td></tr>
                )}
                {order.materials.map((material, index) => (
                  <tr key={material.id}>
                    <td>{index + 1}</td>
                    {MATERIAL_COLUMNS.map((c) => <td key={c.key}>{material[c.key] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'Date Time', render: (r) => new Date(r.set_at).toLocaleString() },
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

      {revisionOpen && (
        <Modal title="Send Back for Revision" onClose={() => !busy && setRevisionOpen(false)}>
          <div className="field">
            <label>Remarks <span className="muted">(optional — sent to the raiser)</span></label>
            <textarea
              autoFocus rows={4} value={revisionRemarks}
              placeholder="What needs to change before this can be approved?"
              onChange={(event) => setRevisionRemarks(event.target.value)}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setRevisionOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-warning" disabled={busy} onClick={requestRevision}>
              {busy ? 'Sending…' : 'Send for Revision'}
            </button>
          </div>
        </Modal>
      )}

      {editOpen && (
        <NonStandardJobOrderFormModal
          mode="edit"
          order={order}
          onClose={() => setEditOpen(false)}
          onSaved={load}
        />
      )}

      {assignOpen && (
        <Modal title="Assign Layout Job Type / Artist" onClose={() => !busy && setAssignOpen(false)}>
          <form onSubmit={assignArtist}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Layout - Job Type</label>
              <EntityPicker
                label="Layout - Job Type" items={layoutJobTypes} value={assignForm.layout_job_type_id}
                getLabel={(jobType) => jobType.display_name}
                columns={[{ key: 'code', label: 'Code' }, { key: 'display_name', label: 'Display Name' }, { key: 'minutes_consume', label: 'Minutes Consume' }]}
                searchKeys={['code', 'display_name']}
                onSelect={(jobType) => setAssignForm({ ...assignForm, layout_job_type_id: jobType.id })}
              />
            </div>
            <div className="field">
              <label>Artist</label>
              <EntityPicker
                label="Artist" items={artists} value={assignForm.artist_employee_id}
                getLabel={(employee) => `${employee.first_name} ${employee.last_name}`}
                columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }, { key: 'position_title', label: 'Position' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={(employee) => setAssignForm({ ...assignForm, artist_employee_id: employee.id })}
              />
            </div>
            <div className="field">
              <label>Qty</label>
              <input
                type="number" min="0.0001" step="any" required
                value={assignForm.layout_qty}
                onChange={(event) => setAssignForm({ ...assignForm, layout_qty: event.target.value })}
              />
            </div>
            <div className="field">
              <label>Planned Start</label>
              <input
                type="datetime-local" required
                value={assignForm.planned_start_at}
                onChange={(event) => setAssignForm({ ...assignForm, planned_start_at: event.target.value })}
              />
            </div>
            <div className="field">
              <label>Planned End <span className="muted">(auto-computed: Minutes Consume × Qty)</span></label>
              <input readOnly tabIndex={-1} value={plannedEnd} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setAssignOpen(false)}>Close</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
