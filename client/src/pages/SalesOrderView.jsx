import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import SalesInvoiceModal from '../components/SalesInvoiceModal';
import LoadingSpinner from '../components/LoadingSpinner';

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
  { key: 'tax_code', label: 'Tax Code' },
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

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function SalesOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [so, setSo] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [creatingLineId, setCreatingLineId] = useState(null);
  const [showBillMenu, setShowBillMenu] = useState(false);
  const [showSIModal, setShowSIModal] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [deliveries, setDeliveries] = useState([]);

  function load() {
    return api.get(`/sales-orders/${id}`).then(({ data }) => { setSo(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'related') {
      api.get(`/sales-invoices/by-sales-order/${id}`).then(({ data }) => setInvoices(data));
      api.get(`/item-deliveries/by-sales-order/${id}`).then(({ data }) => setDeliveries(data));
    }
  }, [tab, id]);

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
  const hasInvoiceableLine = lines.some((l) => l.job_order_id && Number(l.quantity_delivered || 0) > Number(l.quantity_invoiced || 0));
  const canEdit = can('/sales-orders', 'can_edit');
  const subtotal = lines.reduce((s, l) => s + num(l.subtotal), 0);
  const discountTotal = lines.reduce((s, l) => s + num(l.disc_amount), 0);
  const netOfTax = subtotal - discountTotal;
  const taxTotal = lines.reduce((s, l) => s + (num(l.subtotal) - num(l.disc_amount)) * (num(l.tax_rate) / 100), 0);
  const totalAmount = netOfTax + taxTotal;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/sales-orders')}>Back</button>
          {hasDeliverableLine && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/sales-orders/${id}/item-delivery/new`)}>Item Delivery</button>}
          {hasInvoiceableLine && (
            <div style={{ position: 'relative' }}>
              <button className="btn btn-sm btn-primary" onClick={() => setShowBillMenu((s) => !s)}>Bill ▾</button>
              {showBillMenu && (
                <div className="card" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, padding: 6, minWidth: 80 }}>
                  <button type="button" className="btn btn-sm" disabled style={{ width: '100%', marginBottom: 4 }} title="Billing Statements aren't implemented in this build">BS</button>
                  <button type="button" className="btn btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => { setShowBillMenu(false); setShowSIModal(true); }}>SI</button>
                  <button type="button" className="btn btn-sm" disabled style={{ width: '100%', marginBottom: 4 }} title="Delivery Receipts aren't implemented in this build">DR</button>
                  <button type="button" className="btn btn-sm" disabled style={{ width: '100%' }} title="Delivery Tickets aren't implemented in this build">DT</button>
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
            <div>Sales Rep : <span className="hi">{so.sales_rep_name}</span></div>
            <div>Prepared By : <span className="hi">{so.prepared_by_name}</span></div>
            <div>Approved By : <span className="hi">{so.approved_by_name}</span></div>
            <div>Production Lead Time : <span className="hi">{so.production_lead_time}</span></div>
            <div>Price Validity : <span className="hi">{so.price_validity}</span></div>
            <div>Order Confirmation : <span className="hi">{so.order_confirmation_type}</span></div>
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
                {invoices.length === 0 && deliveries.length === 0 && (
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
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>Invoice</td>
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

      {tab === 'system' && (
        <div className="card">
          <div className="field-row">
            <div className="field"><label>Created At</label><input readOnly value={so.created_at ? new Date(so.created_at).toLocaleString() : ''} /></div>
            <div className="field"><label>Last Updated</label><input readOnly value={so.updated_at ? new Date(so.updated_at).toLocaleString() : ''} /></div>
          </div>
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
          onClose={() => setShowSIModal(false)}
          onSaved={async (si) => { setShowSIModal(false); await load(); navigate(`/sales-invoices/${si.id}`); }}
        />
      )}
    </div>
  );
}
