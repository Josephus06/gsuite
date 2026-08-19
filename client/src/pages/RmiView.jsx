import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

// The single-document view, laid out like the live RMI screen: header fields above, then the
// Materials grid. Read-only -- these are the migrated historical documents, and raising or
// receiving one is separate work.
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

export default function RmiView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [rmi, setRmi] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/rmis/${id}`).then(({ data }) => { if (alive) setRmi(data); });
    return () => { alive = false; };
  }, [id]);

  if (!rmi) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>{rmi.rmi_no}</h1>
        <div className="spreadsheet-row-actions">
          <button className="btn btn-sm" onClick={() => navigate('/rmis')}>Back to Lists</button>
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
    </div>
  );
}
