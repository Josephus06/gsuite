import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import QualityInspectionModal from '../components/QualityInspectionModal';
import RwipCreateModal from '../components/RwipCreateModal';
import LoadingSpinner from '../components/LoadingSpinner';
import { isNonStockItem } from '../utils/itemTypes';
import { isPlanner } from '../utils/plannerRoles';
import { maySalesRevise } from '../utils/salesRevision';

// Mirrors the real system's "Production > Production" detail screen -- same underlying
// Job Order as JobOrderView.jsx, but reached once the JO is Released and viewed for
// production-floor execution: title "PRODUCTION" instead of "Job Order", no Design/
// Sales-approval action buttons (those only apply pre-Release), and a much wider
// Processes table (On Hand/Committed/Total Built/Total Completed/Back Order/Sales &
// Production Remarks/Built & Completed entry/Reallocate). Assembly Build converts
// tracked completion into finished-good Built qty and deducts consumed materials from
// on-hand (see AssemblyBuildModal below). Print, Complete All, and Reallocate are real
// buttons on the live site but each opens its own full module or drives
// production-execution recording this build doesn't model -- shown here as disabled
// stubs. Create TO is the one exception -- it's wired to the real Transfer Orders module
// (see handleCreateTO) and only appears once a process line's Back Order is > 0.
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

// Mirrors Production.jsx's STAGE_TABS labels -- once a JO is Released and tracked by
// production_stage, that's the more informative "where is it right now" signal for this
// screen's banner than sub_status, which only ever meant something pre-Release (the
// Design/Layout approval steps) and otherwise stays frozen at "Approved" forever.
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

// The banner is dark, so a default date input renders as a white slab in the middle of it.
const SCHEDULE_INPUT = {
  background: 'rgba(255,255,255,0.14)',
  border: '1px solid rgba(255,255,255,0.35)',
  color: '#fff',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 13,
  colorScheme: 'dark',
};

