import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function size(l) {
  const parts = [l.length, l.width, l.height].map((n) => (n === null || n === undefined ? null : Number(n)));
  return parts.every((n) => n === null) ? '' : parts.map((n) => (n === null ? '0' : n)).join(' x ');
}

// Mirrors the real "Item Delivery" screen -- a full page (not a modal), reached from a
// Sales Order's Item Delivery button. Only JO lines with something both Built and QI'd
// that hasn't shipped yet show up; each line's Qty to Deliver is capped at
// min(quantity_built, quantity_inspected) - quantity_delivered, enforced server-side.
export default function ItemDelivery() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [qtyToDeliver, setQtyToDeliver] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/item-deliveries/for-sales-order/${id}`).then(({ data: d }) => { setData(d); setLoading(false); });
  }, [id]);

  if (loading || !data) return <LoadingSpinner />;

  async function handleSave() {
    setError('');
    const payload = data.lines
      .map((l) => ({ job_order_id: l.job_order_id, qty_to_deliver: qtyToDeliver[l.job_order_id] || 0 }))
      .filter((l) => Number(l.qty_to_deliver) > 0);
    if (!payload.length) { setError('Enter a Qty to Deliver for at least one item.'); return; }

    setSaving(true);
    try {
      await api.post('/item-deliveries', { sales_order_id: Number(id), date_created: dateCreated, memo, lines: payload });
      navigate(`/sales-orders/${id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Item Delivery</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/sales-orders/${id}`)}>Back to Lists</button>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date</label>
            <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
          </div>
          <div className="field">
            <label>Memo</label>
            <textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
          <div className="field">
            <label>Customer</label>
            <input disabled value={data.customer_name || ''} />
          </div>
          <div className="field">
            <label>Created Form</label>
            <div><button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${id}`)}>{data.sales_order_no}</button></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Items</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>JO #</th><th>Item</th><th>Description</th><th>Ship To</th>
                <th>Qty Inspected</th><th>Qty Delivered</th><th>Qty to Deliver</th><th>Unit</th><th>Size</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.length === 0 && (
                <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing left to deliver.</td></tr>
              )}
              {data.lines.map((l) => {
                const cap = Math.min(Number(l.quantity_built || 0), Number(l.quantity_inspected || 0)) - Number(l.quantity_delivered || 0);
                return (
                  <tr key={l.job_order_id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/production/${l.job_order_id}`)}>{l.job_order_no}</button></td>
                    <td>{l.item_name}</td>
                    <td>{l.description}</td>
                    <td>{l.job_location_name}</td>
                    <td>{qty(l.quantity_inspected)}</td>
                    <td>{qty(l.quantity_delivered)}</td>
                    <td>
                      <input
                        type="number" step="0.0001" max={cap} style={{ width: 100 }}
                        value={qtyToDeliver[l.job_order_id] ?? ''}
                        onChange={(e) => setQtyToDeliver((prev) => ({ ...prev, [l.job_order_id]: e.target.value }))}
                      />
                    </td>
                    <td>{l.units}</td>
                    <td>{size(l)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
