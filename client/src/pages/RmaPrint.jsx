import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import letterhead from '../assets/graphicstar-letterhead.png';

// Returned Material Authorization slip (asked 2026-10-08, in the live system's format) for an
// NSJO-RMA, an RFQC (Quality Inspection rework) or an RWIP (Production rework): A4, letterhead,
// client and job details, the processes with their items and qty, then Reason, Requested By and
// Action/s to be taken, and the Production Manager / RMA Investigation In-Charge sign-off.
//
// Read from GET /rma-job-orders/:id/print -- see server/src/routes/rmaJobOrders.js.

const qty = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
// "950 x 2450" -- blank when the line has no size (stored as 0 on unsized lines), as on the JO printout.
const size = (l) => {
  const a = Number(l.length) || 0; const b = Number(l.width) || 0;
  const f = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return a || b ? `${f(a)} x ${f(b)}` : '';
};
const longDate = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export default function RmaPrint() {
  const { id } = useParams();
  const [jo, setJo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/rma-job-orders/${id}/print`)
      .then(({ data }) => setJo(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this RMA.'));
  }, [id]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this RMA</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!jo) return <LoadingSpinner />;

  const row = (label, value) => (
    <div className="rma-row"><span className="rma-label">{label} :</span><span>{value || ''}</span></div>
  );

  return (
    <div className="rma">
      <style>{`
        .rma { background: #f1f5f9; padding: 16px 0 40px; }
        .rma-toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .rma-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 16mm; background: #fff; color: #1f2937;
          font-family: 'Poppins', system-ui, 'Segoe UI', sans-serif; font-size: 8.5pt; line-height: 1.5; box-shadow: 0 1px 6px rgba(0,0,0,.25);
          box-sizing: border-box; }
        .rma-head { display: flex; justify-content: space-between; align-items: flex-start; }
        .rma-logo { width: 62mm; height: auto; }
        .rma-addr { text-align: right; font-size: 7.5pt; color: #475569; line-height: 1.45; }
        .rma-title { text-align: center; font-size: 12pt; font-weight: 500; color: #374151; margin: 9mm 0 7mm; }
        .rma-cols { display: flex; justify-content: space-between; gap: 10mm; }
        .rma-cols > div:first-child { flex: 1.4; }
        .rma-cols > div:last-child { flex: 1; }
        .rma-row { display: flex; gap: 4mm; }
        .rma-label { flex: 0 0 26mm; }
        .rma-table { width: 100%; border-collapse: collapse; margin-top: 7mm; font-size: 7.5pt; }
        .rma-table th { text-align: left; font-weight: 400; padding: 5px 4px; border-top: 1px solid #374151; border-bottom: 1px solid #374151; }
        .rma-table td { padding: 5px 4px; border-bottom: 1px solid #d1d5db; vertical-align: top; }
        .rma-num { text-align: right !important; }
        .rma-block { display: flex; gap: 4mm; margin-top: 9mm; }
        .rma-block .rma-label { flex: 0 0 34mm; }
        .rma-block > span:last-child { white-space: pre-wrap; flex: 1; }
        .rma-sign { display: flex; justify-content: space-between; margin-top: 10mm; }
        .rma-sign > div { display: flex; gap: 4mm; align-items: flex-start; }
        .rma-line { width: 52mm; text-align: center; }
        .rma-line .who { min-height: 1.4em; }
        .rma-line .rule { border-top: 1px solid #111827; }
        @media print {
          html, body, #root, .rma { background: #fff !important; }
          .rma { padding: 0; }
          .rma-no-print { display: none !important; }
          /* Ends where its content does: a full 297mm plus rounding spills a blank second page. */
          .rma-sheet { box-shadow: none; margin: 0; min-height: 0; }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      <div className="rma-toolbar rma-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="rma-sheet">
        <div className="rma-head">
          <img className="rma-logo" src={letterhead} alt="GraphicStar Imaging Corp." />
          <div className="rma-addr">
            GraphicStar Building<br />
            J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Phillipines<br />
            Tel. #238-1234<br />
            www.graphicstar.com.ph
          </div>
        </div>
        <div className="rma-title">Returned Material Authorization (RMA)</div>
        <div className="rma-cols">
          <div>
            {row('Client', jo.customer_name)}
            {row('Address', jo.customer_address)}
            {row('Job Description', jo.description)}
            {row('Sales Rep', jo.sales_rep_name)}
            {row('Artist', jo.artist_name)}
            {row('Office Location', jo.office_location_name)}
          </div>
          <div>
            {row('RMA #', jo.job_order_no)}
            {row('Date', longDate(jo.date))}
            {row('SO #', jo.so_no)}
            {/* The mother job order an RFQC / RWIP reworks; an NSJO-RMA has none. */}
            {row('JO #', jo.parent_job_order_no)}
            {row('JO Qty.', qty(jo.quantity))}
            {row('Job Location', jo.job_location_name)}
          </div>
        </div>

        <table className="rma-table">
          <thead>
            <tr><th style={{ width: '5%' }}>#</th><th style={{ width: '28%' }}>Process</th><th>Item</th><th className="rma-num" style={{ width: '8%' }}>Qty</th><th style={{ width: '14%', textAlign: 'center' }}>Size</th><th style={{ width: '8%', textAlign: 'center' }}>UOM</th></tr>
          </thead>
          <tbody>
            {(jo.lines || []).length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center' }}>No processes.</td></tr>}
            {(jo.lines || []).map((l, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{l.process_name || ''}</td>
                <td>{l.item_name || ''}</td>
                <td className="rma-num">{Number(l.qty || 0).toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                <td style={{ textAlign: 'center' }}>{size(l)}</td>
                <td style={{ textAlign: 'center' }}>{l.uom || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="rma-block"><span className="rma-label">Reason :</span><span>{jo.reason_text}</span></div>
        <div className="rma-block"><span className="rma-label">Requested By :</span><span>{jo.requested_by}</span></div>
        <div className="rma-block"><span className="rma-label">Action/s to be taken :</span><span>{jo.action_to_be_taken || ''}</span></div>

        <div className="rma-sign">
          <div>
            <span>Approved By :</span>
            <div className="rma-line"><div className="who">{jo.approved_by_name || ''}</div><div className="rule" />Production Manager</div>
          </div>
          <div>
            <span>Noted By :</span>
            <div className="rma-line"><div className="who" /><div className="rule" />RMA Investigation In-Charge</div>
          </div>
        </div>
      </div>
    </div>
  );
}
