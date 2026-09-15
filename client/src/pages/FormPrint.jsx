import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { PURPOSE_LABELS } from '../utils/requestForms';

// The printed forms. One sheet each, four layouts, sharing the letterhead and the signature block.
//
// Printing is gated SERVER-SIDE (GET /forms/:id/print): can_print on /forms, the form must be
// yours or you must be an approver, and it must be approved -- except a business trip, which
// prints once noted because the sheet travels with the driver. This page renders whatever refusal
// comes back rather than deciding for itself, so the rule lives in exactly one place.


function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10)
    : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function Field({ label, value, width }) {
  return (
    <div className="rf-field" style={width ? { width } : undefined}>
      <span className="rf-label">{label}</span>
      <span className="rf-value">{value || ' '}</span>
    </div>
  );
}

// Three signatures across the foot of every form: who filed it, who noted it, who approved it.
// A business trip prints before approval, so its third box is left blank to be signed by hand.
//
// The drawn signature sits ABOVE the name and the rule, the way a hand-signed form reads: the mark
// on the line, the typed name under it. Where the person has none on file the space is simply left
// empty to sign by hand, which is how every one of these printed before signatures existed -- so a
// missing signature degrades to the old behaviour rather than to a broken layout.
function Signature({ image, name, role }) {
  return (
    <div className="rf-sign">
      <div className="rf-sign-ink">
        {image ? <img src={image} alt="" /> : null}
      </div>
      <div className="rf-sign-name">{name || ''}</div>
      <div className="rf-sign-rule" />
      <div className="rf-sign-role">{role}</div>
    </div>
  );
}

function Signatures({ doc }) {
  return (
    <div className="rf-signs">
      <Signature image={doc.owner_signature} name={doc.owner_name} role="Requested By" />
      <Signature
        image={doc.noted_signature}
        name={doc.noted_by_name || doc.detail?.noted_by_name}
        role="Noted By"
      />
      <Signature image={doc.approved_signature} name={doc.approved_by_name} role="Approved By" />
    </div>
  );
}

