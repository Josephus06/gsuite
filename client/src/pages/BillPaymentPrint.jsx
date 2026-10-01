import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import letterhead from '../assets/graphicstar-letterhead.png';

// Bill Payment and Cheque printouts (kind "bill-payment" | "cheque"), as the old system prints them:
//   Payment Voucher -- A4, letterhead, who was paid what for which bills, four sign-off lines.
//   Cheque (BPI)    -- only the variable text, placed on the bank's pre-printed cheque: the date
//                      as spaced digits in the date boxes, the payee, the amount, the amount in words.
// Printing is gated server-side (GET /bill-payments/:id/print, can_print).

// Every cheque position, in millimetres from the top-left of the cheque. A cheque that prints off
// its lines is fixed HERE: open the cheque with Calibrate on, print it on plain paper laid over a
// real cheque, measure, and adjust. Cheque dates keep the bank's own format, not the app's.
const CHEQUE = {
  size: { width: 203, height: 76 }, // BPI personal/commercial cheque, 8 x 3 in
  date: { x: 148, y: 9, digitGap: 5.6, groupGap: 3.4 }, // M M  D D  Y Y Y Y
  payee: { x: 26, y: 21, w: 120 },
  amount: { x: 150, y: 21, w: 45 },
  words: { x: 18, y: 30, w: 135 },
};

const ONES = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE',
  'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
