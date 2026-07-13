import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import VendorBillModal from '../components/VendorBillModal';
import LoadingSpinner from '../components/LoadingSpinner';

const STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  pending_approval_gm: 'Pending Approval for GM',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

const RECEIPT_STATUS_LABELS = {
  not_received: null,
  partially_received: 'Partially Received',
  fully_received: 'Fully Received',
};

// Once a PO is fully received there's nothing left to approve or receive -- the real
// system's Status field itself moves on from "Approved by X" to "Pending Billing"
// (waiting on a Vendor Bill) to "Billed" once every received line has also been fully
// billed, with SubStatus showing "Fully Received" separately throughout.
function statusLabel(po) {
  if (po.status === 'approved') {
    if (po.receipt_status === 'fully_received') {
      return po.bill_status === 'fully_billed' ? 'Billed' : 'Pending Billing';
    }
    return po.approved_by_gm_user_id ? 'Approved by General Manager' : 'Approved by Supervisor';
  }
  return STATUS_LABELS[po.status] || po.status;
}

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

export default function PurchaseOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [po, setPo] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);
  const [landedCosts, setLandedCosts] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [returns, setReturns] = useState([]);
  const [bills, setBills] = useState([]);
  const [showBillModal, setShowBillModal] = useState(false);

  function load() {
    return api.get(`/purchase-orders/${id}`).then(({ data }) => { setPo(data); setLoading(false); });
  }

  function loadRelated() {
    api.get(`/purchase-orders/${id}/receipts`).then(({ data }) => setReceipts(data));
    api.get(`/purchase-orders/${id}/returns`).then(({ data }) => setReturns(data));
    api.get(`/vendor-bills/by-purchase-order/${id}`).then(({ data }) => setBills(data));
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/purchase-orders/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
    if (tab === 'landed') {
      api.get(`/purchase-orders/${id}/landed-costs`).then(({ data }) => setLandedCosts(data));
    }
    if (tab === 'related') {
      loadRelated();
    }
  }, [tab, id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCancel() {
    if (!confirm('Cancel this Purchase Order? Its ordered qty will be reversed off the source PR.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/purchase-orders/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!confirm('Approve this Purchase Order?')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/purchase-orders/${id}/approve`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !po) return <LoadingSpinner />;

  const canEdit = can('/purchase-orders', 'can_edit');
  const canApprovePO = can('/purchase-orders', 'can_approve');
  const canCancel = po.status !== 'cancelled';
  const showApprove = canApprovePO && (
    (po.status === 'pending_approval' && !!user?.is_supervisor)
    || (po.status === 'pending_approval_gm' && user?.account_type === 'System Admin')
  );
  const showReceive = canEdit && po.type !== 'PO2' && po.status === 'approved' && po.receipt_status !== 'fully_received';
  const showVendorReturn = canEdit && po.type !== 'PO2' && po.receipt_status !== 'not_received';
  // "Bill" only makes sense once at least one line has been received but not yet
  // (fully) billed -- mirrors the Create Vendor Bill form's own eligibility filter.
  const hasBillableLine = canEdit && po.lines.some((l) => Number(l.received_qty || 0) > Number(l.billed_qty || 0));

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/purchase-orders')}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Purchase Order isn't implemented in this build">Edit</button>
          {showReceive && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/purchase-orders/${id}/receive`)}>Receive</button>}
          {hasBillableLine && <button className="btn btn-sm btn-primary" onClick={() => setShowBillModal(true)}>Bill</button>}
          {showVendorReturn && <button className="btn btn-sm" onClick={() => navigate(`/purchase-orders/${id}/return`)}>Vendor Return</button>}
          {showApprove && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {canEdit && canCancel && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Purchase Order</h1>
          <span className="estimate-no">{po.po_no}</span>
        </div>
        <div className="estimate-status">
          {statusLabel(po)}
          {RECEIPT_STATUS_LABELS[po.receipt_status] && <span style={{ opacity: 0.7 }}> · {RECEIPT_STATUS_LABELS[po.receipt_status]}</span>}
        </div>

        <div className="estimate-detail-grid">
          <div>
            <div>Supplier : <span className="hi">{po.supplier_name}</span></div>
            <div>Date Created : <span className="hi">{formatDate(po.date_created)}</span></div>
            {po.need_by_date && <div>Need by Date : <span className="hi">{formatDate(po.need_by_date)}</span></div>}
            <div>Term : <span className="hi">{po.term_name || '—'}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{po.memo || ''}</span></div>
            {po.type === 'PO2' && po.parent_po_no && (
              <div>Landed Cost of : <button type="button" className="link-btn" onClick={() => navigate(`/purchase-orders/${po.parent_purchase_order_id}`)}>{po.parent_po_no}</button></div>
            )}
          </div>
          <div>
            <div>Created By : <span className="hi">{po.created_by_name || '—'}</span></div>
            <div>Type : <span className="hi">{po.type}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Subtotal</span><div className="hi-lg">{money(po.subtotal)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(po.discount_amount)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(po.net_of_tax)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(po.tax_amount)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(po.total_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        {po.type !== 'PO2' && po.status === 'approved' && (
          <button className={`status-tab ${tab === 'landed' ? 'active' : ''}`} onClick={() => setTab('landed')}>Landed Cost</button>
        )}
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  {po.type === 'PO1' && <th>PR #</th>}
                  {po.type !== 'PO2' && <><th>Location</th><th>Department</th></>}
                  {po.type === 'PO3' && <th>JO #</th>}
                  <th>Qty</th><th>Unit</th><th>Rate</th><th>Disc %</th>
                  <th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Ext. Price</th><th>Received</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>
                      <span style={{ color: '#db2777', fontWeight: 600, marginRight: 8 }}>{idx + 1}</span>
                      <button type="button" className="link-btn" onClick={() => navigate(`/inventory/${l.item_id}`)}>
                        {l.item_code} {l.item_name ? `— ${l.item_name}` : ''}
                      </button>
                    </td>
                    {po.type === 'PO1' && <td>{l.pr_no || '—'}</td>}
                    {po.type !== 'PO2' && (
                      <>
                        <td>{l.location_name || '—'}</td>
                        <td>{l.department_name || '—'}</td>
                      </>
                    )}
                    {po.type === 'PO3' && <td>{l.job_order_no || '—'}</td>}
                    <td>{qty(l.qty)}</td>
                    <td>{l.unit_title}</td>
                    <td>{money(l.rate)}</td>
                    <td>{l.disc_percent}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.ext_price)}</td>
                    <td>{qty(l.received_qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'landed' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>PO #</th><th>Date</th><th>Vendor</th><th>Term</th><th>Amount</th><th>Memo</th><th>Status</th></tr>
              </thead>
              <tbody>
                {landedCosts.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Landed Cost yet.</td></tr>
                )}
                {landedCosts.map((lc) => (
                  <tr key={lc.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/purchase-orders/${lc.id}`)}>{lc.po_no}</button></td>
                    <td>{formatDate(lc.date_created)}</td>
                    <td>{lc.supplier_name}</td>
                    <td>{lc.term_name || '—'}</td>
                    <td>{money(lc.total_amount)}</td>
                    <td>{lc.memo || ''}</td>
                    <td>{STATUS_LABELS[lc.status] || lc.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => navigate(`/purchase-orders/${id}/landed-cost/new`)}>Create PO</button>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {po.type === 'PO2' && po.parent_po_no && (
                  <tr>
                    <td>Purchase Order</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/purchase-orders/${po.parent_purchase_order_id}`)}>{po.parent_po_no}</button></td>
                    <td>—</td>
                    <td>—</td>
                    <td>Parent</td>
                  </tr>
                )}
                {receipts.map((r) => (
                  <tr key={`rr-${r.id}`}>
                    <td>Receiving Report</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/purchase-orders/receipts/${r.id}`)}>{r.receipt_no}</button></td>
                    <td>{formatDate(r.date_created)}</td>
                    <td>{money(r.total_amount)}</td>
                    <td>{r.is_on_hold ? 'On Hold' : 'Open'}</td>
                  </tr>
                ))}
                {returns.map((r) => (
                  <tr key={`vr-${r.id}`}>
                    <td>Vendor Return</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/purchase-orders/returns/${r.id}`)}>{r.return_no}</button></td>
                    <td>{formatDate(r.date_created)}</td>
                    <td>{money(r.total_amount)}</td>
                    <td>—</td>
                  </tr>
                ))}
                {bills.map((b) => (
                  <tr key={`vb-${b.id}`}>
                    <td>Vendor Bill</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/vendor-bills/${b.id}`)}>{b.bill_no}</button></td>
                    <td>{formatDate(b.date_created)}</td>
                    <td>{money(b.gross_amount)}</td>
                    <td>{b.status === 'cancelled' ? 'Cancelled' : 'Open'}</td>
                  </tr>
                ))}
                {receipts.length === 0 && returns.length === 0 && bills.length === 0 && !(po.type === 'PO2' && po.parent_po_no) && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records yet.</td></tr>
                )}
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

      {showBillModal && (
        <VendorBillModal
          purchaseOrderId={id}
          onClose={() => setShowBillModal(false)}
          onSaved={(vb) => { setShowBillModal(false); navigate(`/vendor-bills/${vb.id}`); }}
        />
      )}
    </div>
  );
}