const PROCESS_COLUMNS = [
  { key: 'process_name', label: 'Process' },
  { key: 'process_qty', label: 'Process Qty' },
  { key: 'process_uom', label: 'Process UOM' },
  // Replacing Category and Parts, which live data never fills in -- 9 and 7 of 413,376
  // process lines respectively. The planned dates the Scheduled JO planner sets per task are
  // worth far more space on the floor's own view of the same lines: this is where production
  // reads what it is meant to be working on and when, without leaving the Job Order.
  // Read-only here; Scheduled JO is where they are set (client/src/pages/ScheduledJobOrderTasks.jsx).
  { key: 'planned_start_date', label: 'Planned Start' },
  { key: 'planned_end_date', label: 'Planned End' },
  { key: 'item_name', label: 'Item' },
  { key: 'location_name', label: 'Location' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' },
  { key: 'uom', label: 'UOM' },
  { key: 'qty', label: 'Qty' },
  { key: 'total', label: 'SubTotal' },
  { key: 'rwip_qty', label: 'RWIP Qty' },
  { key: 'rwip_total', label: 'RWIP Total' },
  { key: 'grand_total', label: 'Total' },
  { key: 'unit', label: 'Unit' },
  { key: 'on_hand', label: 'On Hand' },
  { key: 'committed', label: 'Committed' },
  { key: 'total_completed', label: 'Total Completed' },
  { key: 'total_built', label: 'Total Built' },
  { key: 'back_order', label: 'Back Order' },
  { key: 'built_input', label: 'Built' },
  { key: 'completed_input', label: 'Completed' },
  { key: 'remarks', label: 'Sales Remarks' },
  { key: 'production_remarks', label: 'Production Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'process_cost', label: 'Process Cost' },
  { key: 'material_cost', label: 'Material Cost' },
  { key: 'total_cost', label: 'Total Cost' },
];

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
// DATE columns arrive as plain 'YYYY-MM-DD' strings (the pool sets dateStrings), which is
// already how this page prints Date Created and Delivery Date -- no Date object in between,
// so nothing can shift a day across a timezone on the way to the cell.
const day = (v) => (v ? String(v).slice(0, 10) : '');
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
// Forecast is a derived summary (total calendar days spanned, inclusive) rather than
// its own stored field -- same computation as JobOrderEdit.jsx's Forecast readout.
function forecastLabel(startStr, endStr) {
  if (!startStr || !endStr) return '';
  const start = new Date(`${String(startStr).slice(0, 10)}T00:00:00`);
  const end = new Date(`${String(endStr).slice(0, 10)}T00:00:00`);
  const days = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
  return days > 0 ? `${days} day${days === 1 ? '' : 's'}` : '';
}

// Mirrors the real system's "Completed" progress-bar modal: shows the line's material
// requirement, what's on hand, and how much of the total has been completed so far as a
// percentage bar. "Total to Complete" is an incremental amount -- Complete All prefills
// it with whatever's left (capped by on-hand), and Update adds it on top of the running
// Total Completed rather than replacing it.
function CompleteProcessModal({ process: p, onClose, onSaved }) {
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const total = num(p.total);
  const onHand = num(p.on_hand);
  const completed = num(p.total_completed);
  // A Service line is labor, not material: nothing has to be in stock for it to be
  // marked done, so the whole remaining requirement is available to complete. Capping it
  // by on-hand (always 0 for these) would pin it at 0% with no way to ever move it.
  const nonStock = isNonStockItem(p.item_type);
  const ceiling = nonStock ? total : Math.min(total, onHand);
  const availableToComplete = Math.max(ceiling - completed, 0);
  const pct = total > 0 ? Math.min((completed / total) * 100, 100) : 0;

  async function handleUpdate() {
    const amt = Number(amount);
    if (!amt || amt <= 0) { setError('Enter an amount greater than 0.'); return; }
    if (amt > availableToComplete) {
      setError(`You cannot complete more than the total needed. Available to complete: ${qty(availableToComplete)} ${p.unit}.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSaved(amt);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Update failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={p.process_name} onClose={onClose} large>
      <div className="review-grid">
        <div className="item"><div className="label">Planned Start</div><div className="value">{day(p.planned_start_date) || <span className="muted">—</span>}</div></div>
        <div className="item"><div className="label">Planned End</div><div className="value">{day(p.planned_end_date) || <span className="muted">—</span>}</div></div>
        <div className="item"><div className="label">Items</div><div className="value">{p.item_name}</div></div>
        <div className="item"><div className="label">Location</div><div className="value">{p.location_name}</div></div>
        <div className="item"><div className="label">Length</div><div className="value">{p.length ?? ''}</div></div>
        <div className="item"><div className="label">Width</div><div className="value">{p.width ?? ''}</div></div>
        <div className="item"><div className="label">UOM</div><div className="value">{p.uom}</div></div>
        <div className="item"><div className="label">Qty</div><div className="value">{qty(p.qty)}</div></div>
        <div className="item"><div className="label">RWIP Qty</div><div className="value">{qty(p.rwip_qty)}</div></div>
        <div className="item"><div className="label">Total</div><div className="value">{qty(p.total)}</div></div>
        <div className="item"><div className="label">Unit</div><div className="value">{p.unit}</div></div>
        <div className="item"><div className="label">Total Completed</div><div className="value">{qty(p.total_completed)}</div></div>
        <div className="item"><div className="label">Total Built</div><div className="value">{qty(p.total_built)}</div></div>
        <div className="item"><div className="label">On Hand</div><div className="value">{nonStock ? <span className="muted" title="Service items hold no stock.">—</span> : qty(p.on_hand)}</div></div>
        <div className="item">
          <div className="label">Available Total to Complete</div>
          <div className="value"><span className="highlight-box">{qty(availableToComplete)} {p.unit}</span></div>
        </div>
      </div>

      <div className="progress-bar" style={{ marginTop: 16 }}>
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        <div className="progress-bar-label">{pct.toFixed(0)}%</div>
      </div>

      {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}

      <div className="field" style={{ marginTop: 16 }}>
        <label>Total to Complete ({p.unit})</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Clear the error as soon as the amount changes -- otherwise a rejected empty
              Update leaves "Enter an amount greater than 0." sitting above a field that
              now plainly has a number in it, which reads as the save still failing. */}
          <input
            type="number" step="0.0001" min="0" max={availableToComplete} value={amount}
            onChange={(e) => { setAmount(e.target.value); setError(''); }}
          />
          <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}
            onClick={() => { setAmount(String(availableToComplete)); setError(''); }}>
            Complete All
          </button>
        </div>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleUpdate}>Update</button>
      </div>
    </Modal>
  );
}

// Mirrors the real system's "Assembly Build" modal: converts tracked production
// progress into finished-good Built qty. Available Qty to Build is capped by whichever
// process line is furthest behind (its Total Completed / Total ratio), floored to whole
// JO units and reduced by however much is already Built -- a unit isn't really done
// until every one of its processes is. Saving deducts the materials that build actually
// consumes from on-hand inventory server-side (with its own hard on-hand check), not
// just from what's shown here.
function AssemblyBuildModal({ jo, onClose, onSaved }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [quantityToBuild, setQuantityToBuild] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const processes = jo.processes || [];
  const jobQty = num(jo.quantity);
  const builtQty = num(jo.quantity_built);
  const fractions = processes.map((p) => (num(p.total) > 0 ? num(p.total_completed) / num(p.total) : 1));
  const minFraction = fractions.length ? Math.min(...fractions) : 0;
  const availableQtyToBuild = jobQty > 0 ? Math.max(Math.floor(minFraction * jobQty) - builtQty, 0) : 0;
  const totalAmount = processes.reduce((s, p) => s + num(p.process_cost) + num(p.material_cost), 0);
  const qtyToBuildNum = Number(quantityToBuild) || 0;

  async function handleBuilt() {
    if (!qtyToBuildNum || qtyToBuildNum <= 0) { setError('Enter a Quantity to Build greater than 0.'); return; }
    if (qtyToBuildNum > availableQtyToBuild) {
      setError(`Quantity to Build cannot exceed the Available Qty to Build (${availableQtyToBuild}).`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSaved(qtyToBuildNum);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Build failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Assembly Build" onClose={onClose} large>
      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="field"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div>
          <div className="item"><div className="label">Job Type</div><div className="value">{jo.job_type_name}</div></div>
          <div className="item"><div className="label">Job Description</div><div className="value">{jo.description}</div></div>
          <div className="item"><div className="label">Job Location</div><div className="value">{jo.job_location_name}</div></div>
        </div>
        <div className="item"><div className="label">Customer</div><div className="value">{jo.customer_name}</div></div>
        <div className="item"><div className="label">Qty</div><div className="value">{qty(jo.quantity)} {jo.units}</div></div>
        <div className="item"><div className="label">Created Form</div><div className="value">{jo.job_order_no}</div></div>
        <div className="item"><div className="label">Built Qty</div><div className="value">{qty(jo.quantity_built)} {jo.units}</div></div>
        <div className="item">
          <div className="label">Available Qty to Build</div>
          <div className="value"><span className="highlight-box">{availableQtyToBuild}</span></div>
        </div>
        <div className="item"><div className="label">Total Amount</div><div className="value">{money(totalAmount)}</div></div>
      </div>

      {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}

      <div className="field-row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
        <div className="field">
          <label>Quantity to Build</label>
          <input
            type="number" step="1" min="0" max={availableQtyToBuild} value={quantityToBuild}
            onChange={(e) => setQuantityToBuild(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Available quantity can be build</label>
          <input readOnly tabIndex={-1} value={availableQtyToBuild} />
        </div>
        <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}
          onClick={() => setQuantityToBuild(String(availableQtyToBuild))}>
          Build All
        </button>
      </div>

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr>
              <th>#</th><th>Process</th><th>Item</th><th>Process Qty</th><th>Qty</th><th>Qty RWIP</th>
              <th>Total Qty to Build</th><th>Total Completed</th><th>Total Build</th><th>Unit</th>
              <th>Process Cost</th><th>Material Cost</th>
            </tr>
          </thead>
          <tbody>
            {processes.map((p, idx) => {
              const totalQtyToBuild = jobQty > 0 ? (num(p.total) / jobQty) * qtyToBuildNum : 0;
              return (
                <tr key={p.id}>
                  <td>{idx + 1}</td>
                  <td>{p.process_name}</td>
                  <td>{p.item_name}</td>
                  <td>{qty(p.process_qty)}</td>
                  <td>{qty(p.qty)}</td>
                  <td>{qty(0)}</td>
                  <td>{qty(totalQtyToBuild)}</td>
                  <td>{qty(p.total_completed)}</td>
                  <td>{qty(p.total_built)}</td>
                  <td>{p.unit}</td>
                  <td>{money(p.process_cost)}</td>
                  <td>{money(p.material_cost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleBuilt}>Built</button>
      </div>
    </Modal>
  );
}

export default function ProductionJobOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [jo, setJo] = useState(null);
  // Planned dates are edited in place on this screen rather than on the Job Order form -- the
  // person scheduling a job is looking at the floor view. Held as drafts so a half-typed date
  // does not fire a save on every keystroke.
  const [plannedStart, setPlannedStart] = useState('');
  const [plannedEnd, setPlannedEnd] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  // The delivery date, edited in place while the job order is For Revision -- the same control
  // the Job Order view carries, because Sales reaches a returned job order from either screen.
  const [deliveryDraft, setDeliveryDraft] = useState('');
  const [deliveryTimeDraft, setDeliveryTimeDraft] = useState('');
  const [deliveryError, setDeliveryError] = useState('');
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [actionError, setActionError] = useState('');
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [tab, setTab] = useState('processes');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [completingProcess, setCompletingProcess] = useState(null);
  const [showAssemblyBuild, setShowAssemblyBuild] = useState(false);
  const [showQualityInspection, setShowQualityInspection] = useState(false);
  const [showRwip, setShowRwip] = useState(false);

  function load() {
    return api.get(`/production/${id}`).then(({ data }) => {
      setJo(data);
      setPlannedStart(data.planned_start_date ? String(data.planned_start_date).slice(0, 10) : '');
      setPlannedEnd(data.planned_end_date ? String(data.planned_end_date).slice(0, 10) : '');
      setDeliveryDraft(data.delivery_date ? String(data.delivery_date).slice(0, 10) : '');
      setDeliveryTimeDraft(data.delivery_time || '');
      setLoading(false);
    });
  }

  async function handleSavePlanned() {
    setScheduleError('');
    if (plannedStart && plannedEnd && plannedEnd < plannedStart) {
      setScheduleError('Planned End cannot be before Planned Start.');
      return;
    }
    // The delivery date is the promise Sales made to the customer, so the plan has to fit inside
    // it. Checked here as well as on the server so the scheduler is told while the date is still
    // in front of them, rather than after a round trip. Both inputs also carry max={deliveryDay},
    // which stops most of these before they are typed.
    const deliveryDay = jo?.delivery_date ? String(jo.delivery_date).slice(0, 10) : '';
    if (deliveryDay) {
      const late = [['Planned Start', plannedStart], ['Planned End', plannedEnd]].find(([, d]) => d && d > deliveryDay);
      if (late) {
        setScheduleError(`${late[0]} cannot be later than the Delivery Date (${deliveryDay}).`);
        return;
      }
    }
    setSavingSchedule(true);
    try {
      await api.put(`/production/${id}/planned-dates`, {
        planned_start_date: plannedStart || null,
        planned_end_date: plannedEnd || null,
      });
      await load();
    } catch (err) {
      setScheduleError(err.response?.data?.error || 'Could not save the planned dates.');
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleSaveDelivery() {
    setDeliveryError('');
    if (!deliveryDraft) { setDeliveryError('Enter a delivery date.'); return; }
    setSavingDelivery(true);
    try {
      await api.put(`/job-orders/${id}/delivery-date`, {
        delivery_date: deliveryDraft,
        delivery_time: deliveryTimeDraft || null,
      });
      await load();
    } catch (err) {
      setDeliveryError(err.response?.data?.error || 'Could not save the delivery date.');
    } finally {
      setSavingDelivery(false);
    }
  }

  async function handleAcknowledge() {
    setScheduleError('');
    setSavingSchedule(true);
    try {
      await api.put(`/production/${id}/acknowledge`);
      await load();
    } catch (err) {
      setScheduleError(err.response?.data?.error || 'Could not acknowledge this job order.');
    } finally {
      setSavingSchedule(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  // "Create TO" only makes sense once a material is actually short (On Hand < what this
  // JO needs) -- withdraws from Warehouse - Central into wherever the short material is
  // tracked for this JO, matching every short line's own location_id (they're normally
  // all the same warehouse for one production run).
  async function handleCreateTO(shortItems) {
    const { data: locations } = await api.get('/lookups/locations');
    const central = locations.find((l) => l.location_name === 'Warehouse - Central') || locations.find((l) => l.location_type === 'Warehouse');
    // A process line doesn't always carry its own location_id (e.g. imported/edited
    // without one) -- fall back to the JO's own job_location_id per item so a single
    // incomplete line can't block Create TO for the whole shortage.
    const locationCounts = {};
    shortItems.forEach((p) => {
      const locId = p.location_id || jo.job_location_id;
      if (locId) locationCounts[locId] = (locationCounts[locId] || 0) + 1;
    });
    const transferToLocationId = Object.keys(locationCounts).sort((a, b) => locationCounts[b] - locationCounts[a])[0];

    navigate('/transfer-orders/new', {
      state: {
        prefill: {
          job_order_id: Number(id),
          withdraw_from_location_id: central?.id || null,
          transfer_to_location_id: Number(transferToLocationId) || null,
          requestor_id: user?.employee_id || null,
          lines: shortItems.map((p) => ({
            item_id: p.item_id,
            job_order_process_id: p.id,
            qty: p.back_order,
            uom: p.uom,
            unit: p.unit,
            back_ordered: p.back_order,
            committed: p.committed,
            memo: p.process_name,
          })),
        },
      },
    });
  }

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

  // Both directions of the Sales revision loop. The refusals the server can return are real
  // states a user can be in (already built quantity, on hold), not just guard rails, so they are
  // surfaced rather than swallowed.
  async function handleStageAction(path) {
    setBusy(true);
    setActionError('');
    try {
      await api.put(`/production/${id}/${path}`);
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Could not update this job order.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCompletion(processId, amount) {
    await api.put(`/production/${id}/processes/${processId}/complete`, { amount });
    await load();
  }

  async function handleAssemblyBuild(quantityToBuild) {
    const { data } = await api.put(`/production/${id}/assembly-build`, { quantity_to_build: quantityToBuild });
    navigate(`/assembly-builds/${data.assembly_build_id}`);
  }

  if (loading || !jo) return <LoadingSpinner />;

  const canEdit = can('/job-orders', 'can_edit');
  const canCreateRwip = can('/production', 'can_edit');
  // Working the floor -- Assembly Build and recording completion -- is production's job, and it
  // was gated here on can_edit for /job-orders: a Sales permission, which the production accounts
  // hold and the server does not accept, so the button was drawn for the very people it then
  // refused. It asks for what the server asks for instead (see requireProductionFloor in
  // routes/production.js): production edit rights, or one of the two floor role tags. What they
  // may build is still bounded by their department's warehouse, on the server.
  const canWorkFloor = canCreateRwip || isPlanner(user) || !!user?.is_production_supervisor;
  const isTerminal = jo.status === 'Completed' || jo.status === 'Cancelled';
  const isOnHold = !!jo.is_on_hold;
  // Editable in place while the job is still live; Acknowledge is offered only out of
  // scheduling, since moving a building or invoiced job back to In-Process would lose the
  // progress its stage represents.
  // A department planner schedules without holding production edit rights, so the fields open
  // for them too -- matching what the server accepts.
  const canSchedule = (canEdit || isPlanner(user)) && !isTerminal;
  const deliveryDay = jo.delivery_date ? String(jo.delivery_date).slice(0, 10) : '';
  const deliveryDirty = deliveryDraft !== deliveryDay || (deliveryTimeDraft || '') !== (jo.delivery_time || '');
  const savedStart = jo.planned_start_date ? String(jo.planned_start_date).slice(0, 10) : '';
  const savedEnd = jo.planned_end_date ? String(jo.planned_end_date).slice(0, 10) : '';
  const plannedDirty = plannedStart !== savedStart || plannedEnd !== savedEnd;
  const forecastDefined = !!savedStart && !!savedEnd;
  const awaitingSchedule = jo.production_stage === 'pending_for_scheduling' && !isOnHold;
  // The Sales revision loop. Sending back is Production's call and needs Production edit rights;
  // returning it is Sales's and needs Job Order edit rights -- each button asks for the same
  // right its endpoint does, so neither can be offered to someone the server will refuse.
  // Offered only on a Released job order still Pending for Sched. -- the window between Sales
  // handing it over and Production accepting it, when sending it back costs nothing. Once it is
  // In-Process there is work under way to walk backwards over.
  const forRevision = jo.production_stage === 'for_revision';
  // Both halves of the Sales revision loop belong to Sales -- returning the job order and
  // moving the delivery date. Production raised the revision; offering them the button that ends
  // it (three Production accounts hold can_edit on /job-orders, which is what this used to ask
  // for) put the wrong department in charge of clearing it. Same rule the server applies.
  const canReturnRevision = maySalesRevise(user, jo, canEdit);
  const canReviseDelivery = forRevision && canReturnRevision && jo.status !== 'Cancelled';
  const canSendForRevision = can('/production', 'can_edit') && !isOnHold
    && jo.status === 'Released' && jo.production_stage === 'pending_for_scheduling'
    && num(jo.quantity_built) === 0;
  // RWIP can only be raised while the JO is in process; open RWIPs block building the mother JO.
  const isInProcess = jo.production_stage === 'in_process';
  const openRwipCount = jo.open_rwip_count || 0;
  const hasUninspectedBuilds = (jo.assembly_builds || []).some(
    (ab) => ab.status !== 'cancelled' && num(ab.quantity_built) - num(ab.passed_qty) - num(ab.rma_qty) > 0
  );

  const processes = (jo.processes || []).map((p) => ({
    ...p,
    rwip_qty: 0,
    rwip_total: 0,
    grand_total: num(p.total),
  }));
  const totalCost = processes.reduce((s, p) => s + num(p.total_cost), 0);
  const revenue = num(jo.line_subtotal) - num(jo.line_disc_amount);
  const gpAmount = revenue - totalCost;
  const gpRate = revenue ? (gpAmount / revenue) * 100 : 0;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/production')}>Back to Lists</button>
          {canEdit && jo.status !== 'Cancelled' && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/job-orders/${id}/edit`, { state: { from: 'production' } })}>Edit</button>}
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canSendForRevision && (
            <button className="btn btn-sm btn-warning" disabled={busy}
              title="Send this Job Order back to Sales to be corrected. It returns here for acknowledgement."
              onClick={() => handleStageAction('sales-revision')}>Sales Revision</button>
          )}
          {forRevision && canReturnRevision && jo.status !== 'Cancelled' && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              title="Send the corrected Job Order back to Production for acknowledgement."
              onClick={() => handleStageAction('approve-revision')}>Approve to Production</button>
          )}
          {canWorkFloor && !isTerminal && (
            <button className="btn btn-sm btn-primary" disabled={openRwipCount > 0}
              title={openRwipCount > 0 ? 'Complete the RWIP job order(s) before building this Job Order.' : 'Assembly Build'}
              onClick={() => setShowAssemblyBuild(true)}>Assembly Build</button>
          )}
          {canWorkFloor && hasUninspectedBuilds && <button className="btn btn-sm btn-primary" onClick={() => setShowQualityInspection(true)}>Quality Inspection</button>}
          {canEdit && !isOnHold && !isTerminal && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleHold}>Hold</button>}
          {canEdit && isOnHold && !isTerminal && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleResume}>Resume</button>}
        </div>
      </div>

      {actionError && <div className="error-banner" style={{ marginTop: 12 }}>{actionError}</div>}

      <div className="page-header" style={{ marginTop: -12 }}>
        <h2 style={{ margin: 0 }}>Production</h2>
        <div />
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
            <div>Date Created : <span className="hi">{jo.created_at ? String(jo.created_at).slice(0, 10) : ''}</span></div>
            <div>Office Location : <span className="hi">{jo.office_location_name}</span></div>
            <div>Sales Division : <span className="hi">{jo.sales_division_name}</span></div>
            <div>Shipping Address : <span className="hi">{jo.shipping_address}</span></div>
            {canSchedule ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Planned Start :
                  <input
                    type="date" value={plannedStart} disabled={savingSchedule}
                    max={deliveryDay || undefined}
                    onChange={(e) => setPlannedStart(e.target.value)}
                    style={SCHEDULE_INPUT}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  Planned End :
                  <input
                    type="date" value={plannedEnd} disabled={savingSchedule}
                    max={deliveryDay || undefined}
                    onChange={(e) => setPlannedEnd(e.target.value)}
                    style={SCHEDULE_INPUT}
                  />
                </div>
                <div style={{ marginTop: 4 }}>
                  {/* Reads off the drafts, so the span updates as the dates are typed rather
                      than only after a save. */}
                  Forecast : <span className="hi">{forecastLabel(plannedStart, plannedEnd) || '—'}</span>
                  {plannedDirty && (
                    <button
                      type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 10 }}
                      disabled={savingSchedule} onClick={handleSavePlanned}
                    >
                      {savingSchedule ? 'Saving...' : 'Save Dates'}
                    </button>
                  )}
                  {!plannedDirty && forecastDefined && awaitingSchedule && (
                    <button
                      type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 10 }}
                      disabled={savingSchedule} onClick={handleAcknowledge}
                    >
                      {savingSchedule ? 'Working...' : 'Acknowledge'}
                    </button>
                  )}
                </div>
                {scheduleError && (
                  <div style={{ marginTop: 6, color: '#ffd4d4', fontWeight: 600 }}>{scheduleError}</div>
                )}
              </>
            ) : (
              <>
                <div>Planned Start : <span className="hi">{jo.planned_start_date ? String(jo.planned_start_date).slice(0, 10) : ''}</span></div>
                <div>Planned End : <span className="hi">{jo.planned_end_date ? String(jo.planned_end_date).slice(0, 10) : ''}</span></div>
                <div>Forecast : <span className="hi">{forecastLabel(jo.planned_start_date, jo.planned_end_date)}</span></div>
              </>
            )}
            {canReviseDelivery ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Delivery Date :
                  <input
                    type="date" value={deliveryDraft} disabled={savingDelivery}
                    onChange={(e) => setDeliveryDraft(e.target.value)}
                    style={SCHEDULE_INPUT}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  Delivery Time :
                  <input
                    type="time" value={deliveryTimeDraft} disabled={savingDelivery}
                    onChange={(e) => setDeliveryTimeDraft(e.target.value)}
                    style={SCHEDULE_INPUT}
                  />
                  {deliveryDirty && (
                    <button
                      type="button" className="btn btn-sm btn-primary"
                      disabled={savingDelivery} onClick={handleSaveDelivery}
                    >
                      {savingDelivery ? 'Saving...' : 'Save Date'}
                    </button>
                  )}
                </div>
                {deliveryError && (
                  <div style={{ marginTop: 6, color: '#ffd4d4', fontWeight: 600 }}>{deliveryError}</div>
                )}
              </>
            ) : (
              <>
                <div>Delivery Date : <span className="hi">{jo.delivery_date ? String(jo.delivery_date).slice(0, 10) : ''}</span></div>
                <div>Delivery Time : <span className="hi">{jo.delivery_time}</span></div>
              </>
            )}
            <div>Sales Rep. : <span className="hi">{jo.sales_rep_name}</span></div>
          </div>
          <div>
            <div>Job Location : <span className="hi">{jo.job_location_name}</span></div>
            <div>Job Type : <span className="hi">{jo.job_type_name}</span></div>
            <div>Job Desc. : <span className="hi">{jo.description}</span></div>
            <div>Layout - Job Type : <span className="hi">{jo.layout_job_type_name}</span></div>
            <div>Artist : <span className="hi">{jo.artist_name}</span></div>
            <div>Qty : <span className="hi">{jo.quantity} {jo.units}</span> Qty Built: <span className="hi">{jo.quantity_built} {jo.units}</span> Qty Inspected: <span className="hi">{jo.quantity_inspected} {jo.units}</span></div>
            <div>Length : <span className="hi">{jo.length ?? 0}</span> Width : <span className="hi">{jo.width ?? 0}</span> Height : <span className="hi">{jo.height ?? ''}</span> unit : <span className="hi">{jo.units}</span></div>
            <div>Memo : <span className="hi">{jo.memo}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>Processes</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'subcon' ? 'active' : ''}`} onClick={() => setTab('subcon')}>Sub Con</button>
        <button className={`status-tab ${tab === 'rwip' ? 'active' : ''}`} onClick={() => setTab('rwip')}>RWIP JO</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'processes' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  {PROCESS_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th>
                    <button type="button" className="btn btn-sm btn-primary" disabled title="Recording production output isn't implemented in this build">Complete All</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {processes.length === 0 && (
                  <tr><td colSpan={PROCESS_COLUMNS.length + 2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No processes.</td></tr>
                )}
                {processes.map((p, idx) => (
                  <tr key={p.id}>
                    <td>{idx + 1}</td>
                    {PROCESS_COLUMNS.map((c) => {
                      if (c.key === 'built_input') {
                        return <td key={c.key}><input value={p.total_built ?? 0} readOnly disabled style={{ width: 70 }} /></td>;
                      }
                      if (c.key === 'completed_input') {
                        if (!p.item_id) return <td key={c.key} />;
                        const pct = num(p.total) > 0 ? Math.min((num(p.total_completed) / num(p.total)) * 100, 100) : 0;
                        // A line worked at another warehouse is that department's to complete, so
                        // its progress still reads but the control is inert. can_complete comes from
                        // the API, which knows this user's scope; the server refuses either way.
                        return (
                          <td key={c.key} style={{ width: 90 }}>
                            <button
                              type="button"
                              className="progress-bar"
                              disabled={!p.can_complete || !canWorkFloor}
                              onClick={() => setCompletingProcess(p)}
                              title={!canWorkFloor
                                ? 'Recording output on this Job Order is production\u2019s to do'
                                : (p.can_complete ? 'Update Completed' : `Completed by ${p.location_name}`)}
                            >
                              <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                              <div className="progress-bar-label">{pct.toFixed(0)}%</div>
                            </button>
                          </td>
                        );
                      }
                      if (c.key === 'on_hand' || c.key === 'committed' || c.key === 'total_completed' || c.key === 'total_built' || c.key === 'back_order') {
                        if (!p.item_id) return <td key={c.key} />;
                        // On Hand / Committed / Back Order are stock figures that stay at
                        // zero on a Service line whatever happens -- printing 0.0000 (and
                        // especially a Back Order equal to the full requirement) reads as
                        // a materials shortage on something that needs no materials.
                        const stockOnly = c.key === 'on_hand' || c.key === 'committed' || c.key === 'back_order';
                        if (stockOnly && isNonStockItem(p.item_type)) {
                          return <td key={c.key}><span className="muted">—</span></td>;
                        }
                        return <td key={c.key}>{qty(p[c.key])}</td>;
                      }
                      if (c.key === 'planned_start_date' || c.key === 'planned_end_date') {
                        // Set on Scheduled JO, and not every line has been planned yet -- an
                        // em dash says "nobody has scheduled this" where an empty cell would
                        // just look like a rendering gap.
                        const d = day(p[c.key]);
                        return <td key={c.key}>{d || <span className="muted">—</span>}</td>;
                      }
                      if (c.key.endsWith('cost') || c.key === 'total' || c.key === 'grand_total') {
                        return <td key={c.key}>{money(p[c.key])}</td>;
                      }
                      return <td key={c.key}>{p[c.key]}</td>;
                    })}
                    <td>{p.item_id && <button type="button" className="btn btn-sm" disabled title="Reallocating stock isn't implemented in this build">Reallocate</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(() => {
            // Service lines are excluded outright, not just via back_order: a Transfer
            // Order moves stock between warehouses, and there is no labor to move.
            const shortItems = processes.filter((p) => p.item_id && !isNonStockItem(p.item_type) && num(p.back_order) > 0);
            if (!shortItems.length) return null;
            return (
              <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => handleCreateTO(shortItems)}>
                Create TO
              </button>
            );
          })()}
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
                {(jo.assembly_builds || []).map((ab) => (
                  <tr key={`ab-${ab.id}`}>
                    <td>{ab.date_created ? String(ab.date_created).slice(0, 10) : ''}</td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => navigate(`/assembly-builds/${ab.id}`)}>
                        {ab.ab_no}
                      </button>
                    </td>
                    <td>{ab.quantity_built}</td>
                    <td>{jo.units}</td>
                    <td>{ab.status === 'cancelled' ? 'Cancelled' : 'Saved'}</td>
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
          {canCreateRwip && isInProcess && (
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setShowRwip(true)}>Add</button>
          )}
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
      </div>

      {completingProcess && (
        <CompleteProcessModal
          process={completingProcess}
          onClose={() => setCompletingProcess(null)}
          onSaved={(amount) => handleSaveCompletion(completingProcess.id, amount)}
        />
      )}

      {showAssemblyBuild && (
        <AssemblyBuildModal
          jo={jo}
          onClose={() => setShowAssemblyBuild(false)}
          onSaved={handleAssemblyBuild}
        />
      )}

      {showQualityInspection && (
        <QualityInspectionModal
          jobOrderId={id}
          onClose={() => setShowQualityInspection(false)}
          onSaved={async (qi) => { setShowQualityInspection(false); await load(); navigate(`/quality-inspections/${qi.id}`); }}
        />
      )}

      {showRwip && (
        <RwipCreateModal
          jobOrderId={id}
          onClose={() => setShowRwip(false)}
          onSaved={async () => { setShowRwip(false); await load(); setTab('rwip'); }}
        />
      )}
    </div>
  );
}