function under1000(n) {
  const h = Math.floor(n / 100); const r = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} HUNDRED`);
  if (r) parts.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`);
  return parts.join(' ');
}
// 19205 -> "NINETEEN THOUSAND TWO HUNDRED FIVE PESOS ONLY"; 1500.5 -> "... PESOS AND 50/100 ONLY".
export function amountInWords(amount) {
  const value = Math.round(Number(amount || 0) * 100);
  let pesos = Math.floor(value / 100); const cents = value % 100;
  if (!pesos && !cents) return 'ZERO PESOS ONLY';
  const scales = ['', 'THOUSAND', 'MILLION', 'BILLION'];
  const parts = []; let i = 0;
  while (pesos > 0) {
    const chunk = pesos % 1000;
    if (chunk) parts.unshift(`${under1000(chunk)}${scales[i] ? ` ${scales[i]}` : ''}`);
    pesos = Math.floor(pesos / 1000); i += 1;
  }
  const words = parts.join(' ') || 'ZERO';
  return `${words} PESOS${cents ? ` AND ${String(cents).padStart(2, '0')}/100` : ''} ONLY`;
}

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = (v) => (v ? String(v).slice(0, 10) : '');
// Bank format on paper: "Sep 30, 2026" on the voucher, 09/30/2026 for line dates -- as the source.
const longDate = (v) => (v ? new Date(`${ymd(v)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '');
const shortDate = (v) => { const d = ymd(v); return d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : ''; };

export default function BillPaymentPrint({ kind = 'bill-payment' }) {
  const isCheque = kind === 'cheque';
  const docName = isCheque ? 'Cheque' : 'Bill Payment';
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const mode = params.get('as') === 'cheque' ? 'cheque' : 'voucher';
  const calibrate = params.get('calibrate') === '1';
  const [bp, setBp] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/${isCheque ? 'cheques' : 'bill-payments'}/${id}/print`)
      // A cheque carries the same facts under its own names; read it as a payment from here on.
      .then(({ data }) => setBp(isCheque ? {
        ...data, supplier_name: data.payee_name, check_date: data.cheque_date, check_no: data.cheque_number,
        reference_no: data.cheque_no, status: data.status === 'void' ? 'voided' : data.status,
      } : data))
      .catch((e) => setError(e.response?.data?.error || `Could not load this ${docName}.`));
  }, [id, isCheque, docName]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this {docName}</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!bp) return <LoadingSpinner />;

  const payee = bp.payee_name || bp.supplier_name || '';
  const words = amountInWords(bp.total_amount);
  const setMode = (m) => setParams(m === 'cheque' ? { as: 'cheque' } : {});

  return (
    <div className="bpp">
      <style>{`
        .bpp { background: #f1f5f9; padding: 16px 0 40px; }
        .bpp-toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
        .bpp-hint { max-width: 210mm; margin: 0 auto 10px; font-size: 12px; color: #64748b; }
        .bpp-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 16mm; background: #fff; color: #1f2937;
          font-family: system-ui, 'Segoe UI', sans-serif; font-size: 8.5pt; line-height: 1.5; box-shadow: 0 1px 6px rgba(0,0,0,.25);
          display: flex; flex-direction: column; position: relative; }
        .bpp-head { display: flex; justify-content: space-between; align-items: flex-start; }
        .bpp-logo { width: 62mm; height: auto; }
        .bpp-addr { text-align: right; font-size: 7.5pt; color: #475569; line-height: 1.45; }
        .bpp-title { text-align: center; font-size: 12pt; font-weight: 600; margin: 8mm 0 7mm; }
        .bpp-cols { display: flex; justify-content: space-between; gap: 12mm; }
        .bpp-cols > div { flex: 1; }
        .bpp-table { width: 100%; border-collapse: collapse; margin-top: 8mm; font-size: 8pt; table-layout: fixed; }
        .bpp-table th, .bpp-table td { border: 1px solid #cbd5e1; padding: 4px 3px; font-weight: 400; background: none; white-space: normal; overflow-wrap: anywhere; }
        .bpp-table th { color: #334155; text-align: left; }
        .bpp-num { text-align: right !important; }
        .bpp-total { margin-top: auto; text-align: right; padding: 4mm 18mm 8mm 0; }
        .bpp-sign { display: flex; justify-content: space-between; gap: 6mm; padding: 0 4mm 6mm; }
        .bpp-sign div { flex: 1; text-align: center; }
        .bpp-sign .bpp-line { margin-top: 12mm; border-top: 1px dashed #64748b; }
        .bpp-void { position: absolute; top: 40%; left: 0; right: 0; text-align: center; font-size: 64pt; font-weight: 800;
          color: rgba(220,38,38,.18); transform: rotate(-20deg); pointer-events: none; }
        .chq-wrap { width: ${CHEQUE.size.width}mm; height: ${CHEQUE.size.height}mm; margin: 0 auto; background: #fff; position: relative;
          box-shadow: 0 1px 6px rgba(0,0,0,.25); font-family: system-ui, 'Segoe UI', sans-serif; font-size: 11pt; color: #000; }
        .chq-f { position: absolute; white-space: nowrap; }
        .chq-out { outline: 0.2mm dashed rgba(220,38,38,.7); }
        @media print {
          html, body, #root, .bpp { background: #fff !important; }
          .bpp { padding: 0; }
          .bpp-no-print { display: none !important; }
          .bpp-sheet, .chq-wrap { box-shadow: none; margin: 0; }
          .bpp-sheet { min-height: 297mm; }
          @page { ${mode === 'cheque' ? `size: ${CHEQUE.size.width}mm ${CHEQUE.size.height}mm;` : 'size: A4 portrait;'} margin: 0; }
        }
      `}</style>

      <div className="bpp-toolbar bpp-no-print">
        <button className={`btn btn-sm ${mode === 'voucher' ? 'btn-primary' : ''}`} onClick={() => setMode('voucher')}>Payment Voucher</button>
        <button className={`btn btn-sm ${mode === 'cheque' ? 'btn-primary' : ''}`} onClick={() => setMode('cheque')}>Cheque (BPI)</button>
        {mode === 'cheque' && (
          <button className="btn btn-sm" onClick={() => setParams(calibrate ? { as: 'cheque' } : { as: 'cheque', calibrate: '1' })}>
            {calibrate ? 'Hide guides' : 'Calibrate'}
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      {mode === 'cheque' && calibrate && (
        <div className="bpp-hint bpp-no-print">
          Guides on: field outlines and a 10mm grid. Print on plain paper laid over a blank BPI cheque, measure any field
          that misses its line, and adjust <code>CHEQUE</code> in <code>BillPaymentPrint.jsx</code> (millimetres from the
          cheque&rsquo;s top-left corner).
        </div>
      )}

      {mode === 'voucher' ? (
        <div className="bpp-sheet">
          {bp.status === 'voided' && <div className="bpp-void">VOID</div>}
          <div className="bpp-head">
            <img className="bpp-logo" src={letterhead} alt="GraphicStar Imaging Corp." />
            <div className="bpp-addr">
              GraphicStar Building<br />
              J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Phillipines<br />
              Tel. #238-1234<br />
              www.graphicstar.com.ph
            </div>
          </div>
          <div className="bpp-title">Payment Voucher</div>
          <div className="bpp-cols">
            <div>
              <div>Date : {longDate(bp.check_date || bp.date_created)}</div>
              <div>Paid To : {bp.supplier_name}</div>
              <div>Payee Name : {payee}</div>
              <div>Memo : {bp.memo || ''}</div>
            </div>
            <div>
              <div>Ref # : {bp.reference_no || bp.bill_payment_no}</div>
              {bp.check_no && <div>Check No : {bp.check_no}{bp.bank_account_name ? ` — ${bp.bank_account_name}` : ''}</div>}
              <div>Amount in words : {words}</div>
            </div>
          </div>
          {isCheque ? <ChequeLines bp={bp} /> : (
          <table className="bpp-table">
            <thead>
              <tr>
                <th style={{ width: '17%' }}>Date</th><th>Description</th>
                <th className="bpp-num" style={{ width: '17%' }}>Orig Amount</th>
                <th className="bpp-num" style={{ width: '17%' }}>Amount Due</th>
                <th className="bpp-num" style={{ width: '17%' }}>Applied</th>
              </tr>
            </thead>
            <tbody>
              {bp.lines.map((l) => {
                // Amount Due as it stood before this payment: what is still due plus what this
                // payment took off it (a voided payment has already been reversed).
                const dueBefore = l.vendor_bill_id
                  ? Number(l.vb_amount_due_now || 0) + (bp.status === 'voided' ? 0 : Number(l.applied_amount || 0))
                  : null;
                return (
                  <tr key={l.id}>
                    <td>{shortDate(l.vb_date_created)}</td>
                    <td>{l.vendor_bill_id ? (l.vb_reference_no || l.bill_no) : `Bill Credit ${l.bill_credit_no || ''}`}</td>
                    <td className="bpp-num">{l.vendor_bill_id ? money(l.vb_gross_amount) : ''}</td>
                    <td className="bpp-num">{dueBefore == null ? '' : money(dueBefore)}</td>
                    <td className="bpp-num">{money(l.applied_amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
          <div className="bpp-total">Total : {money(bp.total_amount)}</div>
          <div className="bpp-sign">
            {['Prepared By:', 'Checked By:', 'Approved By:', 'Received BY:'].map((r, i) => (
              <div key={r}>
                <div>{r}</div>
                <div style={{ height: '8mm', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                  {i === 0 && bp.prepared_signature ? <img src={bp.prepared_signature} alt="" style={{ maxHeight: '8mm' }} /> : null}
                </div>
                <div className="bpp-line" style={{ marginTop: '2mm' }} />
                <div style={{ minHeight: '1.4em' }}>{i === 0 ? (bp.created_by_name || '') : ''}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <ChequeFace bp={bp} payee={payee} words={words} calibrate={calibrate} />
      )}
    </div>
  );
}

// The cheque's own voucher table: the expense lines it pays, then any tax withheld.
function ChequeLines({ bp }) {
  const wtax = Number(bp.withholding_tax_amount || 0);
  return (
    <table className="bpp-table">
      <thead>
        <tr>
          <th style={{ width: '30%' }}>Account</th><th style={{ width: '16%' }}>Department</th><th>Description</th>
          <th className="bpp-num" style={{ width: '17%' }}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {bp.lines.map((l) => (
          <tr key={l.id}>
            <td>{l.account_code ? `${l.account_code} — ${l.account_name || ''}` : ''}</td>
            <td>{l.department_name || ''}</td>
            <td>{l.description || ''}</td>
            <td className="bpp-num">{money(l.gross_amount ?? l.amount)}</td>
          </tr>
        ))}
        {wtax > 0 && (
          <tr><td colSpan={3}>Less: Withholding Tax</td><td className="bpp-num">({money(wtax)})</td></tr>
        )}
      </tbody>
    </table>
  );
}

function ChequeFace({ bp, payee, words, calibrate }) {
  const d = ymd(bp.check_date || bp.date_released || bp.date_created);
  const digits = d ? [d.slice(5, 7), d.slice(8, 10), d.slice(0, 4)] : [];
  const cls = (base) => `chq-f${calibrate ? ' chq-out' : ''}`;
  let x = CHEQUE.date.x;
  const dateDigits = [];
  digits.forEach((group, gi) => {
    for (const ch of group) { dateDigits.push(<span key={`${gi}-${x}`} className={cls()} style={{ left: `${x}mm`, top: `${CHEQUE.date.y}mm` }}>{ch}</span>); x += CHEQUE.date.digitGap; }
    x += CHEQUE.date.groupGap;
  });
  return (
    <div className="chq-wrap">
      {calibrate && <ChequeGrid />}
      {bp.status === 'voided' && <div className="bpp-void" style={{ top: '25%', fontSize: '40pt' }}>VOID</div>}
      {dateDigits}
      <div className={cls()} style={{ left: `${CHEQUE.payee.x}mm`, top: `${CHEQUE.payee.y}mm`, width: `${CHEQUE.payee.w}mm`, textAlign: 'center', overflow: 'hidden' }}>{payee}</div>
      <div className={cls()} style={{ left: `${CHEQUE.amount.x}mm`, top: `${CHEQUE.amount.y}mm`, width: `${CHEQUE.amount.w}mm`, textAlign: 'center' }}>{money(bp.total_amount)}</div>
      <div className={cls()} style={{ left: `${CHEQUE.words.x}mm`, top: `${CHEQUE.words.y}mm`, width: `${CHEQUE.words.w}mm`, textAlign: 'center', whiteSpace: 'normal', lineHeight: 1.3 }}>{words}</div>
    </div>
  );
}

function ChequeGrid() {
  const lines = [];
  for (let x = 0; x <= CHEQUE.size.width; x += 10) lines.push(<div key={`v${x}`} style={{ position: 'absolute', left: `${x}mm`, top: 0, bottom: 0, borderLeft: '0.1mm solid rgba(59,130,246,.35)' }} />);
  for (let y = 0; y <= CHEQUE.size.height; y += 10) lines.push(<div key={`h${y}`} style={{ position: 'absolute', top: `${y}mm`, left: 0, right: 0, borderTop: '0.1mm solid rgba(59,130,246,.35)' }} />);
  return <>{lines}</>;
}
