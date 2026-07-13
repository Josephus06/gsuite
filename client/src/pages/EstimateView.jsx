import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

// Read-only counterpart to EstimateWizard (which stays the create/edit form): mirrors
// the real system's estimate detail screen -- a summary banner with status-driven
// actions, then the full Job Order / Process breakdown and totals, all display-only.
const STATUS_LABELS = {
  pending_supervisor_approval: 'Pending Supervisor Approval',
  pending_customer_approval: 'Pending Customer Approval',
  approved: 'Approved',
  cancelled: 'Cancelled',
  disapproved: 'Disapproved',
};

const JOB_VIEW_COLUMNS = [
  { key: 'job_type_name', label: 'Job Type' },
  { key: 'nstdjo_no', label: 'NSTDJO#' },
  { key: 'job_location_name', label: 'Job Location' },
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Qty' },
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
  { key: 'shipping', label: 'Shipping' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'delivery_date', label: 'Delivery Date', render: (r) => (r.delivery_date ? String(r.delivery_date).slice(0, 10) : '') },
  { key: 'delivery_time', label: 'Delivery Time' },
  { key: 'gp_rate', label: 'GP Rate', render: (r) => (r.gp_rate != null ? `${r.gp_rate}%` : '') },
];

const PROCESS_VIEW_COLUMNS = [
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
  { key: 'process_price', label: 'Process Price' },
  { key: 'process_disc_percent', label: 'Process Disc %' },
  { key: 'process_disc_amount', label: 'Process Disc Amt' },
  { key: 'disc_process_price', label: 'Disc Process Price' },
  { key: 'material_price', label: 'Material Price' },
  { key: 'material_disc_percent', label: 'Material Disc %' },
  { key: 'material_disc_amount', label: 'Material Disc Amt' },
  { key: 'disc_material_price', label: 'Disc Material Price' },
  { key: 'net_of_tax', label: 'Net of Tax' },
  { key: 'tax_amount', label: 'Tax Amt' },
  { key: 'gross_amount', label: 'Gross Amt' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'gp_rate', label: 'GP Rate', render: (r) => (r.gp_rate != null ? `${r.gp_rate}%` : '') },
  { key: 'process_cost', label: 'Process Cost' },
  { key: 'material_cost', label: 'Material Cost' },
  { key: 'total_cost', label: 'Total Cost' },
  { key: 'total_price', label: 'Total Price' },
];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }

