import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import SalesInvoiceModal from '../components/SalesInvoiceModal';
import DeliveryTicketModal from '../components/DeliveryTicketModal';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import { displayDateTime } from '../utils/dates';

// Read-only Sales Order detail -- mirrors EstimateView.jsx's layout (banner + 4-column
// details + tabs + totals footer), since the real system's Sales Order screen is
// structurally the estimate screen's sibling. No process sub-rows here (the real
// system's "Items" tab is flatter than the estimate's "Job" tab), and no
// Approve/Disapprove/Print actions since orders don't go through that workflow --
// they exist because the estimate they came from already did.
const STATUS_LABELS = {
  pending_for_jo: 'Pending for JO',
  jo_in_process: 'JO In-Process',
  pending_delivery: 'Pending Delivery',
  partially_delivered: 'Partially Delivered',
  pending_billing: 'Pending Billing',
  pending_billing_partially_delivered: 'Pending Billing / Partially Delivered',
  billed: 'Billed',
  cancelled: 'Cancelled',
};

const LINE_COLUMNS = [
  { key: 'job_type_name', label: 'Job Type' },
  { key: 'job_location_name', label: 'Job Location' },
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Qty' },
  { key: 'quantity_built', label: 'Built', render: (r) => (r.job_order_id ? Number(r.quantity_built || 0) : '') },
  { key: 'quantity_inspected', label: 'QI', render: (r) => (r.job_order_id ? Number(r.quantity_inspected || 0) : '') },
  { key: 'quantity_delivered', label: 'Delivered', render: (r) => (r.job_order_id ? Number(r.quantity_delivered || 0) : '') },
  { key: 'quantity_invoiced', label: 'Invoiced', render: (r) => (r.job_order_id ? Number(r.quantity_invoiced || 0) : '') },
  { key: 'units', label: 'Units' },
  { key: 'price_per_unit', label: 'Price/Unit' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'disc_percent', label: 'Disc %' },
  { key: 'disc_amount', label: 'Disc Amt' },
  { key: 'disc_price_per_unit', label: 'Disc Price/Unit' },
  { key: 'net_of_tax', label: 'Net of Tax' },
  { key: 'tax_code', label: 'Tax Code' },
  { key: 'tax_amount', label: 'Tax Amt' },
  { key: 'gross_amount', label: 'Gross Amt' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
  { key: 'uom', label: 'UOM' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'delivery_date', label: 'Delivery Date', render: (r) => (r.delivery_date ? String(r.delivery_date).slice(0, 10) : '') },
  { key: 'delivery_time', label: 'Delivery Time' },
  { key: 'gp_rate', label: 'GP Rate', render: (r) => (r.gp_rate != null ? `${r.gp_rate}%` : '') },
];

function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Edits made on the Sales Order (PUT /sales-orders/:id), newest first.
function SoHistory({ id }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/sales-orders/${id}/audit-logs`).then((r) => setRows(r.data)).catch(() => setRows([])); }, [id]);
  if (!rows) return null;
  if (!rows.length) return <p className="muted" style={{ marginTop: 12 }}>No edits recorded.</p>;
  return (
    <div className="table-wrap" style={{ marginTop: 12 }}>
      <table>
        <thead><tr><th>Date Time</th><th>Set By</th><th>Field</th><th>Old Value</th><th>New Value</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{displayDateTime(r.set_at)}</td><td>{r.set_by_name}</td><td>{r.field_name}</td><td>{r.old_value}</td><td>{r.new_value}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export default function SalesOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  // Changing the Sales Rep (PUT /sales-orders/:id/sales-rep): a sales supervisor or SBU head (or a
  // System Admin), on an order not yet Billed or Cancelled. The order's Job Orders follow.
  const mayChangeRep = !!(user?.is_supervisor || user?.is_sales_business_unit || user?.account_type === 'System Admin');
  const [repOptions, setRepOptions] = useState(null);
  const [repError, setRepError] = useState('');
  async function openRepPicker() {
    setRepError('');
    try {
      const { data } = await api.get(`/sales-orders/${id}/sales-rep-options`);
      setRepOptions(data);
    } catch (err) {
      setRepError(err.response?.data?.error || 'Could not load the reps.');
    }
  }
  async function changeRep(emp) {
    if (!confirm(`Change the Sales Rep to ${emp.first_name} ${emp.last_name}? This order's Job Orders change with it.`)) return;
    setRepError('');
    try {
      await api.put(`/sales-orders/${id}/sales-rep`, { sales_rep_id: emp.id });
      setRepOptions(null);
      await load();
    } catch (err) {
      setRepError(err.response?.data?.error || 'Could not change the Sales Rep.');
    }
  }
  const [so, setSo] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [creatingLineId, setCreatingLineId] = useState(null);
  const [showBillMenu, setShowBillMenu] = useState(false);
  // Cancel (System Admin): a reason from Master Lists > Reasons ("Cancellation") and optional remarks.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReasons, setCancelReasons] = useState([]);
  const [cancelReasonId, setCancelReasonId] = useState('');
  const [cancelRemarks, setCancelRemarks] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  function openCancel() {
    setCancelError(''); setCancelReasonId(''); setCancelRemarks(''); setCancelOpen(true);
    api.get('/sales-orders/cancel-reasons').then(({ data }) => setCancelReasons(data))
      .catch((e) => setCancelError(e.response?.data?.error || 'Could not load the cancellation reasons.'));
  }
  async function confirmCancel() {
    if (!cancelReasonId) { setCancelError('Choose a reason.'); return; }
    setCancelling(true); setCancelError('');
    try {
      await api.put(`/sales-orders/${id}/cancel`, { reason_id: Number(cancelReasonId), remarks: cancelRemarks });
      setCancelOpen(false);
      load();
    } catch (e) {
      setCancelError(e.response?.data?.error || 'Cancel failed.');
    } finally {
      setCancelling(false);
    }
  }
  const [showSIModal, setShowSIModal] = useState(false);
  // SI or DR: both are raised through the same Create form and differ only in type.
  const [billType, setBillType] = useState('SI');
  const [showDTModal, setShowDTModal] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [canManageAttachments, setCanManageAttachments] = useState(false);
  const [uploading, setUploading] = useState(false);
  const attachmentInputRef = useRef(null);

  function load() {
    return api.get(`/sales-orders/${id}`).then(({ data }) => { setSo(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'related') {
      api.get(`/sales-invoices/by-sales-order/${id}`).then(({ data }) => setInvoices(data));
      api.get(`/item-deliveries/by-sales-order/${id}`).then(({ data }) => setDeliveries(data));
      // Delivery Tickets bill the order too (their quantity counts as billed while they are open),
      // so they belong here. Their own permission: someone who cannot read DTs just sees none.
      api.get(`/delivery-tickets/by-sales-order/${id}`).then(({ data }) => setTickets(data)).catch(() => setTickets([]));
    }
    if (tab === 'attachments') {
      api.get(`/sales-orders/${id}/attachments`)
        .then(({ data }) => {
          setAttachments(data.attachments || []);
          setCanManageAttachments(!!data.canManage);
        })
        .catch(() => { setAttachments([]); setCanManageAttachments(false); });
    }
  }, [tab, id]);

  // Fetched through the API rather than linked with a bare href so the request carries the
  // auth header -- the file endpoints are behind requireAuth like everything else. The two
  // sources live in different tables, so `source` decides which route to ask.
  async function openAttachment(row) {
    setAttachmentError('');
    const path = row.source === 'order'
      ? `/sales-orders/${id}/order-attachments/${row.id}/file`
      : `/sales-orders/${id}/attachments/${row.id}/file`;
    try {
      const { data } = await api.get(path, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      window.open(url, '_blank');
      // Revoked on a delay: revoking immediately can beat the new tab to the object.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setAttachmentError('Could not open that file.');
    }
  }

  async function uploadAttachment(file) {
    if (!file) return;
    setAttachmentError('');
    // Checked here as well as on the server so the user finds out before spending a minute
    // uploading something that will be refused.
    if (file.size > 10 * 1024 * 1024) {
      setAttachmentError(`"${file.name}" is ${fileSize(file.size)}. Files must be 10MB or smaller.`);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file'));
        reader.readAsDataURL(file);
      });
      const { data: row } = await api.post(`/sales-orders/${id}/order-attachments`, {
        file_name: file.name, mime_type: file.type, data,
      });
      setAttachments((prev) => [...prev, row]);
    } catch (err) {
      setAttachmentError(err.response?.data?.error || err.message || 'Upload failed.');
    } finally {
      setUploading(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  }

  async function removeAttachment(attachmentId, name) {
    if (!confirm(`Remove "${name}"?`)) return;
    setAttachmentError('');
    setUploading(true);
    try {
      await api.delete(`/sales-orders/${id}/order-attachments/${attachmentId}`);
      setAttachments((prev) => prev.filter((a) => !(a.source === 'order' && a.id === attachmentId)));
    } catch (err) {
      setAttachmentError(err.response?.data?.error || 'Could not remove that file.');
    } finally {
      setUploading(false);
    }
  }


  async function handleCreateJo(lineId) {
    setCreatingLineId(lineId);
    try {
      const { data: jobOrder } = await api.post(`/sales-orders/${id}/lines/${lineId}/create-jo`);
      setSo((prev) => ({
        ...prev,
        status: prev.status === 'pending_for_jo' ? 'jo_in_process' : prev.status,
        lines: prev.lines.map((l) => (l.id === lineId
          ? { ...l, job_order_id: jobOrder.id, job_order_no: jobOrder.job_order_no, job_order_status: jobOrder.status }
          : l)),
      }));
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to create Job Order');
    } finally {
      setCreatingLineId(null);
    }
  }

  if (loading || !so) return <LoadingSpinner />;

  const lines = so.lines || [];
  // "Item Delivery" only makes sense once at least one JO line has something both Built
  // and QI'd that hasn't shipped yet -- mirrors the create form's own eligibility filter,
  // so the button doesn't open onto an empty form.
  const hasDeliverableLine = lines.some((l) => {
    const cap = Math.min(Number(l.quantity_built || 0), Number(l.quantity_inspected || 0));
    return cap - Number(l.quantity_delivered || 0) > 0;
  });
  // "Bill" only makes sense once at least one JO line has been delivered but not yet
  // (fully) invoiced -- mirrors the Create SI form's own eligibility filter.
  // A Billed (or Cancelled) order offers no Bill at all, whatever its line counters say -- on
  // migrated orders quantity_invoiced was not always carried over, so the counters alone kept
  // the button up on orders the source had already billed.
  const isClosedForBilling = so.status === 'billed' || so.status === 'cancelled';
  const hasInvoiceableLine = !isClosedForBilling
    && lines.some((l) => l.job_order_id && Number(l.quantity_delivered || 0) > Number(l.quantity_invoiced || 0));
  const canEdit = can('/sales-orders', 'can_edit');
  // Raising a delivery is Item Delivery's own permission now, not Sales Orders'. Without this
  // the button would show to anyone who can read the order and only fail on save.
  const canRaiseDelivery = can('/item-deliveries', 'can_add');
  // Bill had never been given the same treatment: it showed to anyone who could read the order,
  // so a rep could fill in the whole Create SI form -- SI #, PO #, withholding tax -- and only
  // then be told no. These two mirror what the servers actually ask for, so the menu offers what
  // it can deliver. Billing a Sales Order wants can_edit at Head Office and only can_view at a
  // branch (requireInvoiceCreatePermission in routes/salesInvoices.js explains why);
  // user.is_head_office is resolved server-side by the same helper that decides the real thing.
  const canBillSI = can('/sales-invoices', user?.is_head_office === false ? 'can_view' : 'can_edit');
  const canBillDT = can('/delivery-tickets', 'can_edit');
  // Totals to the centavo, as the sum of each line's own 2-decimal figures -- the Tax Amt column
  // above, and the way the estimate totals it. Net x rate per line, unrounded and summed, read
  // 305.36 / 2,850.01 under lines whose Tax Amt adds up to 305.35 (SO-195471 from EST-205221).
  const r2 = (v) => Math.round(v * 100) / 100;
  const lineTax = (l) => (l.tax_amount != null && l.tax_amount !== ''
    ? num(l.tax_amount)
    : r2((num(l.subtotal) - num(l.disc_amount)) * (num(l.tax_rate) / 100)));
  const subtotal = r2(lines.reduce((s, l) => s + num(l.subtotal), 0));
  const discountTotal = r2(lines.reduce((s, l) => s + num(l.disc_amount), 0));
  const netOfTax = r2(subtotal - discountTotal);
  const taxTotal = r2(lines.reduce((s, l) => s + lineTax(l), 0));
  const totalAmount = r2(netOfTax + taxTotal);

  return (
    <div>
      {cancelOpen && (
        <Modal title={`Cancel ${so.sales_order_no}`} onClose={() => !cancelling && setCancelOpen(false)}>
          {cancelError && <div className="error-banner">{cancelError}</div>}
          <div className="field">
            <label>Reason <span className="req">*</span></label>
            <select value={cancelReasonId} onChange={(e) => setCancelReasonId(e.target.value)}>
              <option value="">--Select--</option>
              {cancelReasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>From Master Lists &gt; Reasons, type Cancellation.</div>
          </div>
          <div className="field"><label>Remarks</label><textarea rows={3} value={cancelRemarks} onChange={(e) => setCancelRemarks(e.target.value)} /></div>
          <p className="muted" style={{ fontSize: 13 }}>Its job orders that are not yet Completed are cancelled too. An order already billed or delivered cannot be cancelled.</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" disabled={cancelling} onClick={() => setCancelOpen(false)}>Back</button>
            <button className="btn btn-danger" disabled={cancelling} onClick={confirmCancel}>{cancelling ? 'Cancelling...' : 'Cancel Sales Order'}</button>
          </div>
        </Modal>
      )}
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/sales-orders')}>Back</button>
          {/* System Admin only (the server enforces it too). */}
          {user?.account_type === 'System Admin' && !String(so.status || '').toLowerCase().includes('cancel') && (
            <button className="btn btn-sm" onClick={() => navigate(`/sales-orders/${id}/edit`)}>Edit</button>
          )}
          {user?.account_type === 'System Admin' && so.status !== 'cancelled' && (
            <button className="btn btn-sm btn-danger" onClick={openCancel}>Cancel</button>
          )}
          {hasDeliverableLine && canRaiseDelivery && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/sales-orders/${id}/item-delivery/new`)}>Item Delivery</button>}
          {hasInvoiceableLine && (canBillSI || canBillDT) && (
            <div style={{ position: 'relative' }}>
              <button className="btn btn-sm btn-primary" onClick={() => setShowBillMenu((s) => !s)}>Bill ▾</button>
              {showBillMenu && (
                <div className="card" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, padding: 6, minWidth: 80 }}>
                  <button type="button" className="btn btn-sm" disabled style={{ width: '100%', marginBottom: 4 }} title="Billing Statements aren't implemented in this build">BS</button>
                  {canBillSI && <button type="button" className="btn btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => { setShowBillMenu(false); setBillType('SI'); setShowSIModal(true); }}>SI</button>}
                  {canBillSI && <button type="button" className="btn btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => { setShowBillMenu(false); setBillType('DR'); setShowSIModal(true); }}>DR</button>}
                  {canBillDT && <button type="button" className="btn btn-sm" style={{ width: '100%' }} onClick={() => { setShowBillMenu(false); setShowDTModal(true); }}>DT</button>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Sales Order</h1>
          <span className="estimate-no">{so.sales_order_no}</span>
        </div>
        <div className="estimate-status">
          {STATUS_LABELS[so.status] || so.status}
          {so.status === 'cancelled' && so.cancel_reason_name && (
            <span style={{ marginLeft: 8, fontSize: '0.85em' }}>
              — {so.cancel_reason_name}{so.cancel_remarks ? `: ${so.cancel_remarks}` : ''}{so.cancelled_by_name ? ` (by ${so.cancelled_by_name})` : ''}
            </span>
          )}
          <button type="button" className="estimate-so-link" onClick={() => navigate(`/estimates/${so.estimate_id}`)}>
            {so.estimate_no}
          </button>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer Details</h4>
            <div className="hi">{so.customer_name}</div>
            <div>Contact Name : <span className="hi">{so.contact_name}</span></div>
            <div>Contact Title : <span className="hi">{so.contact_title}</span></div>
            <div>Contact Email : <span className="hi">{so.contact_email}</span></div>
            <div>Contact Phone : <span className="hi">{so.contact_phone}</span></div>
            <div>Blanket PO : <span className="hi">{so.blanket_po_no}</span></div>
            <div>Blanket PO Memo : <span className="hi">{so.blanket_po_memo}</span></div>
          </div>
          <div>
            <h4>Estimate Details</h4>
            <div>Date Created : <span className="hi">{so.date_created ? String(so.date_created).slice(0, 10) : ''}</span></div>
            <div>Sales Division : <span className="hi">{so.sales_division_name}</span></div>
            <div>Office Location : <span className="hi">{so.office_location_name}</span></div>
            <div>Contract Desc. : <span className="hi">{so.contract_description}</span></div>
            <div>Ref # : <span className="hi">{so.ref_no}</span></div>
            <div>Memo : <span className="hi">{so.memo}</span></div>
            <div>Shipping Address : <span className="hi">{so.shipping_address}</span></div>
          </div>
          <div>
            <h4>Other Details</h4>
            <div>
              Sales Rep : <span className="hi">{so.sales_rep_name}</span>
              {mayChangeRep && !['billed', 'cancelled'].includes(so.status) && (
                repOptions ? (
                  <span style={{ display: 'inline-block', minWidth: 220, marginLeft: 8, verticalAlign: 'middle' }}>
                    <EntityPicker
                      label="Sales Rep" items={repOptions} value={so.sales_rep_id || ''}
                      getLabel={(e) => `${e.first_name} ${e.last_name}`}
                      columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }, { key: 'position_title', label: 'Position' }]}
                      searchKeys={['first_name', 'last_name']}
                      onSelect={changeRep}
                    />
                    <button type="button" className="link-btn" style={{ marginLeft: 6 }} onClick={() => setRepOptions(null)}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={openRepPicker}>Edit</button>
                )
              )}
              {repError && <div className="error-banner" style={{ marginTop: 4 }}>{repError}</div>}
            </div>
            <div>Prepared By : <span className="hi">{so.prepared_by_name}</span></div>
            <div>Approved By : <span className="hi">{so.approved_by_name}</span></div>
            <div>Production Lead Time : <span className="hi">{so.production_lead_time}</span></div>
            <div>Price Validity : <span className="hi">{so.price_validity}</span></div>
            <div>Order Confirmation : <span className="hi">{so.order_confirmation_type}</span></div>
            {/* The customer's confirmation number -- the source prints it as "PO #". */}
            <div>PO # : <span className="hi">{so.order_confirmation_ref}</span></div>
          </div>
          <div>
            <h4>Billing Details</h4>
            <div>Credit Term : <span className="hi">{so.credit_term}</span></div>
            <div>Credit Limit : <span className="hi">{so.credit_limit}</span></div>
            <div>Credit Balance : <span className="hi">{so.credit_balance}</span></div>
            <div>Bill to Contact Number : <span className="hi">{so.bill_to_contact_number}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'attachments' ? 'active' : ''}`} onClick={() => setTab('attachments')}>Attachment</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>JO #</th>{LINE_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={LINE_COLUMNS.length + 2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items.</td></tr>
                )}
                {lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>{idx + 1}</td>
                    <td>
                      {l.job_order_id ? (
                        <button type="button" className="link-btn" onClick={() => navigate(`/job-orders/${l.job_order_id}`)}>
                          {l.job_order_no}
                        </button>
                      ) : (
                        <button type="button" className="link-btn" disabled={creatingLineId === l.id} onClick={() => handleCreateJo(l.id)}>
                          {creatingLineId === l.id ? 'Creating...' : 'Create JO'}
                        </button>
                      )}
                    </td>
                    {LINE_COLUMNS.map((c) => <td key={c.key}>{c.render ? c.render(l) : l[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <p>Originating Estimate: <button type="button" className="btn btn-sm" onClick={() => navigate(`/estimates/${so.estimate_id}`)}>{so.estimate_no}</button></p>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {invoices.length === 0 && deliveries.length === 0 && tickets.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records yet.</td></tr>
                )}
                {deliveries.map((del) => (
                  <tr key={`del-${del.id}`}>
                    <td>Item Delivery</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/item-deliveries/${del.id}`)}>{del.delivery_no}</button></td>
                    <td>{del.date_created ? String(del.date_created).slice(0, 10) : ''}</td>
                    <td></td>
                    <td>{del.status === 'cancelled' ? 'Cancelled' : 'Saved'}</td>
                  </tr>
                ))}
                {tickets.map((t) => (
                  <tr key={`dt-${t.id}`}>
                    <td>Delivery Ticket</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/delivery-tickets/${t.id}`)}>{t.dt_no}</button></td>
                    <td>{t.date_created ? String(t.date_created).slice(0, 10) : ''}</td>
                    <td>{money(t.gross_amount)}</td>
                    <td>{{ open: 'Open', converted: 'Converted', void: 'Void' }[t.status] || t.status}</td>
                  </tr>
                ))}
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.invoice_type === 'DR' ? 'DR' : 'Invoice'}</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-invoices/${inv.id}`)}>{inv.invoice_no}</button></td>
                    <td>{inv.date_created ? String(inv.date_created).slice(0, 10) : ''}</td>
                    <td>{money(inv.gross_amount)}</td>
                    <td>{inv.status === 'cancelled' ? 'Cancelled' : 'Saved'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'attachments' && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Files on this order. Those marked Estimate came across from
            {so.estimate_no ? <> <button type="button" className="link-btn" onClick={() => navigate(`/estimates/${so.estimate_id}`)}>{so.estimate_no}</button></> : ' the estimate'}
            {' '}and are read-only here; anything added below belongs to the order itself.
          </p>
          {attachmentError && <div className="error-banner" style={{ marginBottom: 12 }}>{attachmentError}</div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>File</th><th>Source</th><th>Type</th><th>Size</th><th>Uploaded By</th><th>Uploaded</th><th></th></tr></thead>
              <tbody>
                {attachments.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No files on this order yet.</td></tr>
                )}
                {attachments.map((a, idx) => (
                  <tr key={`${a.source}-${a.id}`}>
                    <td>{idx + 1}</td>
                    <td><button type="button" className="link-btn" onClick={() => openAttachment(a)}>{a.file_name}</button></td>
                    <td>{a.source === 'order' ? 'This order' : 'Estimate'}</td>
                    <td>{a.mime_type === 'application/pdf' ? 'PDF' : (String(a.mime_type || '').startsWith('image/') ? 'Image' : a.mime_type)}</td>
                    <td>{fileSize(a.size_bytes)}</td>
                    <td>{a.uploaded_by_name || ''}</td>
                    <td>{a.created_at ? displayDateTime(a.created_at) : ''}</td>
                    <td>
                      {/* Only the order's own files can be removed here -- an estimate's
                          paperwork is managed on the estimate. */}
                      {canManageAttachments && a.source === 'order' && (
                        <button type="button" className="btn btn-sm btn-danger" disabled={uploading} onClick={() => removeAttachment(a.id, a.file_name)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canManageAttachments ? (
            <div style={{ marginTop: 12 }}>
              <input
                ref={attachmentInputRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/gif,image/webp,image/bmp,image/tiff"
                disabled={uploading}
                onChange={(e) => uploadAttachment(e.target.files?.[0])}
              />
              <div className="muted" style={{ fontSize: '0.85em', marginTop: 4 }}>
                PDF or image, up to 10MB. {uploading && 'Uploading...'}
              </div>
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
              Only the rep this order is booked under can attach files to it.
            </p>
          )}
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <div className="field-row">
            <div className="field"><label>Created At</label><input readOnly value={so.created_at ? displayDateTime(so.created_at) : ''} /></div>
            <div className="field"><label>Last Updated</label><input readOnly value={so.updated_at ? displayDateTime(so.updated_at) : ''} /></div>
          </div>
          <SoHistory id={id} />
        </div>
      )}

      <div className="estimate-footer card">
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(netOfTax)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(discountTotal)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(taxTotal)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(totalAmount)}</div></div>
      </div>

      {showSIModal && (
        <SalesInvoiceModal
          salesOrderId={Number(id)}
          invoiceType={billType}
          onClose={() => setShowSIModal(false)}
          onSaved={async (si) => { setShowSIModal(false); await load(); navigate(`/sales-invoices/${si.id}`); }}
        />
      )}

      {showDTModal && (
        <DeliveryTicketModal
          salesOrderId={Number(id)}
          onClose={() => setShowDTModal(false)}
          onSaved={async (dt) => { setShowDTModal(false); await load(); navigate(`/delivery-tickets/${dt.id}`); }}
        />
      )}
    </div>
  );
}