function ItemsTable({ doc, withDate }) {
  const total = (doc.items || []).reduce((s, r) => s + Number(r.amount || 0), 0);
  return (
    <table className="rf-table">
      <thead>
        <tr>
          {withDate && <th style={{ width: '18%' }}>Date</th>}
          <th>Particulars</th>
          <th style={{ width: '20%' }}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {(doc.items || []).map((r) => (
          <tr key={r.id}>
            {withDate && <td>{fmtDate(r.item_date)}</td>}
            <td>{r.particulars}</td>
            <td className="rf-num">{money(r.amount)}</td>
          </tr>
        ))}
        {/* The printed pads have ruled lines whether or not every one is used, and an approver
            signs across a fixed block. Pad to eight so the sheet keeps its shape. */}
        {Array.from({ length: Math.max(0, 8 - (doc.items || []).length) }).map((_, i) => (
          <tr key={`pad-${i}`}>
            {withDate && <td>&nbsp;</td>}
            <td>&nbsp;</td>
            <td>&nbsp;</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={withDate ? 2 : 1} className="rf-total-label">TOTAL</td>
          <td className="rf-num rf-total">{money(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export default function FormPrint() {
  const { id } = useParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/forms/${id}/print`)
      .then(({ data }) => { setDoc(data); setLoading(false); })
      .catch((e) => { setError(e.response?.data?.error || 'This form cannot be printed.'); setLoading(false); });
  }, [id]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="error-banner" style={{ margin: 20 }}>{error}</div>;

  const d = doc.detail || {};
  const isFund = doc.type === 'liquidation' || doc.type === 'revolving_fund';

  return (
    <div className="rf-page">
      <style>{`
        .rf-page { background: #fff; color: #111; padding: 16px; }
        .rf-toolbar { margin-bottom: 12px; }
        .rf-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm; box-sizing: border-box;
                    background: #fff; font-family: Arial, Helvetica, sans-serif; font-size: 12px; }
        .rf-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
        .rf-brand { font-size: 24px; font-weight: 800; letter-spacing: .5px; color: #1e3a8a; }
        .rf-brand span { color: #f07c00; }
        .rf-brand-sub { font-size: 11px; letter-spacing: 3px; color: #1e3a8a; }
        .rf-addr { font-size: 10px; text-align: right; line-height: 1.4; }
        .rf-bars { margin: 6px 0 14px; }
        .rf-bar-orange { height: 4px; background: #f07c00; }
        .rf-bar-blue { height: 6px; background: #1e3a8a; }
        .rf-title { text-align: center; font-size: 16px; font-weight: 700; letter-spacing: 2px;
                    text-transform: uppercase; margin: 10px 0 4px; }
        .rf-no { text-align: right; font-size: 11px; margin-bottom: 10px; }
        .rf-row { display: flex; gap: 18px; flex-wrap: wrap; }
        .rf-field { display: flex; gap: 6px; align-items: baseline; flex: 1; min-width: 180px; margin-bottom: 8px; }
        .rf-label { font-size: 10px; text-transform: uppercase; color: #444; white-space: nowrap; }
        .rf-value { flex: 1; border-bottom: 1px solid #333; padding: 0 4px 1px; min-height: 15px; }
        .rf-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        .rf-table th, .rf-table td { border: 1px solid #333; padding: 4px 6px; font-size: 11px; }
        .rf-table th { background: #eef2ff; text-transform: uppercase; font-size: 10px; }
        .rf-num { text-align: right; }
        .rf-total-label { text-align: right; font-weight: 700; }
        .rf-total { font-weight: 700; }
        .rf-box { border: 1px solid #333; padding: 8px; margin-top: 12px; }
        .rf-box h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; }
        .rf-purposes { display: flex; flex-wrap: wrap; gap: 10px 18px; font-size: 11px; }
        .rf-check { display: inline-flex; gap: 5px; align-items: center; }
        .rf-mark { display: inline-block; width: 11px; height: 11px; border: 1px solid #333; text-align: center;
                   line-height: 10px; font-size: 10px; }
        .rf-signs { display: flex; gap: 24px; margin-top: 34px; }
        .rf-sign { flex: 1; text-align: center; }
        /* A fixed height whether or not there is ink, so the three lines stay level when only
           some of the signers have a signature on file. */
        .rf-sign-ink { height: 38px; display: flex; align-items: flex-end; justify-content: center; }
        .rf-sign-ink img { max-height: 38px; max-width: 100%; object-fit: contain; }
        .rf-sign-name { font-size: 11px; min-height: 15px; }
        .rf-sign-rule { border-top: 1px solid #333; margin-top: 2px; }
        .rf-sign-role { font-size: 10px; text-transform: uppercase; color: #444; margin-top: 3px; }
        @media print {
          .rf-no-print { display: none !important; }
          .rf-page { padding: 0; }
          .rf-sheet { width: auto; min-height: 0; padding: 0; }
          @page { size: A4 portrait; margin: 12mm; }
        }
      `}</style>

      <div className="rf-toolbar rf-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="rf-sheet">
        <div className="rf-head">
          <div>
            <div className="rf-brand">GRAPHIC<span>STAR</span></div>
            <div className="rf-brand-sub">IMAGING CORP.</div>
          </div>
          <div className="rf-addr">
            <strong>GraphicStar Building</strong><br />
            J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Phillipines<br />
            Tel. #238-1234<br />
            www.graphicstar.com.ph
          </div>
        </div>
        <div className="rf-bars"><div className="rf-bar-orange" /><div className="rf-bar-blue" /></div>

        <div className="rf-title">{doc.type_label}</div>
        <div className="rf-no">
          No: <strong>{d.form_no || doc.request_no}</strong>
        </div>

        {isFund && (
          <>
            <div className="rf-row">
              <Field label="Name" value={doc.name} />
              <Field label="Department" value={doc.department} />
              <Field label="Week No." value={d.week_no} />
            </div>
            <div className="rf-row">
              <Field label="Date From" value={fmtDate(d.date_from)} />
              <Field label="Date To" value={fmtDate(d.date_to)} />
            </div>

            {doc.type === 'liquidation' && (
              <div className="rf-box">
                <h4>Purpose</h4>
                <div className="rf-purposes">
                  {Object.entries(PURPOSE_LABELS).map(([k, label]) => {
                    const hit = (doc.purposes || []).find((p) => p.purpose === k);
                    return (
                      <span className="rf-check" key={k}>
                        <span className="rf-mark">{hit ? '×' : ' '}</span>
                        {label}
                        {k === 'others' && hit?.other_text ? `: ${hit.other_text}` : ''}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            <ItemsTable doc={doc} withDate />

            <div className="rf-box">
              <div className="rf-row">
                <Field label="Cash Advance" value={d.cash_advance_amount != null ? money(d.cash_advance_amount) : ''} />
                <Field label="Date Received" value={fmtDate(d.cash_advance_date)} />
              </div>
              <div className="rf-row">
                <Field label="Previous Balance" value={d.previous_balance != null ? money(d.previous_balance) : ''} />
                <Field label="Starting Balance" value={d.starting_balance != null ? money(d.starting_balance) : ''} />
              </div>
              <div className="rf-row">
                <Field label="Reimbursement" value={d.reimbursement_amount != null ? money(d.reimbursement_amount) : ''} />
                <Field label="Ending Balance" value={d.ending_balance != null ? money(d.ending_balance) : ''} />
              </div>
            </div>
          </>
        )}

        {doc.type === 'payment' && (
          <>
            <div className="rf-row">
              <Field label="Payable To" value={d.payable_to} />
              <Field label="Date" value={fmtDate(d.doc_date)} />
            </div>
            <div className="rf-row">
              <Field label="Address" value={d.address} />
            </div>
            <div className="rf-row">
              <Field label="Department" value={doc.department} />
              <Field label="Name" value={doc.name} />
            </div>
            <ItemsTable doc={doc} />
          </>
        )}

        {doc.type === 'business_trip' && (
          <>
            <div className="rf-row">
              <Field label="Driver" value={d.driver_name} />
              <Field label="Plate No." value={d.vehicle_plate_no} />
              <Field label="Trip Date" value={fmtDate(d.trip_date)} />
            </div>
            <div className="rf-row">
              <Field label="Time Out" value={d.time_out} />
              <Field label="Time In" value={d.time_in} />
            </div>
            <div className="rf-row">
              <Field label="Speedometer Begin" value={d.speedometer_begin} />
              <Field label="Speedometer End" value={d.speedometer_end} />
              <Field label="Total Mileage (km)" value={d.total_mileage_km != null ? d.total_mileage_km : ''} />
            </div>
            <div className="rf-box">
              <h4>Purpose of Trip</h4>
              <div style={{ minHeight: 70, whiteSpace: 'pre-wrap' }}>{d.purpose || ' '}</div>
            </div>
            <div className="rf-row" style={{ marginTop: 10 }}>
              <Field label="Checked By" value={d.checked_by} />
              <Field label="Noted By" value={d.noted_by_name} />
            </div>
          </>
        )}

        <Signatures doc={doc} />
      </div>
    </div>
  );
}
