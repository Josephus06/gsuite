import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import logo from '../assets/coe-logo-creations.png';
import rule from '../assets/coe-logo-digital.jpeg';
import footer from '../assets/coe-footer.jpeg';

// Certificate of Employment on the company's own templates (COE.docx and "COE Template.docx", 2026-10-22):
// A4, Times New Roman, the GraphicStar logo over the blue/orange rule in the header and the three
// branch addresses in the footer. Both letterhead pieces are the images out of those .docx files,
// cropped and placed as Word placed them, so the paper matches what HR printed before.
// Printing is gated server-side (GET /hr-coe/:id/print, can_print).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function parts(v) {
  const [y, m, d] = String(v || '').slice(0, 10).split('-').map(Number);
  return y ? { y, m, d } : null;
}
// "January 5, 2020"
const longDate = (v) => { const p = parts(v); return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : ''; };
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

export default function HrCoePrint() {
  const { id } = useParams();
  const [coe, setCoe] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/hr-coe/${id}/print`)
      .then(({ data }) => setCoe(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this certificate.'));
  }, [id]);

  useEffect(() => { if (coe) document.title = `${coe.coe_no} ${coe.employee_name}`; }, [coe]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this certificate</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!coe) return <LoadingSpinner />;

  const his = { he: 'his', she: 'her' }[coe.pronoun] || 'his/her';
  const he = { he: 'he', she: 'she' }[coe.pronoun] || 'he/she';
  const issued = parts(coe.issued_date);
  const givenOn = issued ? `${ordinal(issued.d)} day of ${MONTHS[issued.m - 1]} ${issued.y}` : '';
  const to = coe.date_to ? longDate(coe.date_to) : 'present';
  const rating = coe.coe_type === 'with_rating';
  const issuedTo = coe.issued_to || coe.employee_name;

  return (
    <div className="coep">
      <style>{`
        .coep { background: #f1f5f9; padding: 16px 0 40px; }
        .coep-toolbar { width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .coep-sheet { width: 210mm; height: 297mm; margin: 0 auto; background: #fff; color: #000; position: relative;
          box-shadow: 0 1px 6px rgba(0,0,0,.25); box-sizing: border-box; overflow: hidden;
          padding: 25.4mm 31.75mm 40mm; font-family: 'Times New Roman', Times, serif; }
        /* Header group as Word anchors it: 169.5mm x 20.1mm, 9.35mm left of the text column. */
        .coep-head { position: absolute; top: 4mm; left: 22.4mm; width: 169.5mm; height: 20.1mm; }
        .coep-logo { position: absolute; left: 5.4mm; top: 0; width: 106.4mm; height: 17mm; overflow: hidden; }
        .coep-logo img { position: absolute; height: 100%; width: 142.2mm; left: -19.27mm; top: 0; }
        .coep-rule { position: absolute; left: 0; top: 16.9mm; width: 100%; height: 3.2mm; overflow: hidden; }
        .coep-rule img { position: absolute; width: 100%; height: 16mm; left: 0; bottom: 0; }
        .coep-foot { position: absolute; bottom: 8mm; left: 2.6mm; width: 201.2mm; height: 25.7mm; overflow: hidden; }
        .coep-foot img { position: absolute; width: 215.8mm; height: 28.2mm; left: -6.75mm; top: 0; }
        .coep-addr { font-size: 10.5pt; line-height: 1.15; }
        .coep-title { text-align: center; font-weight: 700; text-decoration: underline; }
        .coep-body p { text-align: justify; margin: 0; }
        .coep-indent { text-indent: 12.7mm; }
        .coep-sign { margin-top: 18mm; }
        .coep-sign div { margin-bottom: 2mm; }
        .coep-table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 2mm 0 4mm; }
        .coep-table th, .coep-table td { border: 1px solid #000; padding: 1.2mm 1.6mm; vertical-align: middle; background: none;
          color: #000; font-weight: 400; white-space: normal; text-align: left; }
        .coep-table th { font-weight: 700; text-align: center; }
        .coep-table td.c { text-align: center; }
        @media print {
          html, body, #root, .coep { background: #fff !important; }
          .coep { padding: 0; }
          .coep-no-print { display: none !important; }
          .coep-sheet { box-shadow: none; margin: 0; }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      <div className="coep-toolbar coep-no-print">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="coep-sheet">
        <div className="coep-head">
          <div className="coep-logo"><img src={logo} alt="GraphicStar" /></div>
          <div className="coep-rule"><img src={rule} alt="" /></div>
        </div>

        <div className="coep-addr">
          <div>J.S. Alinsug St., Basak, Mandaue City</div>
          <div>Tel. No. 238-1234</div>
        </div>

        {rating ? (
          <div className="coep-body" style={{ fontSize: '11pt', lineHeight: 1.15 }}>
            <div className="coep-title" style={{ fontSize: '12pt', margin: '10mm 0 8mm' }}>CERTIFICATE OF EMPLOYMENT</div>
            <p className="coep-indent" style={{ lineHeight: 1.5, marginBottom: '4mm' }}>
              This is to certify that <b>{coe.employee_name}</b> was employed with <b>CEBU GRAPHICSTAR IMAGING CORPORATION</b> as
              a <b>{coe.position_title || '____________'}</b> from {longDate(coe.date_from)} to {to}.
            </p>
            <div style={{ fontSize: '10.5pt', fontWeight: 700, paddingLeft: '25.4mm', marginBottom: '2mm' }}>
              Performance Appraisal prior to separation
            </div>
            <table className="coep-table">
              <colgroup><col style={{ width: '34%' }} /><col style={{ width: '33%' }} /><col style={{ width: '33%' }} /></colgroup>
              <thead><tr><th /><th>RATING</th><th>REMARKS</th></tr></thead>
              <tbody>
                {(coe.ratings || []).map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td className="c">{r.rating || '_________'}</td>
                    <td>{r.remarks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Mode of Separation: {coe.mode_of_separation || '_________'}</p>
            <p style={{ marginBottom: '4mm' }}>Clearance Status: {coe.clearance_status || '___________'}</p>
            <p style={{ fontSize: '12pt', marginBottom: '4mm' }}>
              This certificate is issued upon request of <b>{issuedTo}</b> as a proof that {he} no longer has any
              accountability due to the company. It is issued for employment purposes and for whatever lawful purpose
              it may serve {his} best.
            </p>
            <p style={{ fontSize: '10.5pt', textAlign: 'left' }}>
              Issued this {givenOn} at Basak, Mandaue City, Cebu, Philippines.
            </p>
            <div className="coep-sign" style={{ fontSize: '13pt', marginTop: '14mm' }}>
              <div><b>{coe.signatory_name}</b></div>
              <div>{coe.signatory_title}</div>
            </div>
          </div>
        ) : (
          <div className="coep-body" style={{ fontSize: '13pt' }}>
            <div className="coep-title" style={{ fontSize: '18pt', margin: '12mm 0 14mm' }}>CERTIFICATE OF EMPLOYMENT</div>
            <p className="coep-indent" style={{ lineHeight: 1.5, marginBottom: '7mm' }}>
              This is to certify that <b>{coe.employee_name}</b> has been employed with <b>CEBU GRAPHICSTAR IMAGING
              CORPORATION</b> as a <b>{coe.position_title || '____________'}</b> from {longDate(coe.date_from)} to {to}.
            </p>
            <p className="coep-indent" style={{ lineHeight: 1.5, marginBottom: '7mm' }}>
              This certification is being issued to <b>{issuedTo}</b> for whatever legal purpose it may serve {his} best.
            </p>
            <p>Given this {givenOn} at Basak, Mandaue City, Cebu, Philippines.</p>
            <div className="coep-sign" style={{ marginTop: '24mm' }}>
              <div><b>{coe.signatory_name}</b></div>
              <div>{coe.signatory_title}</div>
              <div>Cebu Graphicstar Imaging Corporation</div>
            </div>
          </div>
        )}

        <div className="coep-foot"><img src={footer} alt="" /></div>
      </div>
    </div>
  );
}
