import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

// Printable Job Order -- the production sheet. Two pages, mirroring the live Report Viewer:
//   1. Letterhead, order header, the JOBS block, the SPECIFICATIONS table.
//   2. FOR LOGISTICS (Ship Confirmations) -- the slip that travels with the delivery.
//
// Printing is gated server-side (GET /job-orders/:id/print): System Admin prints any JO at
// any status, everyone else needs can_print on /job-orders AND a JO with an artist assigned.
// This page renders whatever refusal the server gives rather than deciding for itself, so
// the rule lives in exactly one place.
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}
function fmtDateTime(dateVal, timeVal) {
  const d = fmtDate(dateVal);
  if (!d || !timeVal) return d;
  const [h, m] = String(timeVal).split(':');
  const hr = Number(h);
  if (!Number.isFinite(hr)) return d;
  const ampm = hr >= 12 ? 'PM' : 'AM';
  return `${d} ${String(hr % 12 || 12).padStart(2, '0')}:${m || '00'} ${ampm}`;
}
function num(v, dp = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : '';
}
// The live report prints "null x null" when a process carries no dimensions, and this data
// stores those as 0. Either way there is no size to show, so print nothing rather than a
// meaningless "0 x 0".
function dims(l, w) {
  const a = Number(l) || 0;
  const b = Number(w) || 0;
  return a || b ? `${a} x ${b}` : '';
}

function Row({ label, children }) {
  return (
    <div className="jo-row">
      <span className="jo-lbl">{label} :</span>
      <span className="jo-val">{children}</span>
    </div>
  );
}

