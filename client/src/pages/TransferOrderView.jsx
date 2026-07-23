import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import ItemFulfillmentModal from '../components/ItemFulfillmentModal';
import ItemFulfillmentsPickerModal from '../components/ItemFulfillmentsPickerModal';
import ItemReceiptModal from '../components/ItemReceiptModal';
import LoadingSpinner from '../components/LoadingSpinner';
import { isNonStockItem } from '../utils/itemTypes';

// Mirrors the real "Transfer Order" view screen: banner + Items/Related Records/System
// Info tabs. Adjusted Qty is the one field that stays live-editable right here (not
// gated behind Edit) -- it's the real-world "tweak the amount right before you fulfill
// it" field, matching how the real screen highlights it as an input inline in the table.
// Status is entirely derived server-side (see computeTOStatus in routes/transferOrders.js)
// from each line's qty vs fulfilled vs received -- these six mirror the real system's
// list tabs exactly.
const STATUS_LABELS = {
  pending_fulfillment: 'Pending Fulfillment',
  partially_fulfilled: 'Partially Fulfilled',
  pending_receipt: 'Pending Receipt',
  pending_receipt_partially_fulfilled: 'Pending Receipt / Partially Fulfilled',
  received: 'Received',
  cancelled: 'Cancelled',
};
const CAN_STILL_FULFILL = ['pending_fulfillment', 'partially_fulfilled', 'pending_receipt_partially_fulfilled'];
const CAN_RECEIVE = ['pending_receipt', 'pending_receipt_partially_fulfilled'];

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

