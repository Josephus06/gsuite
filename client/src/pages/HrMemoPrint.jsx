import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import header from '../assets/memo-header.jpeg';
import footer from '../assets/memo-footer.jpeg';

// Memo on the company's own template ("NOVEMBER 2026.docx", 2026-10-27): US Letter, Times New Roman
// 12pt, the GraphicStar logo over the blue/orange rule in the header and the three branch addresses in
// the footer -- the template's own two images, placed where Word places them. A long memo runs onto
// more pages; the letterhead repeats on each (fixed in print, with the body inside a table whose
// header/footer rows reserve the letterhead's space on every page).
// Printing is gated server-side (GET /hr-memos/:id/print, can_print).

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
// "OCTOBER 27, 2026"
function longDate(v) {
  const [y, m, d] = String(v || '').slice(0, 10).split('-').map(Number);
  return y ? `${MONTHS[m - 1]} ${d}, ${y}` : '';
}
// The template's holiday table is 4149 / 3308 / 2702 twips wide; other tables share the width evenly.
const colWidths = (n) => (n === 3 ? ['40.8%', '32.6%', '26.6%'] : Array(n).fill(`${100 / n}%`));

export default function HrMemoPrint() {
  const { id } = useParams();
  const [memo, setMemo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/hr-memos/${id}/print`)
      .then(({ data }) => setMemo(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this memo.'));
  }, [id]);

  useEffect(() => { if (memo) document.title = `${memo.memo_no} ${memo.subject}`; }, [memo]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this memo</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!memo) return <LoadingSpinner />;

  // Signed in the name of the General Manager who approved it; nobody's name before that.
  const approved = memo.status === 'approved';

  return (
    <div className="memop">
      <style>{`
        .memop { background: #f1f5f9; padding: 16px 0 40px; }
        .memop-toolbar { width: 215.9mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .memop-sheet { width: 215.9mm; min-height: 279.4mm; margin: 0 auto; background: #fff; color: #000; position: relative;
          box-shadow: 0 1px 6px rgba(0,0,0,.25); box-sizing: border-box; padding: 0 25.4mm;
          font: 12pt/1.15 'Times New Roman', Times, serif; }
        /* Header: the image is 184.3 x 17.7mm, centred in a paragraph indented 0.375in past each margin,
           7.9mm (450 twips) from the top. Footer: 208.2 x 35.6mm, 0.875in left of the margin, at the foot. */
        .memop-head { position: absolute; top: 7.9mm; left: 15.8mm; width: 184.3mm; height: 17.7mm; }
        .memop-foot { position: absolute; bottom: 0; left: 3.2mm; width: 208.2mm; height: 35.6mm; }
        .memop-head img, .memop-foot img { display: block; width: 100%; height: 100%; }
        .memop-draft { position: absolute; top: 42%; left: 0; right: 0; text-align: center; font: 700 54pt Arial, sans-serif;
          color: rgba(220,38,38,.16); transform: rotate(-28deg); pointer-events: none; }
        .memop-page { width: 100%; border-collapse: collapse; }
        .memop-page > thead td { height: 28.3mm; padding: 0; }
        .memop-page > tfoot td { height: 40mm; padding: 0; }
        .memop-page > * > tr > td { border: 0; background: none; }
        .memop-page > tbody > tr > td { padding: 0; vertical-align: top; }
        .memop-lines div { display: grid; grid-template-columns: 25.4mm 1fr; font-weight: 700; }
        .memop-lines span + span::before { content: ':\\00a0\\00a0\\00a0'; }
        .memop-p { margin: 0 0 1.15em; white-space: pre-wrap; }
        .memop-table { width: 100%; border-collapse: collapse; margin: 0 0 2.3em; table-layout: fixed; }
        .memop-table th, .memop-table td { border: .5pt solid #000; padding: 0 1.9mm; text-align: center; vertical-align: top;
          background: none; color: #000; font: inherit; white-space: normal; }
        .memop-table th { font-weight: 700; }
        .memop-table td { text-decoration: underline; }
        .memop-sign { display: grid; grid-template-columns: 101.6mm 1fr; margin-top: 5.75em; break-inside: avoid; }
        .memop-sign .who { position: relative; margin-top: 2.3em; }
        .memop-sign .name { font-weight: 700; text-decoration: underline; }
        .memop-sign .title { font-weight: 700; }
        /* E-signatures, their foot just over the name as ink would sit. */
        .memop-esign { position: absolute; left: -2mm; bottom: 1.7em; height: 13mm; width: auto; max-width: 55mm;
          object-fit: contain; mix-blend-mode: multiply; pointer-events: none; }
        @media print {
          html, body, #root, .memop { background: #fff !important; }
          .memop { padding: 0; }
          .memop-no-print { display: none !important; }
          .memop-sheet { box-shadow: none; margin: 0; min-height: 0; }
          .memop-head, .memop-foot, .memop-draft { position: fixed; }
          @page { size: letter portrait; margin: 0; }
        }
      `}</style>

      <div className="memop-toolbar memop-no-print">
        {!approved && (
          <span style={{ marginRight: 'auto', alignSelf: 'center', color: '#b45309', font: '13px system-ui, sans-serif' }}>
            {memo.status === 'rejected'
              ? `Rejected: ${memo.rejected_reason || ''}`
              : `Waiting for ${memo.approver_name || 'the General Manager'} to approve.`}
          </span>
        )}
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="memop-sheet">
        <div className="memop-head"><img src={header} alt="GraphicStar" /></div>

        <table className="memop-page">
          <thead><tr><td /></tr></thead>
          <tfoot><tr><td /></tr></tfoot>
          <tbody>
            <tr>
              <td>
                <div className="memop-lines">
                  <div><span>TO</span><span>{memo.memo_to}</span></div>
                  <div><span>FROM</span><span>{memo.memo_from}</span></div>
                  <div><span>DATE</span><span>{longDate(memo.memo_date)}</span></div>
                  <div><span>SUBJECT</span><span>{memo.subject}</span></div>
                </div>
                <div style={{ height: '1.15em' }} />
                {memo.heading && <p className="memop-p" style={{ fontWeight: 700 }}>{memo.heading}</p>}

                {memo.body.map((b, i) => (b.type === 'table' ? (
                  <table key={i} className="memop-table">
                    <colgroup>{colWidths(b.columns.length).map((w, j) => <col key={j} style={{ width: w }} />)}</colgroup>
                    <thead><tr>{b.columns.map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
                    <tbody>
                      {b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
                    </tbody>
                  </table>
                ) : (
                  <p key={i} className="memop-p" style={{ fontWeight: b.bold ? 700 : 400 }}>{b.text}</p>
                )))}

                <div className="memop-sign">
                  <div>
                    <div>Prepared by:</div>
                    <div className="who">
                      {approved && memo.preparer_signature && <img className="memop-esign" src={memo.preparer_signature} alt="" />}
                      <div className="name">{memo.prepared_by_name || ' '}</div>
                      <div className="title">{memo.prepared_by_title || ' '}</div>
                    </div>
                  </div>
                  <div>
                    <div>Approved by:</div>
                    <div className="who">
                      {approved && memo.signature && <img className="memop-esign" src={memo.signature} alt="" />}
                      <div className={approved ? 'name' : undefined}>{approved ? memo.signatory_name : ' '}</div>
                      <div className="title">{approved ? memo.signatory_title : 'General Manager'}</div>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        {!approved && <div className="memop-draft">NOT YET APPROVED</div>}
        <div className="memop-foot"><img src={footer} alt="" /></div>
      </div>
    </div>
  );
}
