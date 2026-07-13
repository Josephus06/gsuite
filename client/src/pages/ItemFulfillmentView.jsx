import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

// Mirrors the real "Item Fulfillment" detail view -- reached from a Transfer Order's
// Related Records tab. Total Amount is derived on the fly (qty_fulfilled x each item's
// average_cost) rather than a stored/posted figure, same treatment as Inventory
// Adjustment's GL Impact tab -- there's no real Journal/GL module in this build.
export default function ItemFulfillmentView() {
  const { fulfillmentId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('items');
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/transfer-orders/item-fulfillments/${fulfillmentId}`).then(({ data: d }) => { setData(d); setLoading(false); });
  }, [fulfillmentId]);

  useEffect(() => {
    if (tab === 'related') {
      api.get(`/transfer-orders/item-fulfillments/${fulfillmentId}/item-receipts`).then(({ data: d }) => setReceipts(d));
    }
  }, [tab, fulfillmentId]);

  if (loading || !data) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/transfer-orders/${data.transfer_order_id}`)}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Item Fulfillment isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
        </div>
      </div>

      <div className="estimate-banner" style={{ position: 'relative' }}>
        <div className="estimate-banner-title">
          <h1>Item Fulfillment</h1>
          <span className="estimate-no">{data.fulfillment_no}</span>
        </div>
        <div className="estimate-status">{data.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Item Fulfillment # : <span className="hi">{data.fulfillment_no}</span></div>
            <div>Date : <span className="hi">{formatDate(data.date_created)}</span></div>
            <div>Created From : <button type="button" className="link-btn" onClick={() => navigate(`/transfer-orders/${data.transfer_order_id}`)}>{data.to_no}</button></div>
          </div>
          <div>
            <div>Withdraw From : <span className="hi">{data.withdraw_from_name}</span></div>
            <div>Transfer To : <span className="hi">{data.transfer_to_name}</span></div>
            <div>Memo : <span className="hi">{data.memo || ''}</span></div>
          </div>
          <div>
            <div>Requestor : <span className="hi">{data.requestor_name || '—'}</span></div>
          </div>
        </div>

        <div style={{ position: 'absolute', top: 24, right: 28, background: '#fff', borderRadius: 8, padding: '14px 20px', minWidth: 200 }}>
          <div className="muted" style={{ fontSize: 13 }}>Total Amount</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{money(data.total_amount)}</div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Item</th><th>Fulfill</th><th>Received</th><th>Qty On Hand</th><th>UOM</th><th>Unit</th></tr>
              </thead>
              <tbody>
                {data.lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>
                      <span style={{ color: '#db2777', fontWeight: 600, marginRight: 8 }}>{idx + 1}</span>
                      <button type="button" className="link-btn" onClick={() => navigate(`/inventory/${l.item_id}`)}>
                        {l.item_code} {l.item_name ? `— ${l.item_name}` : ''}
                      </button>
                    </td>
                    <td>{qty(l.qty_fulfilled)}</td>
                    <td>{qty(l.received)}</td>
                    <td>{qty(l.qty_on_hand)}</td>
                    <td>{l.uom}</td>
                    <td>{l.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <p className="muted">GL posting isn't modeled for Item Fulfillment in this build.</p>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th></tr></thead>
              <tbody>
                {receipts.length === 0 && (
                  <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Item Receipts yet.</td></tr>
                )}
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>Item Receipt</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/transfer-orders/item-receipts/${r.id}`)}>{r.receipt_no}</button></td>
                    <td>{formatDate(r.date_created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <p className="muted">No audit history for this record type.</p>
        </div>
      )}
    </div>
  );
}