export default function EstimateView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();

  const [estimate, setEstimate] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [tab, setTab] = useState('job');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await api.get(`/estimates/${id}`);
    setEstimate(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/estimates/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function setStatus(newStatus) {
    setBusy(true);
    try {
      await api.put(`/estimates/${id}/status`, { status: newStatus });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (estimate.status === 'pending_supervisor_approval') return setStatus('pending_customer_approval');
    if (estimate.status === 'pending_customer_approval') return setStatus('approved');
  }

  async function handleReplicate() {
    if (!confirm('Replicate this estimate into a new draft?')) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/estimates/${id}/replicate`);
      navigate(`/estimates/${data.id}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading || !estimate) return <LoadingSpinner />;

  const jobOrders = estimate.jobOrders || [];
  const subtotal = jobOrders.reduce((s, jo) => s + num(jo.subtotal), 0);
  const discountTotal = jobOrders.reduce((s, jo) => s + num(jo.disc_amount), 0);
  const netOfTax = subtotal - discountTotal;
  const taxTotal = jobOrders.reduce((s, jo) => s + num(jo.tax_amount), 0);
  const totalAmount = netOfTax + taxTotal;
  const totalCost = jobOrders.reduce((s, jo) => s + (jo.processes || []).reduce((ps, p) => ps + num(p.total_cost), 0), 0);
  const gpAmount = netOfTax - totalCost;
  const gpRate = netOfTax ? (gpAmount / netOfTax) * 100 : 0;

  const isPending = estimate.status === 'pending_supervisor_approval' || estimate.status === 'pending_customer_approval';
  const canEdit = can('/estimates', 'can_edit');
  const canAdd = can('/estimates', 'can_add');
  // Approving out of "pending supervisor approval" specifically requires the Can
  // Approve Sales Estimate flag from the user's Account Type settings (Step 4 of the
  // user wizard) -- without it the Approve button doesn't even show at that stage.
  // Once it's moved to pending_customer_approval, any editor can advance it further.
  const canShowApprove = estimate.status === 'pending_supervisor_approval'
    ? !!user?.can_approve_sales_estimate
    : true;
  // The real system only shows Print once an estimate has cleared supervisor
  // approval -- printing a still-pending quotation isn't meaningful yet.
  const canShowPrint = estimate.status === 'pending_customer_approval' || estimate.status === 'approved';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/estimates')}>Back</button>
          {canEdit && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/estimates/${id}/edit`)}>Edit</button>}
          {canShowPrint && <button className="btn btn-sm btn-primary" onClick={() => window.open(`/estimates/${id}/print`, '_blank')}>Print</button>}
          {canEdit && isPending && canShowApprove && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {canEdit && isPending && <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setStatus('disapproved')}>Disapprove</button>}
          {canAdd && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleReplicate}>Replicate</button>}
        </div>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Estimate</h1>
          <span className="estimate-no">{estimate.estimate_no}</span>
        </div>
        <div className="estimate-status">
          {STATUS_LABELS[estimate.status] || estimate.status}
          {estimate.sales_order_no && (
            <button type="button" className="estimate-so-link" onClick={() => navigate(`/sales-orders/${estimate.sales_order_id}`)}>
              {estimate.sales_order_no}
            </button>
          )}
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer Details</h4>
            <div className="hi">{estimate.customer_name}</div>
            <div>Contact Name : <span className="hi">{estimate.contact_name}</span></div>
            <div>Contact Title : <span className="hi">{estimate.contact_title}</span></div>
            <div>Contact Email : <span className="hi">{estimate.contact_email}</span></div>
            <div>Contact Phone : <span className="hi">{estimate.contact_phone}</span></div>
            <div>Blanket PO : <span className="hi">{estimate.blanket_po_no}</span></div>
            <div>Blanket PO Memo : <span className="hi">{estimate.blanket_po_memo}</span></div>
          </div>
          <div>
            <h4>Estimate Details</h4>
            <div>Date Created : <span className="hi">{estimate.date_created ? String(estimate.date_created).slice(0, 10) : ''}</span></div>
            <div>Sales Division : <span className="hi">{estimate.sales_division_name}</span></div>
            <div>Office Location : <span className="hi">{estimate.office_location_name}</span></div>
            <div>Contract Desc. : <span className="hi">{estimate.contract_description}</span></div>
            <div>Memo : <span className="hi">{estimate.memo}</span></div>
            <div>Shipping Address : <span className="hi">{estimate.shipping_address}</span></div>
          </div>
          <div>
            <h4>Other Details</h4>
            <div>Sales Rep : <span className="hi">{estimate.sales_rep_name}</span></div>
            <div>Prepared By : <span className="hi">{estimate.prepared_by_name}</span></div>
            <div>Approved By : <span className="hi">{estimate.approved_by_name}</span></div>
            <div>Production Lead Time : <span className="hi">{estimate.production_lead_time}</span></div>
            <div>Price Validity : <span className="hi">{estimate.price_validity}</span></div>
            <div>Order Confirmation : <span className="hi">{estimate.order_confirmation_type}</span></div>
          </div>
          <div>
            <h4>Billing Details</h4>
            <div>Credit Term : <span className="hi">{estimate.credit_term}</span></div>
            <div>Credit Limit : <span className="hi">{estimate.credit_limit}</span></div>
            <div>Credit Balance : <span className="hi">{estimate.credit_balance}</span></div>
            <div>Bill to Contact Number : <span className="hi">{estimate.bill_to_contact_number}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'job' ? 'active' : ''}`} onClick={() => setTab('job')}>Job</button>
        <button className={`status-tab ${tab === 'gp' ? 'active' : ''}`} onClick={() => setTab('gp')}>GP Computations</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'job' && (
        <div className="card">
          {jobOrders.length === 0 && <p className="muted">No job orders.</p>}
          {jobOrders.map((jo, idx) => (
            <div key={jo.id} className="jo-view-block">
              <div className="jo-view-index">#{idx + 1}</div>
              <div className="table-wrap">
                <table>
                  <thead><tr>{JOB_VIEW_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    <tr>{JOB_VIEW_COLUMNS.map((c) => <td key={c.key}>{c.render ? c.render(jo) : jo[c.key]}</td>)}</tr>
                  </tbody>
                </table>
              </div>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table>
                  <thead><tr><th>#</th>{PROCESS_VIEW_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    {(jo.processes || []).map((p, pi) => (
                      <tr key={p.id}>
                        <td>{pi + 1}</td>
                        {PROCESS_VIEW_COLUMNS.map((c) => <td key={c.key}>{c.render ? c.render(p) : p[c.key]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'gp' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'job_type_name', label: 'Job Type' },
              { key: 'description', label: 'Description' },
              { key: 'quantity', label: 'Qty' },
              { key: 'subtotal', label: 'Subtotal', render: (r) => money(r.subtotal) },
              { key: 'total_cost', label: 'Total Cost', render: (r) => money((r.processes || []).reduce((s, p) => s + num(p.total_cost), 0)) },
              // Net of Tax = Subtotal - Disc Amt (mirrors the footer's formula) rather than
              // the row's own net_of_tax column, which isn't auto-derived at the job-order
              // level yet and would otherwise read as 0 here.
              { key: 'net_of_tax', label: 'Net of Tax', render: (r) => money(num(r.subtotal) - num(r.disc_amount)) },
              {
                key: 'gp_amount',
                label: 'GP Amount',
                render: (r) => {
                  const cost = (r.processes || []).reduce((s, p) => s + num(p.total_cost), 0);
                  const net = num(r.subtotal) - num(r.disc_amount);
                  return money(net - cost);
                },
              },
              {
                key: 'gp_rate',
                label: 'GP Rate',
                render: (r) => {
                  const cost = (r.processes || []).reduce((s, p) => s + num(p.total_cost), 0);
                  const net = num(r.subtotal) - num(r.disc_amount);
                  return net ? `${(((net - cost) / net) * 100).toFixed(2)}%` : '';
                },
              },
            ]}
            rows={jobOrders}
            emptyLabel="No job orders."
          />
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <div className="field-row">
            <div className="field"><label>Created At</label><input readOnly value={estimate.created_at ? new Date(estimate.created_at).toLocaleString() : ''} /></div>
            <div className="field"><label>Last Updated</label><input readOnly value={estimate.updated_at ? new Date(estimate.updated_at).toLocaleString() : ''} /></div>
          </div>
          <h3 className="subsection">Audit Trail</h3>
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
        <div><span className="muted">Est. GP Rate</span><div className="hi-lg">{gpRate.toFixed(2)}%</div></div>
        <div><span className="muted">Est. GP Amount</span><div className="hi-lg">{money(gpAmount)}</div></div>
        <div><span className="muted">Total Cost</span><div className="hi-lg">{money(totalCost)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(netOfTax)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(discountTotal)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(taxTotal)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(totalAmount)}</div></div>
      </div>
    </div>
  );
}
