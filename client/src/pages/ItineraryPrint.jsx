import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

// The run sheet as it goes out on paper.
//
// LANDSCAPE, because the eleven columns the warehouse asked for do not fit across a portrait page
// without shrinking the hand-written boxes to uselessness. Time of Arrival, Odometer and Signature
// are what the driver fills in at each drop, so they print as ruled boxes with room to write --
// unless something has already been captured on the screen, in which case that is printed instead
// and the sheet becomes a record rather than a form.
//
// Same shape as JobOrderPrint: a `-no-print` toolbar, one `.itn-sheet`, and an @media print block
// carrying the @page rule.
function fmtDate(v) { return v ? String(v).slice(0, 10) : ''; }
function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(11, 16)
    : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
}

export default function ItineraryPrint() {
  const { id } = useParams();
  const [it, setIt] = useState(null);
  const [sigs, setSigs] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/itineraries/${id}`).then(({ data }) => { setIt(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  // Any signature already captured is fetched as a blob and drawn into its box, so a re-print
  // after the run carries the real thing. A plain <img src> would not work here -- the endpoint is
  // authenticated and an image request sends no Authorization header.
  useEffect(() => {
    if (!it) return undefined;
    const urls = [];
    const signed = (it.stops || []).filter((s) => s.has_signature);
    Promise.all(signed.map((s) => api.get(`/itineraries/stops/${s.id}/signature`, { responseType: 'blob' })
      .then((res) => { const u = URL.createObjectURL(res.data); urls.push(u); return [s.id, u]; })
      .catch(() => null)))
      .then((pairs) => setSigs(Object.fromEntries(pairs.filter(Boolean))));
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [it]);

  if (loading) return <LoadingSpinner />;
  if (!it) return <div className="error-banner">Itinerary not found.</div>;
  const stops = it.stops || [];

  return (
    <div className="itn-print">
      <style>{`
        .itn-print { background: #f1f5f9; padding: 16px; }
        .itn-sheet {
          background: #fff; width: 297mm; min-height: 210mm; margin: 0 auto; padding: 10mm 8mm;
          box-shadow: 0 2px 12px rgba(0,0,0,.15); color: #111827;
          font-family: Arial, Helvetica, sans-serif; font-size: 9pt; box-sizing: border-box;
        }
        .itn-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111827; padding-bottom: 6px; }
        .itn-brand { font-size: 17pt; font-weight: 800; letter-spacing: .5px; }
        .itn-brand span { color: #dc2626; }
        .itn-brand-sub { font-size: 8pt; letter-spacing: 2px; }
        .itn-title { text-align: right; }
        .itn-title h1 { margin: 0; font-size: 15pt; letter-spacing: 2px; }
        .itn-no { font-size: 11pt; font-weight: 700; }
        .itn-meta { display: flex; gap: 10mm; margin: 6px 0 8px; font-size: 9pt; }
        .itn-meta div span { font-weight: 700; }

        .itn-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        /* white-space MUST be reset here. index.css sets white-space: nowrap on every th and td
           globally, and a fixed-layout table inherits it, so a customer name simply runs on across
           the columns beside it instead of wrapping -- which is what was happening to "SCRUMPTIOUS
           FOOD AND BEVERAGE CORP" and to the "QTY TO DELIVER" heading. break-word covers the
           other case: one long unbroken token, like an address with no spaces in it.
           (No backticks in this comment: the whole block is a JS template literal.) */
        .itn-table th, .itn-table td {
          border: 1px solid #111827; padding: 3px 4px; vertical-align: top;
          white-space: normal; overflow-wrap: break-word; word-break: break-word;
          /* Without border-box the 4px side padding on eleven cells sits OUTSIDE the declared
             widths, pushing a table meant to be 281mm out to 307mm -- past the printable area.
             With it, the mm figures below are the finished column widths. */
          box-sizing: border-box;
        }
        .itn-table th { background: #e5e7eb; font-size: 8pt; text-align: center; text-transform: uppercase; letter-spacing: .2px; line-height: 1.15; }
        .itn-table td { font-size: 8.5pt; line-height: 1.2; }
        /* The hand-written columns need real height; 16mm is about right for a signature scrawl
           and keeps roughly nine drops on one landscape page. */
        .itn-table tbody tr { height: 16mm; }
        /* These add up to 281mm on purpose: A4 landscape is 297mm and @page takes 8mm off each
           side. table-layout:fixed would otherwise treat them as mere proportions and quietly
           rescale everything, so a column sized for a handwritten box would come out narrower
           than intended. 7+22+20+46+16+15+52+27+20+20+36 = 281. */
        .itn-c-seq { width: 7mm; text-align: center; }
        .itn-c-so { width: 22mm; }
        .itn-c-date { width: 20mm; }
        .itn-c-cust { width: 46mm; }
        .itn-c-qty { width: 16mm; text-align: right; }
        .itn-c-pf { width: 15mm; text-align: center; }
        .itn-c-addr { width: 52mm; font-size: 7.5pt; }
        .itn-c-pic { width: 27mm; }
        .itn-c-odo { width: 20mm; }
        .itn-c-toa { width: 20mm; }
        .itn-c-sig { width: 36mm; }
        .itn-sig-img { max-width: 100%; max-height: 14mm; display: block; }
        .itn-foot { display: flex; gap: 12mm; margin-top: 8mm; font-size: 9pt; }
        .itn-foot > div { flex: 1; }
        .itn-rule { border-bottom: 1px solid #111827; height: 10mm; }
        .itn-foot label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .3px; }
        .itn-toolbar { max-width: 297mm; margin: 0 auto 12px; display: flex; gap: 8px; }

        @media print {
          .itn-print { background: none; padding: 0; }
          .itn-no-print { display: none !important; }
          /* Landscape: eleven columns plus three hand-written boxes will not fit portrait. */
          @page { size: A4 landscape; margin: 8mm; }
          .itn-sheet { box-shadow: none; margin: 0; width: auto; min-height: 0; padding: 0; }
          .itn-table { page-break-inside: auto; }
          .itn-table tr { page-break-inside: avoid; page-break-after: auto; }
          .itn-table thead { display: table-header-group; }
        }
      `}</style>

      <div className="itn-toolbar itn-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
        <button className="btn btn-sm" onClick={() => window.history.back()}>Back</button>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12 }}>
          Prints landscape. Time of Arrival, Odometer and Signature are left blank for the driver.
        </span>
      </div>

      <div className="itn-sheet">
        <div className="itn-head">
          <div>
            <div className="itn-brand">GRAPHIC<span>STAR</span></div>
            <div className="itn-brand-sub">IMAGING CORP.</div>
          </div>
          <div className="itn-title">
            <h1>DELIVERY ITINERARY</h1>
            <div className="itn-no">{it.itinerary_no}</div>
          </div>
        </div>

        <div className="itn-meta">
          <div>Date : <span>{fmtDate(it.itinerary_date)}</span></div>
          <div>Driver : <span>{it.driver_name || '________________'}</span></div>
          <div>Plate No. : <span>{it.plate_no || '____________'}</span></div>
          <div>Contact : <span>{it.driver_contact || '____________'}</span></div>
          <div>Stops : <span>{stops.length}</span></div>
          <div>Prepared By : <span>{it.created_by_name || ''}</span></div>
        </div>

        <table className="itn-table">
          <thead>
            <tr>
              <th className="itn-c-seq">#</th>
              <th className="itn-c-so">SO Number</th>
              <th className="itn-c-date">Delivery Date</th>
              <th className="itn-c-cust">Customer</th>
              <th className="itn-c-qty">Qty</th>
              <th className="itn-c-pf">Partial / Full</th>
              <th className="itn-c-addr">Delivery Address</th>
              <th className="itn-c-pic">Contact Person</th>
              <th className="itn-c-odo">Odometer</th>
              <th className="itn-c-toa">Time of Arrival</th>
              <th className="itn-c-sig">Name & Signature</th>
            </tr>
          </thead>
          <tbody>
            {stops.length === 0 && (
              <tr><td colSpan={11} style={{ textAlign: 'center' }}>No stops on this run.</td></tr>
            )}
            {stops.map((s, i) => (
              <tr key={s.id}>
                <td className="itn-c-seq">{i + 1}</td>
                <td className="itn-c-so">{s.sales_order_no}</td>
                <td className="itn-c-date">{fmtDate(s.delivery_date)}</td>
                <td className="itn-c-cust">{s.customer_name || ''}</td>
                <td className="itn-c-qty">{qty(s.qty_to_deliver)}</td>
                <td className="itn-c-pf">{s.fulfillment_type === 'partial' ? 'Partial' : 'Full'}</td>
                <td className="itn-c-addr">{s.delivery_address || ''}</td>
                <td className="itn-c-pic">{s.person_in_charge || ''}</td>
                {/* Blank unless it was keyed in -- these three are the driver's to fill. */}
                <td className="itn-c-odo">{s.odometer || ''}</td>
                <td className="itn-c-toa">{fmtTime(s.time_of_arrival)}</td>
                <td className="itn-c-sig">
                  {sigs[s.id] && <img className="itn-sig-img" alt="" src={sigs[s.id]} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {it.remarks && (
          <div style={{ marginTop: '4mm', fontSize: '8.5pt' }}>Remarks : {it.remarks}</div>
        )}

        <div className="itn-foot">
          <div>
            <div className="itn-rule" />
            <label>Driver&apos;s Signature</label>
          </div>
          <div>
            <div className="itn-rule" />
            <label>Dispatched By</label>
          </div>
          <div>
            <div className="itn-rule" />
            <label>Checked By</label>
          </div>
          <div>
            <div className="itn-rule" />
            <label>Received Back / Date</label>
          </div>
        </div>
      </div>
    </div>
  );
}
