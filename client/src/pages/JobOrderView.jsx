import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import JobOrderAttachments, { ARTIST_KINDS } from '../components/JobOrderAttachments';
import RevisionNotice from '../components/RevisionNotice';
import { maySalesRevise, mayReworkJobOrder, awaitingDateDecision } from '../utils/salesRevision';
import { isAdvanceCopy, canForwardAdvanceCopy } from '../utils/advanceCopy';

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

  // Kept on the page rather than inside the tab: the tab label shows the count and the Sales
  // Approval button is disabled without one, and neither can wait for the tab to be opened.
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [actionError, setActionError] = useState('');

  const [showAssign, setShowAssign] = useState(false);
  const [pmsJobTypes, setPmsJobTypes] = useState([]);
  const [artists, setArtists] = useState([]);
  const [assignForm, setAssignForm] = useState({ layout_job_type_id: '', artist_id: '', planned_start_at: '', layout_qty: 1 });
  const [assignError, setAssignError] = useState('');

  function load() {
    return api.get(`/job-orders/${id}`).then(({ data }) => { setJo(data); setLoading(false); });
  }

  function loadAttachmentCount() {
    return api.get(`/job-orders/${id}/attachments`)
      .then(({ data }) => setAttachmentCount(data.length))
      .catch(() => setAttachmentCount(0));
  }

  useEffect(() => { load(); loadAttachmentCount(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Reassigning starts from the current values (not a blank form) so a design
    // supervisor swapping the artist doesn't have to re-enter the Layout - Job Type/Qty/
    // Planned Start too when only the artist itself needs to change.
    setAssignForm({
      layout_job_type_id: jo.layout_job_type_id || '',
      artist_id: jo.artist_id || '',
      planned_start_at: jo.planned_start_at ? String(jo.planned_start_at).slice(0, 16).replace(' ', 'T') : '',
      layout_qty: jo.layout_qty || 1,
    });
    setAssignError('');
    setShowAssign(true);
    if (pmsJobTypes.length === 0) api.get('/pms-job-types').then(({ data }) => setPmsJobTypes(data));
    if (artists.length === 0) api.get('/employees', { params: { account_type: 'Artist' } }).then(({ data }) => setArtists(data));
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
    setActionError('');
    try {
      await api.put(`/job-orders/${id}/sales-approval`);
      await load();
    } catch (err) {
      // The server refuses this when nothing is attached. Swallowing it silently left the
      // button looking broken, so surface whatever reason came back.
      setActionError(err.response?.data?.error || 'Could not send this Job Order for Sales Approval.');
      await loadAttachmentCount();
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveSales() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/approve-sales`); await load(); } finally { setBusy(false); }
  }

  async function handleRequestRevision() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/request-revision`); await load(); } finally { setBusy(false); }
  }

  async function handleApproveRma() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/approve-rma`); await load(); } finally { setBusy(false); }
  }

  // Let Production SEE this job order before Sales approves it, so a material that has to be
  // moved between warehouses can be spotted and a Transfer Order raised now rather than on the
  // day the job is meant to be scheduled. Changes no status: the job carries on through Design
  // and Sales Approval exactly as before, and Production can do nothing to it but raise a TO.
  async function handleForwardAdvanceCopy() {
    setBusy(true);
    setActionError('');
    try {
      await api.put(`/job-orders/${id}/forward-advance-copy`);
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Could not forward this Job Order to Production.');
    } finally { setBusy(false); }
  }

  async function handleForwardToProduction() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/forward-to-production`); await load(); } finally { setBusy(false); }
  }

  // Sales answers the delivery date Production suggested. Approving writes it; declining leaves
  // it exactly as promised. Either answer sends the job order back to Production in the same
  // step, so there is no second button to find.
  async function handleDateDecision(decision) {
    setBusy(true);
    setActionError('');
    try {
      await api.put(`/production/${id}/revision-decision`, { decision });
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Could not answer the suggested delivery date.');
    } finally {
      setBusy(false);
    }
  }

  // Hands the corrected job order back to Production, which acknowledges it as usual. The same
  // button exists on the Production view, but Sales reaches a job order through Sales > Job
  // Orders, which opens this page -- so without it here the rep had nowhere to click.
  async function handleApproveRevision() {
    setBusy(true);
    setActionError('');
    try {
      await api.put(`/production/${id}/approve-revision`);
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Could not send this Job Order back to Production.');
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveRwip() {
    setBusy(true);
    try { await api.put(`/job-orders/${id}/approve-rwip`); await load(); } finally { setBusy(false); }
  }

  if (loading || !jo) return <LoadingSpinner />;

  const canEdit = can('/job-orders', 'can_edit');
  const canApprove = can('/job-orders', 'can_approve');
  // An NSSO-spawned (RMA) job order has its own two-step flow -- no design/layout/artist chain:
  // Pending RMA Approval -> Approve RMA -> Planned - Pending for BOM -> Forward to Production ->
  // Released / Approved. Both actions need the NSSO "Can Approve" right.
  const isNsjo = !!jo.nsso_id;
  // An RWIP (rework) job order is raised off a mother JO in production; it carries the same rework
  // context (Cause of Error / Action) and "Pending RMA Approval" state, but its own approval is
  // governed by the Production page's can_approve, and once approved it's completed (not forwarded).
  const isRwip = !!jo.parent_job_order_id;
  const isRfqc = String(jo.job_order_no || '').startsWith('RFQC-');
  // RMA / RMA-Installation / Sample / RWIP / RFQC all show rework context; only Internal (INT) is plain.
  const isRmaType = isRwip || /-(RMA|INST|SAM)-/.test(jo.nsso_no || jo.job_order_no || '');
  const canApproveRma = can('/non-standard-sales-orders', 'can_approve');
  const isPendingRma = isNsjo && !jo.rma_approved_at;
  const canForwardProduction = isNsjo && !!jo.rma_approved_at && jo.status !== 'Released' && jo.status !== 'Cancelled';
  // Whose button it is: this job order's own sales rep (maySalesRevise already states that --
  // System Admin, the named rep, or another Sales account with can_edit covering for them).
  const canForwardAdvance = canForwardAdvanceCopy(jo) && maySalesRevise(user, jo, canEdit);
  const canApproveRwipPerm = can('/production', 'can_approve');
  const rwipPendingApproval = isRwip && jo.status === 'Pending RMA Approval';
  const isTerminal = jo.status === 'Completed' || jo.status === 'Cancelled';
  const isOnHold = !!jo.is_on_hold;
  // The artist a JO is assigned to needs to be able to send their own completed layout
  // to Sales for sign-off even without generic can_edit on Job Orders -- they shouldn't
  // need broader edit rights over the JO just to do that one thing.
  const isAssignedArtist = !!user?.employee_id && jo.artist_id === user.employee_id;
  // Same reasoning for the JO's own sales rep (Forward to Design Supervisor) and any
  // Design Supervisor (Assign Artist) -- these are workflow actions gated by role/
  // ownership, not by the generic can_edit permission (which now only gates the actual
  // "Edit" button above). can_edit still works as a fallback override for admins/
  // managers, matching the backend's own dual-check on these two routes.
  const isOwningSalesRep = !!user?.employee_id && jo.sales_rep_id === user.employee_id;
  const isDesignSupervisor = !!user?.is_design_supervisor;
  // The Design/Layout/Artist workflow is pre-release ONLY and applies to standard JOs alone.
  // Once a JO has a production_stage it's been released into production (design/layout is done --
  // it already has its artist + PMS job type), and NSJO/RWIP job orders skip the design chain
  // entirely. Gating on production_stage is also case-safe, unlike a `status !== 'Released'` check
  // (migrated JOs store status lowercase 'released'), which was leaking these buttons through.
  const isSpecialJo = isNsjo || isRwip;
  // Production handed this job order back for Sales to correct (see the Sales revision loop in
  // server/src/routes/production.js). Both actions the stage exists for -- moving the delivery
  // date and returning the job -- belong to Sales, and to the rep who owns this job order above
  // all; can_edit on /job-orders is not that test, which is how the button came to be visible to
  // admins only and to Production. Same rule the server applies.
  const forRevision = jo.production_stage === 'for_revision' && jo.status !== 'Cancelled';
  const canReviseAsSales = forRevision && maySalesRevise(user, jo, canEdit);
  // A date revision is answered, not "approved back" -- the server refuses the generic return
  // while the suggestion is still open, so the buttons follow the same split.
  const decidingDate = canReviseAsSales && awaitingDateDecision(jo);
  // The narrow rework grant: this rep, this job order, while it is back for a material/process
  // change. It opens the Edit form for someone who has no can_edit of their own, which is what
  // makes "Sales can change the material" true rather than an instruction to go and find someone
  // who can.
  const canRework = mayReworkJobOrder(user, jo);
  const inDesignPhase = !isSpecialJo && !jo.production_stage && jo.status !== 'Cancelled';

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
          {/* The server decides whether this JO may actually be printed (System Admin any
              time; everyone else needs an assigned artist), so the button only checks that
              the user holds the print permission at all. */}
          {can('/job-orders', 'can_print') && (
            <button className="btn btn-sm" onClick={() => window.open(`/job-orders/${id}/print`, '_blank')}>Print</button>
          )}
          {(canEdit || canRework) && jo.status !== 'Cancelled' && (
            <button className="btn btn-sm btn-primary"
              title={canRework && !canEdit ? 'Change the materials and processes Production asked about' : undefined}
              onClick={() => navigate(`/job-orders/${id}/edit`)}>Edit</button>
          )}
          {isPendingRma && canApproveRma && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApproveRma}>{isRmaType ? 'Approve RMA' : 'Approve'}</button>}
          {canForwardProduction && canApproveRma && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleForwardToProduction}>Forward to Production</button>}
          {/* Distinct from the RMA button above, which releases the job outright and only ever
              appears on an RMA job order -- hence the !isNsjo guard, so the two can never be
              drawn together and mean different things under the same words. */}
          {!isNsjo && canForwardAdvance && (
            <button
              className="btn btn-sm btn-primary" disabled={busy}
              title="Let Production see this Job Order now so they can raise Transfer Orders for materials. They cannot schedule or edit it until you approve it."
              onClick={handleForwardAdvanceCopy}
            >
              Forward to Production
            </button>
          )}
          {!isNsjo && isAdvanceCopy(jo) && (
            <span className="badge" style={{ marginLeft: 6 }} title="Production can see this Job Order and raise Transfer Orders against it. They cannot schedule or edit it until you approve it.">
              Advance copy with Production
            </span>
          )}
          {rwipPendingApproval && canApproveRwipPerm && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApproveRwip}>{isRfqc ? 'Approve RFQC' : 'Approve RWIP'}</button>}
          {inDesignPhase && (isOwningSalesRep || canEdit) && jo.sub_status === 'Pending' && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleForwardToDesign}>Forward to Design Supervisor</button>
          )}
          {inDesignPhase && (isDesignSupervisor || canEdit) && (
            <button className="btn btn-sm btn-primary" onClick={openAssign}>
              {jo.artist_id ? 'Reassign Artist' : 'Assign Layout Job Type / Artist'}
            </button>
          )}
          {inDesignPhase && (canEdit || isAssignedArtist) && (jo.sub_status === 'For Artist' || jo.sub_status === 'For Artist (Revision)') && (
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || attachmentCount === 0}
              title={attachmentCount === 0
                ? 'Attach the perspective and Bill of Materials first — see the Artist Attachment tab'
                : undefined}
              onClick={handleSalesApproval}
            >
              Sales Approval
            </button>
          )}
          {inDesignPhase && canApprove && jo.sub_status === 'Sales Approval' && (
            <>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApproveSales}>Approved</button>
              <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleRequestRevision}>For Revision</button>
            </>
          )}
          {decidingDate && (
            <>
              <button className="btn btn-sm btn-primary" disabled={busy}
                title="Accept the suggested delivery date and send this Job Order back to Production."
                onClick={() => handleDateDecision('approved')}>Approve Date</button>
              <button className="btn btn-sm btn-warning" disabled={busy}
                title="Keep the current delivery date and send this Job Order back to Production."
                onClick={() => handleDateDecision('declined')}>Decline Date</button>
            </>
          )}
          {canReviseAsSales && !decidingDate && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              title="Send the corrected Job Order back to Production for acknowledgement."
              onClick={handleApproveRevision}>Approve to Production</button>
          )}
          {canEdit && !isOnHold && !isTerminal && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleHold}>Hold</button>}
          {canEdit && isOnHold && !isTerminal && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleResume}>Resume</button>}
        </div>
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Job Order</h1>
          <span className="estimate-no">{jo.job_order_no}</span>
        </div>
        <div className="estimate-status">
          {jo.status} <span style={{ opacity: 0.7 }}>{STAGE_LABELS[jo.production_stage] || jo.sub_status}</span>
          {isOnHold && <span className="estimate-so-link" style={{ background: 'rgba(245, 159, 0, 0.35)' }}>On Hold</span>}
          {jo.nsso_no && (
            <button type="button" className="estimate-so-link" onClick={() => navigate(`/non-standard-sales-orders/${jo.nsso_id}`)}>
              {jo.nsso_no}
            </button>
          )}
          {isRwip && jo.parent_job_order_no && (
            <button type="button" className="estimate-so-link" onClick={() => navigate(`/job-orders/${jo.parent_job_order_id}`)}>
              {jo.parent_job_order_no}
            </button>
          )}
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
            <div>Delivery Date : <span className="hi">{jo.delivery_date ? String(jo.delivery_date).slice(0, 10) : ''}</span></div>
            <div>Delivery Time : <span className="hi">{jo.delivery_time}</span></div>
            <div>Sales Rep. : <span className="hi">{jo.sales_rep_name}</span></div>
          </div>
          <div>
            <div>Job Location : <span className="hi">{jo.job_location_name}</span></div>
            <div>Job Type : <span className="hi">{jo.job_type_name}</span></div>
            <div>Job Desc. : <span className="hi">{jo.description}</span></div>
            <div>Layout - Job Type : <span className="hi">{jo.layout_job_type_name}</span></div>
            <div>Artist : <span className="hi">{jo.artist_name}</span></div>
            {jo.artist_id && <div>Layout Qty : <span className="hi">{jo.layout_qty ?? 1}</span></div>}
            <div>Qty : <span className="hi">{jo.quantity} {jo.units}</span> Qty Built: <span className="hi">{jo.quantity_built} {jo.units}</span> Qty Inspected: <span className="hi">{jo.quantity_inspected} {jo.units}</span></div>
            <div>Length : <span className="hi">{jo.length ?? 0}</span> Width : <span className="hi">{jo.width ?? 0}</span> Height : <span className="hi">{jo.height ?? ''}</span></div>
            <div>Memo : <span className="hi">{jo.memo}</span></div>
            {isRmaType && <div>Cause of Error : <span className="hi">{jo.reason_code_name || jo.reason}</span></div>}
            {isRmaType && <div>Action/s to be taken : <span className="hi">{jo.action_to_be_taken}</span></div>}
            {jo.nsso_id && jo.rma_approved_by_name && jo.rma_approved_by_name.trim() && <div>RMA Approved By : <span className="hi">{jo.rma_approved_by_name}</span></div>}
          </div>
        </div>
      </div>

      <RevisionNotice jo={jo} />

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>Processes</button>
        <button className={`status-tab ${tab === 'rwip' ? 'active' : ''}`} onClick={() => setTab('rwip')}>RWIP JO</button>
        <button className={`status-tab ${tab === 'subcon' ? 'active' : ''}`} onClick={() => setTab('subcon')}>Sub Con</button>
        <button className={`status-tab ${tab === 'attachments' ? 'active' : ''}`} onClick={() => setTab('attachments')}>
          Artist Attachment{attachmentCount ? ` (${attachmentCount})` : ''}
        </button>
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
              <thead><tr><th>Date</th><th>Transaction #</th><th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th><th>Status</th></tr></thead>
              <tbody>
                {(jo.rwips || []).length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No RWIP transactions.</td></tr>
                )}
                {(jo.rwips || []).map((r) => (
                  <tr key={r.id}>
                    <td>{r.created_at ? String(r.created_at).slice(0, 10) : ''}</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(r.production_stage ? `/production/${r.id}` : `/job-orders/${r.id}`)}>{r.job_order_no}</button></td>
                    <td style={{ textAlign: 'right' }}>{Number(r.quantity)}</td>
                    <td>{r.units}</td>
                    <td>{STAGE_LABELS[r.production_stage] || r.status}</td>
                  </tr>
                ))}
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

      {tab === 'attachments' && (
        <JobOrderAttachments
          jobOrderId={id}
          kinds={ARTIST_KINDS}
          title="Artist Attachment"
          description={'The perspective drawing and the Cutting List / Bill of Materials. Sales approves '
            + 'against these, so at least one file is required before this Job Order can be sent for '
            + 'Sales Approval.'}
          emptyHint="Attach the perspective and Bill of Materials to continue."
          canUpload={isAssignedArtist || canEdit}
          canDelete={user?.account_type === 'System Admin'}
          onChange={loadAttachmentCount}
        />
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
                label="Artist" items={artists} value={assignForm.artist_id} getLabel={(e) => `${e.first_name} ${e.last_name}`}
                columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }, { key: 'position_title', label: 'Position' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={(e) => setAssignForm({ ...assignForm, artist_id: e.id })}
              />
            </div>
            <div className="field">
              <label>Qty</label>
              <input
                type="number" min="0.0001" step="any" required
                value={assignForm.layout_qty}
                onChange={(e) => setAssignForm({ ...assignForm, layout_qty: e.target.value })}
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
              <label>Planned End <span className="muted">(auto-computed: Minutes Consume × Qty)</span></label>
              <input readOnly tabIndex={-1} value={(() => {
                const minutes = pmsJobTypes.find((p) => p.id === Number(assignForm.layout_job_type_id))?.minutes_consume;
                const qty = Number(assignForm.layout_qty);
                if (!assignForm.planned_start_at || !minutes || !qty) return '';
                const end = new Date(new Date(assignForm.planned_start_at).getTime() + Number(minutes) * qty * 60 * 1000);
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
