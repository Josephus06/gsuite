import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import letterhead from '../assets/graphicstar-letterhead.png';

// Printable Certificate of Completion (2026-10-28), standalone: the letterhead, the certification
// itself (project, location, contract package, SO / PO, customer), Submitted By, then a signature
// line for each Approver and each Certifier -- the customer's people, in the order picked.
const longDate = (v) => (v
  ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  : '');

function SignBlock({ label, people }) {
  if (!people?.length) return null;
  return (
    <div className="coc-signs">
      <div className="coc-sign-label">{label}</div>
      <div className="coc-sign-grid">
        {people.map((p) => (
          <div key={p.id} className="coc-sign">
            <div className="coc-sign-line" />
            <div style={{ fontWeight: 700 }}>{p.name}</div>
            <div>{p.job_title}</div>
            <div className="coc-date">Date: ____________________</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CompletionCertificatePrint() {
  const { id } = useParams();
  const [cc, setCc] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/completion-certificates/${id}`)
      .then(({ data }) => setCc(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the certificate.'));
  }, [id]);

  if (error) return <div style={{ maxWidth: 620, margin: '80px auto', textAlign: 'center', font: '14px system-ui' }}>{error}</div>;
  if (!cc) return <LoadingSpinner />;

  return (
    <div className="coc">
      <style>{`
        .coc { background: #f1f5f9; padding: 16px 0 40px; }
        .coc-toolbar { max-width: 215.9mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; }
        .coc-sheet { width: 215.9mm; min-height: 279.4mm; margin: 0 auto; padding: 16mm 20mm; background: #fff; color: #111;
          box-sizing: border-box; box-shadow: 0 1px 6px rgba(0,0,0,.25); font: 11pt/1.6 'Times New Roman', serif; position: relative; }
        .coc-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; }
        .coc-logo { width: 62mm; height: auto; }
        .coc-addr { text-align: right; font: 8pt/1.45 system-ui, sans-serif; color: #475569; }
        .coc-title { text-align: center; font-size: 20pt; font-weight: 700; letter-spacing: 2px; margin: 12mm 0 2mm; }
        .coc-no { text-align: center; font-size: 10pt; color: #475569; margin-bottom: 9mm; }
        .coc-body { text-align: justify; }
        .coc-facts { margin: 6mm 0 8mm; border-collapse: collapse; width: 100%; }
        .coc-facts td { padding: 3px 6px; vertical-align: top; border: 0; background: none; }
        .coc-facts td:first-child { width: 42mm; font-weight: 700; white-space: nowrap; }
        .coc-signs { margin-top: 9mm; page-break-inside: avoid; }
        .coc-sign-label { font-weight: 700; margin-bottom: 2mm; }
        .coc-sign-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm 16mm; }
        .coc-sign { text-align: center; }
        .coc-sign-line { border-top: 1px solid #000; margin: 12mm 4mm 1mm; }
        .coc-date { font-size: 9pt; color: #475569; margin-top: 1mm; }
        .coc-void { position: absolute; top: 40%; left: 0; right: 0; text-align: center; font-size: 64pt; font-weight: 800;
          color: rgba(220,38,38,.18); transform: rotate(-20deg); pointer-events: none; }
        @media print {
          html, body, #root, .coc { background: #fff !important; }
          .coc { padding: 0; }
          .coc-toolbar { display: none !important; }
          .coc-sheet { box-shadow: none; margin: 0; min-height: 0; }
          @page { size: letter portrait; margin: 0; }
        }
      `}</style>
      <div className="coc-toolbar">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="coc-sheet">
        {cc.status === 'voided' && <div className="coc-void">VOID</div>}
        <div className="coc-head">
          <img className="coc-logo" src={letterhead} alt="GraphicStar Imaging Corp." />
          <div className="coc-addr">
            GraphicStar Building<br />
            J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Philippines<br />
            Tel. #238-1234<br />
            www.graphicstar.com.ph
          </div>
        </div>

        <div className="coc-title">CERTIFICATE OF COMPLETION</div>
        <div className="coc-no">{cc.coc_no} &nbsp;·&nbsp; {longDate(cc.date_created)}</div>

        <p className="coc-body">
          This is to certify that <b>GRAPHICSTAR IMAGING CORP.</b> has satisfactorily completed the work described below for
          {' '}<b>{cc.customer_name}</b>, in accordance with the agreed plans and specifications.
        </p>

        <table className="coc-facts">
          <tbody>
            <tr><td>Project Name</td><td>{cc.project_name}</td></tr>
            <tr><td>Location</td><td>{cc.location}</td></tr>
            <tr><td>Contract Package</td><td>{cc.contract_package}</td></tr>
            <tr><td>Sales Order No.</td><td>{cc.sales_order_no}</td></tr>
            {cc.po_no && <tr><td>PO No.</td><td>{cc.po_no}</td></tr>}
          </tbody>
        </table>

        <p className="coc-body">
          The undersigned have inspected the completed work and hereby accept it as complete.
        </p>

        {cc.submitted_by_name && (
          <div className="coc-signs">
            <div className="coc-sign-label">Submitted by:</div>
            <div className="coc-sign-grid">
              <div className="coc-sign">
                <div className="coc-sign-line" />
                <div style={{ fontWeight: 700 }}>{String(cc.submitted_by_name).toUpperCase()}</div>
                <div>GraphicStar Imaging Corp.</div>
              </div>
            </div>
          </div>
        )}
        <SignBlock label="Approved by:" people={cc.approvers} />
        <SignBlock label="Certified by:" people={cc.certifiers} />
      </div>
    </div>
  );
}
