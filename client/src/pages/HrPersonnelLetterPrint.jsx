import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import header from '../assets/memo-header.jpeg';
import footer from '../assets/coe-footer.jpeg';
import { LETTERS } from './HrPersonnelLetters';

// Regularization / Salary Adjustment letters on the company's own templates ("regularization
// format.docx", "SALARY ADJUSTMENT FORMAT.docx", 2026-11-07): US Letter, Times New Roman, the
// GraphicStar logo over the blue/orange rule in the header (the same 170.7 x 16.5mm group as the Memo's)
// and the three branch addresses in the footer (the COE's image, the same file). Each letter keeps its
// template's own margins and type size: Regularization 11.5pt at 1.15 lines with 1.25in sides, Salary
// Adjustment 12pt single-spaced with 1in sides. Printing is gated server-side (GET .../:id/print).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(v) {
  const [y, m, d] = String(v || '').slice(0, 10).split('-').map(Number);
  return y ? `${MONTHS[m - 1]} ${d}, ${y}` : '';
}
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BASIS = { monthly: 'MONTHLY', daily: 'DAILY' };
const blank = (s, w = '30mm') => s || <span style={{ display: 'inline-block', width: w, borderBottom: '1px solid #000' }}>&nbsp;</span>;

export default function HrPersonnelLetterPrint({ kind }) {
  const L = LETTERS[kind];
  const { id } = useParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`${L.api}/${id}/print`)
      .then(({ data }) => setDoc(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this letter.'));
  }, [id, L.api]);
  useEffect(() => { if (doc) document.title = `${doc.letter_no} ${doc.employee_name}`; }, [doc]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this letter</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!doc) return <LoadingSpinner />;

  const reg = kind === 'regularization';
  // Signed in the name of the General Manager who approved it; nobody's name before that.
  const approved = doc.status === 'approved';

  // The signature blocks are the same on both: HR's sign-off, then Approved by the General Manager.
  const Signer = ({ sig, name, title, nameBold = true }) => (
    <div className="hrlp-who">
      {approved && sig && <img className="hrlp-esign" src={sig} alt="" />}
      <div style={{ fontWeight: nameBold ? 700 : 400 }}>{name || ' '}</div>
      <div>{title}</div>
    </div>
  );

  return (
    <div className="hrlp">
      <style>{`
        .hrlp { background: #f1f5f9; padding: 16px 0 40px; }
        .hrlp-toolbar { width: 215.9mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .hrlp-sheet { width: 215.9mm; height: 279.4mm; margin: 0 auto; background: #fff; color: #000; position: relative; overflow: hidden;
          box-shadow: 0 1px 6px rgba(0,0,0,.25); box-sizing: border-box; font-family: 'Times New Roman', Times, serif; }
        .hrlp-sheet.reg { padding: 30mm 31.75mm 34mm; font-size: 11.5pt; line-height: 1.15; }
        .hrlp-sheet.sal { padding: 30mm 25.4mm 34mm; font-size: 12pt; line-height: 1; }
        /* The header group: 170.7 x 16.5mm, a little left of the text column as Word places it. */
        .hrlp-head { position: absolute; top: 7.9mm; width: 170.7mm; height: 16.5mm; }
        .hrlp-sheet.reg .hrlp-head { left: 27.6mm; }
        .hrlp-sheet.sal .hrlp-head { left: 18.8mm; }
        .hrlp-foot { position: absolute; bottom: 3mm; left: 0; width: 215.9mm; height: 25.7mm; }
        .hrlp-head img, .hrlp-foot img { display: block; width: 100%; height: 100%; }
        .hrlp-draft { position: absolute; top: 42%; left: 0; right: 0; text-align: center; font: 700 54pt Arial, sans-serif;
          color: rgba(220,38,38,.16); transform: rotate(-28deg); pointer-events: none; }
        .hrlp-sheet p { margin: 0; text-align: justify; }
        .hrlp-gap { height: 1.15em; }
        .hrlp-who { position: relative; }
        /* E-signatures, their foot just over the name as ink would sit. */
        .hrlp-esign { position: absolute; left: -2mm; bottom: 1.6em; height: 13mm; width: auto; max-width: 55mm;
          object-fit: contain; mix-blend-mode: multiply; pointer-events: none; }
        .hrlp-lines div { display: grid; grid-template-columns: 27mm 6mm 1fr; font-weight: 700; margin-bottom: 1mm; }
        .hrlp-rate { border-collapse: collapse; margin: 3mm 0; width: 100%; }
        .hrlp-rate th, .hrlp-rate td { border: .5pt solid #000; padding: 1.5mm 2mm; background: none; color: #000; font: inherit; text-align: center; }
        .hrlp-rate th { font-weight: 700; }
        .hrlp-rate td:first-child { font-weight: 700; text-align: left; }
        .hrlp-conform { display: inline-block; min-width: 70mm; border-bottom: 1px solid #000; text-align: center; font-weight: 700; }
        @media print {
          html, body, #root, .hrlp { background: #fff !important; }
          .hrlp { padding: 0; }
          .hrlp-no-print { display: none !important; }
          .hrlp-sheet { box-shadow: none; margin: 0; }
          @page { size: letter portrait; margin: 0; }
        }
      `}</style>

      <div className="hrlp-toolbar hrlp-no-print">
        {!approved && (
          <span style={{ marginRight: 'auto', alignSelf: 'center', color: '#b45309', font: '13px system-ui, sans-serif' }}>
            {doc.status === 'rejected' ? `Rejected: ${doc.rejected_reason || ''}` : `Waiting for ${doc.approver_name || 'the General Manager'} to approve.`}
          </span>
        )}
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className={`hrlp-sheet ${reg ? 'reg' : 'sal'}`}>
        <div className="hrlp-head"><img src={header} alt="GraphicStar" /></div>

        {reg ? (
          <>
            <p>Date: <u>{longDate(doc.letter_date)}</u></p>
            <div className="hrlp-gap" />
            <p>Name: <b>{doc.employee_name}</b></p>
            <p>Address: {blank(doc.employee_address, '60mm')}</p>
            <div className="hrlp-gap" /><div className="hrlp-gap" />
            <p>Subject: <b>REGULARIZATION CONTRACT</b></p>
            <div className="hrlp-gap" /><div className="hrlp-gap" />
            <p><b>Dear {doc.salutation || 'Mr./Ms.'},</b></p>
            <div className="hrlp-gap" />
            <p><b>We are pleased to inform you that your employment with the company is now regularized effective {longDate(doc.effective_date)}.</b></p>
            <div className="hrlp-gap" />
            <p>
              It is understood that you will continue to be bounded by the Confidentiality Agreement and Non-Competition Clause
              incorporated in the Probationary Employment Contract and in the Employee Handbook that you signed with us. Such
              provisions shall be deemed incorporated as part of the terms and conditions of your regular employment with us.
            </p>
            <div className="hrlp-gap" />
            <p>We look forward to more years of fruitful partnership with you.</p>
            <div className="hrlp-gap" />
            <p>Sincerely yours,</p>
            <div className="hrlp-gap" /><div className="hrlp-gap" />
            <Signer sig={doc.preparer_signature} name={doc.prepared_by_name} title={doc.prepared_by_title} />
            <div className="hrlp-gap" /><div className="hrlp-gap" />
            <p><b>Approved by:</b></p>
            <div className="hrlp-gap" /><div className="hrlp-gap" />
            <Signer sig={doc.signature} name={approved ? doc.signatory_name : ''} title={approved ? doc.signatory_title : 'General Manager'} />
            <div className="hrlp-gap" /><div className="hrlp-gap" />
            <p>With my conformity:</p>
            <div className="hrlp-gap" /><div className="hrlp-gap" />
            <p><span className="hrlp-conform">{doc.employee_name}</span></p>
          </>
        ) : (
          <>
            <div className="hrlp-lines">
              <div><span>TO</span><span>:</span><span>{doc.employee_name}</span></div>
              <div><span>FROM</span><span>:</span><span>HUMAN RESOURCES DEPARTMENT</span></div>
              <div><span>DATE</span><span>:</span><span>{longDate(doc.letter_date)}</span></div>
              <div><span>SUBJECT</span><span>:</span><span>SALARY ADJUSTMENT</span></div>
            </div>
            <div className="hrlp-gap" />
            <p>
              We are pleased to confirm your salary adjustment effective on <b>{longDate(doc.effective_date)}</b>. You will be
              receiving a new salary rate of:
            </p>
            <div className="hrlp-gap" />
            <p>To wit:</p>
            <table className="hrlp-rate">
              <thead><tr><th style={{ width: '22%' }} /><th>Current Rate</th><th>New Salary Rate</th></tr></thead>
              <tbody>
                <tr>
                  <td>BASIC</td>
                  <td>{doc.current_rate != null ? `Php ${money(doc.current_rate)}/${BASIS[doc.current_basis] || ''}` : 'Php ______'}</td>
                  <td><b>Php {money(doc.new_rate)}/{BASIS[doc.new_basis] || ''}</b></td>
                </tr>
              </tbody>
            </table>
            <div className="hrlp-gap" />
            <p style={{ textIndent: '12.7mm' }}>
              We wish you luck in this endeavour and we hope that you will prove yourself equal to the task assigned to you.
            </p>
            <div className="hrlp-gap" />
            <p><b>CONGRATULATIONS!</b></p>
            <div className="hrlp-gap" />
            <p>Yours truly,</p>
            <div className="hrlp-gap" /><div className="hrlp-gap" /><div className="hrlp-gap" />
            <Signer sig={doc.preparer_signature} name={doc.prepared_by_name} title={doc.prepared_by_title} />
            <div className="hrlp-gap" />
            <p>Approved by:</p>
            <div className="hrlp-gap" /><div className="hrlp-gap" /><div className="hrlp-gap" />
            <Signer sig={doc.signature} name={approved ? doc.signatory_name : ''} title={approved ? doc.signatory_title : 'General Manager'} />
            <div className="hrlp-gap" /><div className="hrlp-gap" /><div className="hrlp-gap" />
            <p>Conforme: <span className="hrlp-conform">{doc.employee_name}</span></p>
            <p style={{ paddingLeft: '22mm', fontWeight: 700, textAlign: 'left' }}>Printed Name and Signature</p>
          </>
        )}

        {!approved && <div className="hrlp-draft">NOT YET APPROVED</div>}
        <div className="hrlp-foot"><img src={footer} alt="" /></div>
      </div>
    </div>
  );
}