export default function TransferOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [to, setTo] = useState(null);
  const [lines, setLines] = useState([]);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);
  const [itemFulfillments, setItemFulfillments] = useState([]);
  const [showFulfillModal, setShowFulfillModal] = useState(false);
  const [showFulfillmentsPicker, setShowFulfillmentsPicker] = useState(false);
  const [receivingFulfillmentId, setReceivingFulfillmentId] = useState(null);

  function load() {
    return api.get(`/transfer-orders/${id}`).then(({ data }) => { setTo(data); setLines(data.lines || []); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/transfer-orders/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
    if (tab === 'related') {
      api.get(`/transfer-orders/${id}/item-fulfillments`).then(({ data }) => setItemFulfillments(data));
    }
  }, [tab, id]);

  async function commitAdjustedQty(lineId, value) {
    const row = lines.find((l) => l.id === lineId);
    await api.put(`/transfer-orders/${id}/lines/${lineId}`, { qty: row.qty, adjusted_qty: value === '' ? null : value, memo: row.memo });
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, adjusted_qty: value === '' ? null : value } : l)));
  }

  async function handleCancel() {
    if (!confirm('Cancel this transfer order?')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/transfer-orders/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !to) return <LoadingSpinner />;

  const canEdit = can('/transfer-orders', 'can_edit');
  const canApprove = can('/transfer-orders', 'can_approve');
  const isPending = to.status === 'pending_fulfillment';
  const canStillFulfill = CAN_STILL_FULFILL.includes(to.status);
  const canReceive = CAN_RECEIVE.includes(to.status);
  const canCancel = to.status !== 'received' && to.status !== 'cancelled';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/transfer-orders')}>Back</button>
          {canEdit && isPending && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/transfer-orders/${id}/edit`)}>Edit</button>}
          {canApprove && canStillFulfill && lines.length > 0 && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setShowFulfillModal(true)}>Fulfill</button>}
          {canApprove && canReceive && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setShowFulfillmentsPicker(true)}>Receive</button>}
          {canEdit && canCancel && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Transfer Order</h1>
          <span className="estimate-no">{to.to_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[to.status] || to.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>TO # : <span className="hi">{to.to_no}</span></div>
            <div>Date : <span className="hi">{formatDate(to.date_created)}</span></div>
            <div>Date Needed : <span className="hi">{to.date_needed ? formatDate(to.date_needed) : '—'}</span></div>
          </div>
          <div>
            <div>Withdraw From : <span className="hi">{to.withdraw_from_name}</span></div>
            <div>Transfer To : <span className="hi">{to.transfer_to_name}</span></div>
            <div>Memo : <span className="hi">{to.memo || ''}</span></div>
          </div>
          <div>
            <div>Requestor : <span className="hi">{to.requestor_name || '—'}</span></div>
            {to.job_order_no && (
              <div>Job Order : <button type="button" className="link-btn" onClick={() => navigate(`/production/${to.job_order_id}`)}>{to.job_order_no}</button></div>
            )}
            {to.fulfilled_by_name && <div>Fulfilled By : <span className="hi">{to.fulfilled_by_name}</span></div>}
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
              <thead>
                <tr>
                  <th>Item</th><th>JO #</th><th>TO Count</th><th>Qty</th><th>UOM</th><th>Unit</th>
                  <th>Adjusted Qty</th><th>New Qty</th><th>Committed</th><th>Fulfilled</th><th>Received</th>
                  <th>Back Ordered</th><th>Qty On Hand</th><th>Memo</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={15} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials.</td></tr>
                )}
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => navigate(`/inventory/${l.item_id}`)}>
                        {l.item_code} {l.item_name ? `— ${l.item_name}` : ''}
                      </button>
                    </td>
                    <td>{to.job_order_id ? (
                      <button type="button" className="link-btn" onClick={() => navigate(`/production/${to.job_order_id}`)}>{l.job_order_no}</button>
                    ) : (l.job_order_no || '—')}</td>
                    <td>{l.to_count}</td>
                    <td>{qty(l.qty)}</td>
                    <td>{l.uom}</td>
                    <td>{l.unit}</td>
                    <td>
                      {canStillFulfill && canEdit ? (
                        <input
                          type="number" step="0.0001" style={{ width: 110 }} className="highlight-input"
                          defaultValue={l.adjusted_qty ?? ''}
                          onBlur={(e) => commitAdjustedQty(l.id, e.target.value)}
                        />
                      ) : (l.adjusted_qty != null ? qty(l.adjusted_qty) : '')}
                    </td>
                    <td>{qty(l.new_qty)}</td>
                    {/* Committed and Qty On Hand are stock figures that stay at zero for a
                        Service line no matter what -- showing 0.0000 reads as "out of
                        stock, go reallocate", which is the opposite of the truth. */}
                    <td>{isNonStockItem(l.item_type) ? <span className="muted">—</span> : qty(l.committed)}</td>
                    <td>{qty(l.fulfilled)}</td>
                    <td>{qty(l.received)}</td>
                    <td>{qty(l.back_ordered)}</td>
                    <td>{isNonStockItem(l.item_type) ? <span className="muted">—</span> : qty(l.qty_on_hand)}</td>
                    <td>{l.memo}</td>
                    <td>
                      {/* Reallocate divides a location's on-hand pool between competing
                          orders -- meaningless for a Service line, which has no pool to
                          divide and needs no commitment before it can be fulfilled. */}
                      {isNonStockItem(l.item_type)
                        ? <span className="muted" title="Service items hold no stock -- nothing to reallocate.">—</span>
                        : <button type="button" className="btn btn-sm" onClick={() => navigate(`/transfer-orders/${id}/lines/${l.id}/reallocate`)}>Reallocate</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th></tr></thead>
              <tbody>
                {!to.job_order_no && itemFulfillments.length === 0 && (
                  <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records.</td></tr>
                )}
                {to.job_order_no && (
                  <tr>
                    <td>Job Order</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/production/${to.job_order_id}`)}>{to.job_order_no}</button></td>
                    <td>—</td>
                  </tr>
                )}
                {itemFulfillments.map((f) => (
                  <tr key={f.id}>
                    <td>Item Fulfillment</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/transfer-orders/item-fulfillments/${f.id}`)}>{f.fulfillment_no}</button></td>
                    <td>{formatDate(f.date_created)}</td>
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

      {showFulfillModal && (
        <ItemFulfillmentModal
          to={to}
          lines={lines}
          onClose={() => setShowFulfillModal(false)}
          onSaved={async () => { setShowFulfillModal(false); await load(); }}
        />
      )}

      {showFulfillmentsPicker && (
        <ItemFulfillmentsPickerModal
          toId={id}
          onClose={() => setShowFulfillmentsPicker(false)}
          onAddNew={() => { setShowFulfillmentsPicker(false); setShowFulfillModal(true); }}
          onPickOpen={(f) => { setShowFulfillmentsPicker(false); setReceivingFulfillmentId(f.id); }}
          onPickClosed={(f) => { setShowFulfillmentsPicker(false); navigate(`/transfer-orders/item-fulfillments/${f.id}`); }}
        />
      )}

      {receivingFulfillmentId && (
        <ItemReceiptModal
          fulfillmentId={receivingFulfillmentId}
          onClose={() => setReceivingFulfillmentId(null)}
          onSaved={async (receipt) => { setReceivingFulfillmentId(null); await load(); navigate(`/transfer-orders/item-receipts/${receipt.id}`); }}
        />
      )}
    </div>
  );
}