export default function JobOrderPrint() {
  const { id } = useParams();
  const [jo, setJo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/job-orders/${id}/print`)
      .then(({ data }) => setJo(data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load this Job Order.'));
  }, [id]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this Job Order</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!jo) return <LoadingSpinner />;

  // A JO with no dimensions (a per-piece job) has 0 length and width -- show the unit alone
  // rather than "0.00 x 0.00 x PC/S".
  const hasSize = (Number(jo.length) || 0) || (Number(jo.width) || 0);
  const sizeLine = hasSize
    ? `${num(jo.length)} x ${num(jo.width)}${jo.units ? ` x ${jo.units}` : ''}`
    : (jo.units || '');
  const shipTo = jo.shipping_address || jo.so_shipping_address || '';

  return (
    <div className="jo-print">
      <style>{`
        .jo-print { background: #f1f5f9; padding: 16px 0 40px; }
        .jo-sheet {
          width: 210mm; min-height: 297mm; margin: 0 auto 16px; padding: 14mm 16mm;
          background: #fff; color: #1f2937; font-family: system-ui, 'Segoe UI', sans-serif;
          font-size: 9pt; line-height: 1.5; box-shadow: 0 1px 6px rgba(0,0,0,.25);
        }
        .jo-toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .jo-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
        .jo-brand { font-size: 20pt; font-weight: 800; color: #1e3a8a; letter-spacing: -0.5px; }
        .jo-brand span { color: #ea580c; }
        .jo-brand-sub { font-size: 7.5pt; font-weight: 700; color: #1e3a8a; letter-spacing: 2px; }
        .jo-addr { text-align: right; font-size: 7.5pt; color: #64748b; line-height: 1.45; }
        .jo-title { text-align: center; font-size: 15pt; color: #1e3a8a; font-weight: 600; margin: 6px 0 18px; }
        .jo-cols { display: flex; justify-content: space-between; gap: 20px; }
        .jo-row { display: flex; gap: 6px; }
        .jo-lbl { min-width: 34mm; color: #334155; }
        .jo-val { font-weight: 500; }
        .jo-right { text-align: left; white-space: nowrap; }
        .jo-order-id { color: #1e3a8a; font-weight: 600; letter-spacing: .3px; }
        .jo-band { text-align: center; color: #1e3a8a; margin: 20px 0 10px; letter-spacing: .5px; }
        .jo-table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        .jo-table th { text-align: left; font-weight: 600; color: #334155; border-bottom: 1px solid #cbd5e1; padding: 6px 6px; font-size: 8.5pt; }
        .jo-table td { padding: 6px 6px; vertical-align: top; white-space: normal; border: none; }
        .jo-table .jo-idx { color: #ea580c; width: 8mm; }
        /* Fixed widths on the trailing numeric columns: without them Process and Item take
           everything and "2 x 7" wraps onto two lines. */
        .jo-table .jo-qty { width: 12mm; }
        .jo-table .jo-size { width: 26mm; }
        .jo-table .jo-uom { width: 14mm; }
        .jo-table tr.jo-sub td { padding-top: 0; padding-bottom: 10px; color: #64748b; border-bottom: 1px solid #e2e8f0; }
        .jo-mid { text-align: center; }
        @media print {
          .jo-print { background: none; padding: 0; }
          .jo-no-print { display: none !important; }
          @page { size: A4 portrait; margin: 0; }
          .jo-sheet { box-shadow: none; margin: 0; page-break-after: always; }
          .jo-sheet:last-child { page-break-after: auto; }
        }
      `}</style>

      <div className="jo-toolbar jo-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      {/* ---------------- Page 1 ---------------- */}
      <div className="jo-sheet">
        <div className="jo-head">
          <div>
            <div className="jo-brand">GRAPHIC<span>STAR</span></div>
            <div className="jo-brand-sub">IMAGING CORP.</div>
          </div>
          <div className="jo-addr">
            <strong>GraphicStar Building</strong><br />
            J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Phillipines<br />
            Tel. #238-1234<br />
            www.graphicstar.com.ph
          </div>
        </div>

        <div className="jo-title">Job Order</div>

        <div className="jo-cols">
          <div style={{ flex: 1 }}>
            <Row label="Contract Description">{jo.contract_description}</Row>
            <Row label="Client">{jo.customer_name}</Row>
            <Row label="Start Date">{fmtDate(jo.so_date)}</Row>
            <Row label="Payment Term">{jo.credit_term}</Row>
            <Row label="Sales Exec">{jo.sales_rep_name}</Row>
            <Row label="Sales Division">{jo.sales_division_name}</Row>
          </div>
          <div className="jo-right">
            <div className="jo-order-id">ORDER ID : {jo.sales_order_no}</div>
            <div style={{ marginTop: 6 }}>No. of Job Orders: 1</div>
          </div>
        </div>

        <div className="jo-band">JOBS</div>

        <Row label="Job Order #">{jo.job_order_no}</Row>
        <Row label="Job Type Desc">{jo.description || jo.job_type_name}</Row>
        <Row label="Size">{sizeLine}</Row>
        <Row label="Quantity">{num(jo.quantity, 0)}</Row>
        <Row label="Delivery Date">{fmtDateTime(jo.delivery_date, jo.delivery_time)}</Row>
        <Row label="Ship To Address">{shipTo}</Row>
        <Row label="Ship To Contact">{jo.contact_name}</Row>
        <Row label="Memo">{jo.memo}</Row>
        {/* No warranty field exists on a job order; the blank is on the live report too. */}
        <Row label="Warranty">{''}</Row>
        <Row label="Artist Name">{jo.artist_name}</Row>

        <div className="jo-band">SPECIFICATIONS</div>

        <table className="jo-table">
          <thead>
            <tr>
              <th className="jo-idx">#</th>
              <th>Process</th>
              <th>Item</th>
              <th className="jo-mid jo-qty">Qty</th>
              <th className="jo-mid jo-size">Size</th>
              <th className="jo-mid jo-uom">UOM</th>
            </tr>
          </thead>
          <tbody>
            {jo.processes.map((p, i) => (
              <Fragment key={i}>
                <tr>
                  <td className="jo-idx">{p.line_no ?? i + 1}</td>
                  <td>{p.process_name}</td>
                  <td>{p.item_name}</td>
                  <td className="jo-mid jo-qty">{num(p.qty, 0)}</td>
                  <td className="jo-mid jo-size">{dims(p.length, p.width)}</td>
                  <td className="jo-mid jo-uom">{p.uom || p.unit}</td>
                </tr>
                <tr className="jo-sub">
                  <td />
                  <td colSpan={2}>Sales Remarks : {p.remarks || ''}</td>
                  <td colSpan={3}>Memo : {p.memo || ''}</td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>

        <div className="jo-band" style={{ marginTop: 26 }}>FOR LOGISTICS (Ship Confirmations)</div>
      </div>

      {/* ---------------- Page 2: the logistics slip ---------------- */}
      <div className="jo-sheet">
        <div className="jo-row">
          <span className="jo-lbl">SO # :</span>
          <span className="jo-val">{jo.sales_order_no}&nbsp;&nbsp;&nbsp;&nbsp;JO # : {jo.job_order_no}</span>
        </div>
        <Row label="CUSTOMER">{jo.customer_name}</Row>
        <div className="jo-row">
          <span className="jo-lbl">JO QTY :</span>
          <span className="jo-val">{num(jo.quantity)}&nbsp;&nbsp;&nbsp;&nbsp;Size : {sizeLine}</span>
        </div>
        <Row label="JO Description">{jo.description || jo.job_type_name}</Row>
        <Row label="Contact Name">{jo.contact_name}</Row>
        <Row label="Ship To">{shipTo}</Row>
        <Row label="Delivery Date">{fmtDate(jo.delivery_date)}</Row>
        <Row label="Memo">{jo.memo}</Row>
      </div>
    </div>
  );
}
