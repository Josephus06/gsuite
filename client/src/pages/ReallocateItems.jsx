import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

// Mirrors the real "Reallocate Items" screen -- reached from a Transfer Order line's
// Reallocate button. On-hand stock at a location is a *shared* pool: every pending
// Transfer Order line wanting the same item out of the same location shows up here as a
// competing row, and Committed only ever changes through this screen (never through
// Fulfill itself). A freshly-raised TO sits at Committed 0, unfulfillable, until someone
// commits it some of that shared pool here.
export default function ReallocateItems() {
  const { id, lineId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [committedInputs, setCommittedInputs] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/transfer-orders/lines/${lineId}/reallocate`).then(({ data: d }) => {
      setData(d);
      const inputs = {};
      d.candidates.forEach((c) => {
        const ordered = Number(c.adjusted_qty ?? c.qty);
        const remaining = ordered - Number(c.fulfilled || 0);
        const isTriggering = c.transfer_order_line_id === d.triggering_line_id;
        inputs[c.transfer_order_line_id] = isTriggering && Number(c.committed || 0) === 0
          ? remaining
          : Number(c.committed || 0);
      });
      setCommittedInputs(inputs);
      setSelected(new Set([d.triggering_line_id]));
      setLoading(false);
    });
  }, [lineId]);

  function toggle(lineId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId); else next.add(lineId);
      return next;
    });
  }

  async function handleSubmit() {
    setError('');
    const lines = [...selected].map((lid) => ({ transfer_order_line_id: lid, committed: committedInputs[lid] || 0 }));
    if (!lines.length) { setError('Select at least one order to commit qty to.'); return; }
    setSaving(true);
    try {
      await api.post(`/transfer-orders/lines/${lineId}/reallocate`, { lines });
      navigate(`/transfer-orders/${id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !data) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Reallocate Items</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/transfer-orders/${id}`)}>Back</button>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={handleSubmit}>Submit</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Item</label>
            <input disabled value={`${data.item.item_code} — ${data.item.display_name}`} />
          </div>
          <div className="field">
            <label>Location</label>
            <input disabled value={data.location.location_name} />
          </div>
        </div>

        <div className="estimate-detail-grid" style={{ marginTop: 16 }}>
          <div>
            <div>Quantity On Hand (SU) : <span className="hi">{qty(data.qty_on_hand)}</span></div>
            <div>Quantity Committed (SU) : <span className="hi">{qty(data.qty_committed)}</span></div>
          </div>
          <div>
            <div>Quantity On Hand (BU) : <span className="hi">{qty(data.qty_on_hand)}</span></div>
            <div>Quantity Committed (BU) : <span className="hi">{qty(data.qty_committed)}</span></div>
          </div>
          <div>
            <div>Quantity Required : <span className="hi">—</span></div>
            <div>Quantity Picked : <span className="hi">—</span></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th><th>Order Date</th><th>Date Needed</th><th>Order No.</th><th>Customer</th>
                <th>Quantity Ordered</th><th>Quantity Remaining</th><th>Quantity Committed</th><th>Unit</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((c) => {
                const ordered = Number(c.adjusted_qty ?? c.qty);
                const remaining = ordered - Number(c.fulfilled || 0);
                return (
                  <tr key={c.transfer_order_line_id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(c.transfer_order_line_id)}
                        onChange={() => toggle(c.transfer_order_line_id)}
                      />
                    </td>
                    <td>{formatDate(c.order_date)}</td>
                    <td>{formatDate(c.date_needed)}</td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => navigate(`/transfer-orders/${c.to_id}`)}>{c.to_no}</button>
                    </td>
                    <td>—</td>
                    <td>{qty(ordered)}</td>
                    <td>{qty(remaining)}</td>
                    <td>
                      <input
                        type="number" step="0.0001" style={{ width: 100 }}
                        value={committedInputs[c.transfer_order_line_id] ?? 0}
                        onChange={(e) => setCommittedInputs((prev) => ({ ...prev, [c.transfer_order_line_id]: e.target.value }))}
                      />
                    </td>
                    <td>{c.unit}</td>
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
