import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { MEMBER_FORMS, ADJ_REASON_LABELS, DAY_PART_LABELS, LEAVE_TYPE_LABELS, PAYMENT_TYPES, PURPOSE_LABELS, bankLabel, clock, hoursMinutes } from '../utils/requestForms';
import letterhead from '../assets/graphicstar-letterhead.png';
import { displayDate } from '../utils/dates';

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
    : displayDate(d);
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
      <div className="rf-sign-ink sig-ink" style={{ '--sig-h': '38px' }}>
        {image ? <img src={image} alt="" /> : null}
      </div>
      <div className="rf-sign-name">{name || ''}</div>
      <div className="rf-sign-rule" />
      <div className="rf-sign-role">{role}</div>
    </div>
  );
}

// The gate pass slip's own sign-offs: its Department Head approves (the note step), HR notes (the
// approve step), and the guard on duty checks and releases it, with the Time IN / OUT.
const phClock = (v) => (v ? new Date(`${String(v).replace(' ', 'T')}Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');
function GatePassSignatures({ doc }) {
  const d = doc.detail || {};
  return (
    <>
      <div className="rf-signs">
        <Signature image={doc.owner_signature} name={doc.name || doc.owner_name} role="Personnel" />
        <Signature image={doc.noted_signature} name={doc.noted_by_name} role="Approved by: Department Head" />
      </div>
      <div className="rf-signs">
        <Signature image={doc.approved_signature} name={doc.approved_by_name} role="Noted by: HR Department" />
        <Signature name={d.time_out_by_name || d.time_in_by_name} role="Checked & Released by: Security Guard on Duty" />
      </div>
      <div className="rf-row">
        <Field label="Time OUT" value={phClock(d.time_out)} />
        <Field label="Time IN" value={phClock(d.time_in)} />
      </div>
    </>
  );
}

// Office Supply Requisition Form (2026-10-23), as on the paper form: Requested by / Noted by (the
// Department Head), then Released by (HR) / Received by (the employee) signed on paper when the
// supplies are handed over. Approved by is the approver the requestor chose.
function OfficeSupplySignatures({ doc }) {
  return (
    <>
      <div className="rf-signs">
        <Signature image={doc.owner_signature} name={doc.name || doc.owner_name} role="Requested by" />
        <Signature image={doc.noted_signature} name={doc.noted_by_name} role="Noted by: Department Head's Signature" />
        <Signature image={doc.approved_signature} name={doc.approved_by_name} role="Approved by" />
      </div>
      <div className="rf-signs">
        <Signature role="Released by: HR Department" />
        <Signature role="Received by: Employee's Signature" />
      </div>
    </>
  );
}

// HR's member lists: prepared / requested by HR, approved by the General Manager, as on the sheets.
function MemberSignatures({ doc }) {
  return (
    <div className="rf-signs">
      <Signature image={doc.owner_signature} name={doc.owner_name} role={doc.type === 'hmo_enrollment' ? 'Requested by' : 'Prepared by'} />
      <Signature image={doc.noted_signature} name={doc.noted_by_name} role="Noted by" />
      <Signature image={doc.approved_signature} name={doc.approved_by_name} role="Approved by" />
    </div>
  );
}

function Signatures({ doc }) {
  if (doc.type === 'gate_pass') return <GatePassSignatures doc={doc} />;
  if (doc.type === 'office_supply') return <OfficeSupplySignatures doc={doc} />;
  if (MEMBER_FORMS[doc.type]) return <MemberSignatures doc={doc} />;
  // A Leave Application is not noted (2026-10-19) -- no Noted By line, unless it was noted before then.
  const noted = doc.type !== 'leave' || !!doc.noted_by_name;
  return (
    <div className="rf-signs">
      <Signature image={doc.owner_signature} name={doc.owner_name} role="Requested By" />
      {noted && (
        <Signature
          image={doc.noted_signature}
          name={doc.noted_by_name || doc.detail?.noted_by_name}
          role={['attendance_adjustment', 'leave'].includes(doc.type) ? 'Noted By (Immediate Superior)' : 'Noted By'}
        />
      )}
      <Signature image={doc.approved_signature} name={doc.approved_by_name} role="Approved By" />
    </div>
  );
}

function ItemsTable({ doc, withDate }) {
  const total = (doc.items || []).reduce((s, r) => s + Number(r.amount || 0), 0);
  // A Fund Transfer line's own banks (2026-10-13); a form from before then takes the form's one pair.
  const banks = doc.type === 'fund_transfer';
  const d = doc.detail || {};
  return (
    <table className="rf-table">
      <thead>
        <tr>
          {withDate && <th style={{ width: '18%' }}>Date</th>}
          {banks && <th style={{ width: '22%' }}>From</th>}
          {banks && <th style={{ width: '22%' }}>To</th>}
          <th>Particulars</th>
          <th style={{ width: '20%' }}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {(doc.items || []).map((r) => (
          <tr key={r.id}>
            {withDate && <td>{fmtDate(r.item_date)}</td>}
            {banks && <td>{bankLabel(r.from_account_code, r.from_account_name) || bankLabel(d.from_account_code, d.from_account_name)}</td>}
            {banks && <td>{bankLabel(r.to_account_code, r.to_account_name) || bankLabel(d.to_account_code, d.to_account_name)}</td>}
            <td>{r.particulars}</td>
            <td className="rf-num">{money(r.amount)}</td>
          </tr>
        ))}
        {/* The printed pads have ruled lines whether or not every one is used, and an approver
            signs across a fixed block. Pad to eight so the sheet keeps its shape. */}
        {Array.from({ length: Math.max(0, 8 - (doc.items || []).length) }).map((_, i) => (
          <tr key={`pad-${i}`}>
            {withDate && <td>&nbsp;</td>}
            {banks && <><td>&nbsp;</td><td>&nbsp;</td></>}
            <td>&nbsp;</td>
            <td>&nbsp;</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={(withDate ? 2 : 1) + (banks ? 2 : 0)} className="rf-total-label">TOTAL</td>
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
        /* The logo replaces the typed GRAPHICSTAR / IMAGING CORP. wordmark. Sized by width so
           the 6:1 artwork keeps its proportions; the file is 900px wide, well over what 52mm
           needs at print resolution. */
        .rf-logo { width: 52mm; height: auto; display: block; }
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
        /* Drawn twice its box's height and over the name: the shared .sig-ink (index.css). */
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
            <img className="rf-logo" src={letterhead} alt="GraphicStar Imaging Corp." />
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

        {PAYMENT_TYPES.includes(doc.type) && (
          <>
            <div className="rf-row">
              <Field label="Payable To" value={d.payable_to} />
              <Field label="Date" value={fmtDate(d.doc_date)} />
            </div>
            {doc.type === 'fund_transfer' ? (
              // Fund Transfer (2026-10-19): no From / To / Name in the header -- each line's From and
              // To are in the table -- and Department beside Address rather than on a row of its own.
              <div className="rf-row">
                <Field label="Address" value={d.address} />
                <Field label="Department" value={doc.department} />
              </div>
            ) : (
              <>
                <div className="rf-row">
                  <Field label="Address" value={d.address} />
                </div>
                <div className="rf-row">
                  <Field label="Department" value={doc.department} />
                  <Field label="Name" value={doc.name} />
                </div>
              </>
            )}
            <ItemsTable doc={doc} />
          </>
        )}

        {/* Attendance Adjustment Form (asked 2026-10-08), after the paper slip: who and which day,
            the IN / OUT times claimed for AM, PM and overtime, and the reason ticked. */}
        {/* Leave Application (asked 2026-10-13): who, which leave (ticked), the dates and days, why. */}
        {/* Employee Gate Pass (asked 2026-10-14), after the paper slip: where and when, the items
            carried out (each noted by its department), the personnel and purpose. */}
        {/* HR's member lists (asked 2026-10-19), after the sheets: the company block for the HMO forms,
            the letter to BPI for the BPI deletion, then the members. */}
        {MEMBER_FORMS[doc.type] && (
          <>
            {doc.type !== 'bpi_deletion' && (
              <div className="rf-box">
                <div className="rf-row"><Field label="Name of Company" value="CEBU GRAPHICSTAR IMAGING CORPORATION" /></div>
                <div className="rf-row"><Field label="Address" value="JS ALINSUG ST., BASAK MANDAUE CITY CEBU 6014" /></div>
                <div className="rf-row">
                  <Field label="Contact Person" value={doc.owner_name} />
                  {doc.type === 'hmo_enrollment' && <Field label="Enrollment For" value={d.enrollment_for} />}
                  {doc.type === 'hmo_deletion' && <Field label="" value="FOR DELETION" />}
                </div>
              </div>
            )}
            {doc.type === 'bpi_deletion' && (
              <div style={{ fontSize: 12, lineHeight: 1.6, margin: '8px 0 12px' }}>
                <div>Date: <u>{fmtDate(d.letter_date)}</u></div>
                <div style={{ marginTop: 10 }}>The Manager<br />Bank of the Philippine Islands (BPI)<br />GF Insular Mall<br />Basak, Mandaue City<br />6014 Cebu</div>
                <div style={{ marginTop: 10 }}>Dear Sir/Madam:</div>
                <div style={{ marginTop: 6 }}>Please delete from the payroll list under Cebu Graphicstar Imaging Corp. the following separated employees:</div>
              </div>
            )}
            <table className="rf-table">
              <thead><tr><th>#</th>{MEMBER_FORMS[doc.type].columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {(d.lines || []).map((l, i) => (
                  <tr key={l.id || i}>
                    <td>{i + 1}</td>
                    {MEMBER_FORMS[doc.type].columns.map((c) => <td key={c.key}>{c.type === 'date' ? fmtDate(l[c.key]) : (l[c.key] || '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {doc.type === 'bpi_deletion' && <div style={{ fontSize: 12, marginTop: 12 }}>Thank you.<br /><br />Sincerely yours,</div>}
          </>
        )}

        {/* Office Supply Requisition Form (asked 2026-10-23), after the paper form: Department and
            Date, then QTY / PARTICULARS / REMARKS on ruled lines. */}
        {doc.type === 'office_supply' && (
          <>
            <div className="rf-row">
              <Field label="Department" value={doc.department} />
              <Field label="Date" value={fmtDate(d.osr_date)} />
            </div>
            <table className="rf-table">
              <thead><tr><th style={{ width: '14%' }}>QTY</th><th style={{ width: '46%' }}>PARTICULARS</th><th>REMARKS</th></tr></thead>
              <tbody>
                {[...(d.items || []), ...Array.from({ length: Math.max(0, 12 - (d.items || []).length) }, () => null)].map((it, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'center' }}>{it ? Number(it.quantity) : ' '}</td>
                    <td>{it ? it.particulars : ''}</td>
                    <td>{it ? it.remarks || '' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {doc.type === 'gate_pass' && (
          <>
            <div className="rf-row">
              <Field label="Location" value={d.location_name} />
              <Field label="Date" value={fmtDate(d.pass_date)} />
            </div>
            <div className="rf-row">
              <Field label="Destination" value={d.destination} />
              <Field label="" value="(Valid only on date indicated)" />
            </div>
            <div className="rf-box">
              <h4>Items</h4>
              <table className="rf-table">
                <thead><tr><th>Description</th><th>Department</th><th>Noted by</th></tr></thead>
                <tbody>
                  {[...(d.items || []), ...Array.from({ length: Math.max(0, 6 - (d.items || []).length) }, () => null)].map((it, i) => (
                    <tr key={i}>
                      <td>{it ? it.description : '\u00a0'}</td>
                      <td>{it ? it.department || '' : ''}</td>
                      <td>{it ? doc.noted_by_name || '' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 11, fontWeight: 700, marginTop: 4 }}>ALL ITEMS SHOULD BE LISTED &amp; NOTED BY THE DEPT. CONCERNED</div>
            </div>
            <div className="rf-box">
              <h4>Personnel</h4>
              <div className="rf-row">
                <Field label="Name of Personnel" value={doc.name || doc.owner_name} />
                <Field label="Department" value={doc.department} />
              </div>
              <div className="rf-row"><Field label="Purpose" value={d.purpose} /></div>
            </div>
          </>
        )}

        {/* Fuel Request (2026-10-19). */}
        {doc.type === 'fuel' && (
          <>
            <div className="rf-row">
              <Field label="Name" value={doc.name} />
              <Field label="Department" value={doc.department} />
            </div>
            <div className="rf-row">
              <Field label="Date" value={fmtDate(d.fuel_date)} />
              <Field label="Vehicle" value={d.vehicle_name} />
            </div>
            <div className="rf-row">
              <Field label="Litres" value={d.liters != null ? `${Number(d.liters)} L` : ''} />
            </div>
            <div className="rf-row">
              <Field label="Odometer (km)" value={d.odometer_km != null ? Number(d.odometer_km).toLocaleString('en-US') : ''} />
              <Field label="Station" value={d.station} />
            </div>
            <div className="rf-row">
              <Field label="Purpose" value={d.purpose} />
            </div>
          </>
        )}

        {doc.type === 'leave' && (
          <>
            <div className="rf-row">
              <Field label="Name" value={doc.name} />
              <Field label="Department" value={doc.department} />
            </div>
            <div className="rf-box">
              <h4>Type of Leave</h4>
              <div className="rf-purposes" style={{ flexWrap: 'wrap', gap: '6px 18px' }}>
                {Object.entries(LEAVE_TYPE_LABELS).map(([k, label]) => (
                  <span className="rf-check" key={k}>
                    <span className="rf-mark">{d.leave_type === k ? '×' : ' '}</span>
                    {label}
                    {k === 'others' && d.leave_type === 'others' && d.leave_type_other ? <>: <u>{d.leave_type_other}</u></> : ''}
                  </span>
                ))}
              </div>
            </div>
            <div className="rf-row">
              <Field label="From" value={fmtDate(d.date_from)} />
              <Field label="To" value={fmtDate(d.date_to)} />
              <Field label="No. of Days" value={d.days != null
                ? `${Number(d.days)}${d.day_part && d.day_part !== 'whole' ? ` (${DAY_PART_LABELS[d.day_part]})` : ''}` : ''} />
            </div>
            <div className="rf-box">
              <h4>Reason</h4>
              <div style={{ whiteSpace: 'pre-wrap', minHeight: 40 }}>{d.reason}</div>
            </div>
            {d.contact_while_on_leave && (
              <div className="rf-row"><Field label="Contact while on leave" value={d.contact_while_on_leave} /></div>
            )}
          </>
        )}

        {/* Undertime Form (asked 2026-10-20): who, which day, the scheduled and actual time out, why. */}
        {doc.type === 'undertime' && (
          <>
            <div className="rf-row">
              <Field label="Name" value={doc.name} />
              <Field label="Department" value={doc.department} />
              <Field label="Date" value={fmtDate(d.ut_date)} />
            </div>
            <div className="rf-row">
              <Field label="Scheduled Time Out" value={clock(d.shift_end)} />
              <Field label="Time Out" value={clock(d.time_out)} />
              <Field label="Undertime" value={d.minutes != null ? hoursMinutes(d.minutes) : ''} />
            </div>
            <div className="rf-box">
              <h4>Reason</h4>
              <div style={{ whiteSpace: 'pre-wrap', minHeight: 40 }}>{d.reason}</div>
            </div>
          </>
        )}

        {doc.type === 'attendance_adjustment' && (
          <>
            <div className="rf-row">
              <Field label="Name" value={doc.name} />
              <Field label="Department" value={doc.department} />
              <Field label="Date" value={fmtDate(d.adjustment_date)} />
            </div>
            <table className="rf-table" style={{ marginTop: 14 }}>
              <thead>
                <tr><th style={{ width: '20%' }} /><th>In</th><th>Out</th></tr>
              </thead>
              <tbody>
                {['am', 'pm', 'ot'].map((p) => (
                  <tr key={p}>
                    <td style={{ fontWeight: 700, textAlign: 'center' }}>{p.toUpperCase()}</td>
                    <td style={{ textAlign: 'center', height: 24 }}>{clock(d[`${p}_in`])}</td>
                    <td style={{ textAlign: 'center' }}>{clock(d[`${p}_out`])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rf-box">
              <h4>Reason</h4>
              <div className="rf-purposes" style={{ flexDirection: 'column', gap: 6 }}>
                {Object.entries(ADJ_REASON_LABELS).map(([k, label]) => (
                  <span className="rf-check" key={k}>
                    <span className="rf-mark">{d.reason === k ? '×' : ' '}</span>
                    {label}
                    {k === 'others' && d.reason === 'others' && d.reason_other ? <>: <u>{d.reason_other}</u></> : ''}
                  </span>
                ))}
              </div>
            </div>
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

        {/* The filer's remarks, on every form type. Left off the sheet when there are none rather
            than printing an empty box on every pad. */}
        {doc.remarks && (
          <div className="rf-box">
            <h4>Remarks</h4>
            <div style={{ whiteSpace: 'pre-wrap' }}>{doc.remarks}</div>
          </div>
        )}

        <Signatures doc={doc} />
      </div>
    </div>
  );
}
