import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { useAuth } from '../context/useAuth';

// The single-document view, laid out like the live RMI screen: header fields above, then the
// Materials grid. New ones are raised on RmiForm; Receive (can_update on /rmis) takes in what
// arrived, line by line, and moves the stock -- see POST /rmis/:id/receive.
const LABEL = {
  pending_receipt: 'Pending Receipt',
  partially_received: 'Partially Received',
  received: 'Received',
  cancelled: 'Cancelled',
};

function qty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
const date = (v) => (v ? String(v).slice(0, 10) : '');
// A blank field reads as "-" rather than as an empty gap, matching the other view screens.
const show = (v) => (v === null || v === undefined || v === '' ? '-' : v);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const outstanding = (l) => Math.max(Number((Number(l.qty) - Number(l.received)).toFixed(4)), 0);

export default function RmiView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [rmi, setRmi] = useState(null);
  const [receiving, setReceiving] = useState(null); // { date, qty: { [lineId]: string } } while the modal is open
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get(`/rmis/${id}`).then(({ data }) => setRmi(data));
  useEffect(() => {
    let alive = true;
    api.get(`/rmis/${id}`).then(({ data }) => { if (alive) setRmi(data); });
    return () => { alive = false; };
  }, [id]);

  if (!rmi) return <LoadingSpinner />;

  const canReceive = can('/rmis', 'can_update') && ['pending_receipt', 'partially_received'].includes(rmi.status);
  // Opens on everything still outstanding -- the usual case is that it all arrived.
  const openReceive = () => {
    setError('');
    setReceiving({ date: today(), qty: Object.fromEntries(rmi.lines.map((l) => [l.id, String(outstanding(l))])) });
  };
  async function submitReceive() {
    setError('');
    const lines = rmi.lines.map((l) => ({ rmi_line_id: l.id, qty: Number(receiving.qty[l.id] || 0) })).filter((l) => l.qty > 0);
    if (!lines.length) { setError('Enter a quantity received on at least one line.'); return; }
    setSaving(true);
    try {
      await api.post(`/rmis/${id}/receive`, { date_received: receiving.date, lines });
      setReceiving(null);
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not receive this RMI.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{rmi.rmi_no}</h1>
        <div className="spreadsheet-row-actions">
          <Link className="btn btn-sm" to={'/rmis'}>Back to Lists</Link>
          {canReceive && <button className="btn btn-sm btn-primary" onClick={openReceive}>Receive</button>}
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="estimate-status">{LABEL[rmi.status] || rmi.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Details</h4>
            <div>Date Created : <span className="hi">{date(rmi.date_created)}</span></div>
            <div>Returned By : <span className="hi">{show(rmi.returned_by_name)}</span></div>
          </div>
          <div>
            <h4>Movement</h4>
            <div>Return From : <span className="hi">{show(rmi.return_from_name)}</span></div>
            <div>Return To : <span className="hi">{show(rmi.return_to_name)}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{show(rmi.memo)}</span></div>
            {rmi.received_at && <div>Received : <span className="hi">{date(rmi.received_at)}</span></div>}
            {rmi.cancelled_at && <div>Cancelled : <span className="hi">{date(rmi.cancelled_at)}</span></div>}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Materials</h3>
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead>
              <tr>
                <th>Item</th>
                <th>JO #</th>
                <th>Qty</th>
                <th>Received</th>
                <th>Qty on Hand</th>
                <th>UOM</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              {rmi.lines.length === 0 && (
                <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials on this RMI.</td></tr>
              )}
              {rmi.lines.map((l) => (
                <tr key={l.id}>
                  <td data-label="Item">{l.item_name || l.item_code}</td>
                  <td data-label="JO #">{show(l.job_order_no)}</td>
                  <td data-label="Qty">{qty(l.qty)}</td>
                  <td data-label="Received">{qty(l.received)}</td>
                  <td data-label="Qty on Hand">{qty(l.qty_on_hand)}</td>
                  <td data-label="UOM">{show(l.uom)}</td>
                  <td data-label="Unit">{show(l.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(rmi.receipts || []).length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Receipts</h3>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Date Received</th><th>Item</th><th>Qty</th><th>UOM</th><th>Received By</th></tr></thead>
              <tbody>
                {rmi.receipts.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Date Received">{date(r.date_received)}</td>
                    <td data-label="Item">{r.item_name || r.item_code}</td>
                    <td data-label="Qty">{qty(r.qty)}</td>
                    <td data-label="UOM">{show(r.uom)}</td>
                    <td data-label="Received By">{show(r.received_by_name)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {receiving && (
        <Modal title={`Receive ${rmi.rmi_no}`} onClose={() => !saving && setReceiving(null)} large>
          {error && <div className="error-banner">{error}</div>}
          <p className="muted" style={{ marginTop: 0 }}>
            From <b>{show(rmi.return_from_name)}</b> into <b>{show(rmi.return_to_name)}</b>. Enter what actually arrived;
            anything left short stays outstanding and can be received later.
          </p>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>Date Received</label>
            <input type="date" value={receiving.date} min={date(rmi.date_created)} onChange={(e) => setReceiving({ ...receiving, date: e.target.value })} />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Qty</th><th>Already Received</th><th>Outstanding</th><th>Receive Now</th><th>UOM</th></tr></thead>
              <tbody>
                {rmi.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.item_name || l.item_code}</td>
                    <td>{qty(l.qty)}</td>
                    <td>{qty(l.received)}</td>
                    <td>{qty(outstanding(l))}</td>
                    <td>
                      <input type="number" min="0" max={outstanding(l)} step="0.0001" style={{ width: 110 }} disabled={outstanding(l) <= 0}
                        value={receiving.qty[l.id] ?? ''}
                        onChange={(e) => setReceiving({ ...receiving, qty: { ...receiving.qty, [l.id]: e.target.value } })} />
                    </td>
                    <td>{show(l.uom)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" disabled={saving} onClick={() => setReceiving(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={submitReceive}>{saving ? 'Receiving...' : 'Receive'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
