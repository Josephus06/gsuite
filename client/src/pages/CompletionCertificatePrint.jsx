import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import mark from '../assets/graphicstar-mark.png';

// The two printouts of a Certificate of Completion (2026-10-28), as the source's Print menu has them
// -- the Certificate of Completion and the Certificate of Acceptance -- both on the certificate design
// HR sent: letter landscape, a framed page, the company heading, the title, a box of the project's
// facts, the source's own wording, then Submitted By / Certified By / Approved By / the date.
//   /completion-certificates/:id/print                     Certificate of Completion
//   /completion-certificates/:id/print?type=acceptance     Certificate of Acceptance
const CONTRACTOR = 'Cebu Graphicstar Imaging Corporation';
const COMPANY = 'CEBU GRAPHICSTAR IMAGING CORPORATION';
const COMPANY_LINE = 'J.S. Alinsug St., Basak Mandaue City, Cebu 6014 · Tel. #238-1234 · www.graphicstar.com.ph';

const longDate = (v) => (v
  ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  : '');

function Sign({ label, name, title, date }) {
  return (
    <div className="cc-sign">
      {label !== '' && <div className="cc-sign-label">{label}</div>}
      <div className="cc-sign-line" />
      {date ? (
        <div className="cc-sign-sub">Month / Day / Year</div>
      ) : (
        <>
          <div className="cc-sign-name">{name || ' '}</div>
          <div className="cc-sign-sub">{title ? `${title} · ` : ''}Date: ________</div>
        </>
      )}
    </div>
  );
}

export default function CompletionCertificatePrint() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const acceptance = params.get('type') === 'acceptance';
  const [cc, setCc] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/completion-certificates/${id}`)
      .then(({ data }) => setCc(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the certificate.'));
  }, [id]);

  if (error) return <div style={{ maxWidth: 620, margin: '80px auto', textAlign: 'center', font: '14px system-ui' }}>{error}</div>;
  if (!cc) return <LoadingSpinner />;

  const project = cc.project_name || '';
  const client = cc.customer_name || '';
  // Each signing slot takes the list's people; more than one prints one under another.
  const certifiers = cc.certifiers?.length ? cc.certifiers : [{ id: 'c', name: '', job_title: '' }];
  const approvers = cc.approvers?.length ? cc.approvers : [{ id: 'a', name: '', job_title: '' }];
  const facts = acceptance
    ? [['Project', project], ['Owner', client], ['Contractor', CONTRACTOR], ['Contract Package', cc.contract_package], ['Purchase Order No.', cc.po_no]]
    : [['Project', project], ['Location', cc.location], ['Client', client], ['Contractor', CONTRACTOR], ['Contract Package', cc.contract_package], ['Purchase Order No.', cc.po_no]];

  return (
    <div className="cc">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Poppins:wght@400;500;600;700&display=swap" />
      <style>{`
        .cc { background: #f1f5f9; padding: 16px 0 40px; }
        .cc-toolbar { max-width: 279.4mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; }
        .cc-sheet { width: 279.4mm; height: 215.9mm; margin: 0 auto; background: #fff; box-sizing: border-box; position: relative;
          box-shadow: 0 1px 6px rgba(0,0,0,.25); padding: 5mm 6mm; color: #1f2937; font: 9.6pt/1.55 Poppins, 'Segoe UI', sans-serif;
          -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .cc-sheet::before, .cc-sheet::after { content: ''; position: absolute; left: 0; right: 0; height: 3.2mm; background: #2e3192; }
        .cc-sheet::before { top: 0; } .cc-sheet::after { bottom: 0; }
        .cc-frame { position: absolute; inset: 6.5mm 6mm; border: 1px solid #7c7fd1; padding: 1.4mm; }
        .cc-inner { border: 1px solid #c9a96e; height: 100%; box-sizing: border-box; padding: 6mm 9mm 5mm; display: flex; flex-direction: column; }
        .cc-head { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5e7eb; padding-bottom: 4mm; }
        .cc-brand { display: flex; align-items: center; gap: 4mm; }
        .cc-logo { width: 15mm; height: 15mm; border: 1px dashed #cbd5e1; border-radius: 2mm; display: flex; align-items: center; justify-content: center; }
        .cc-logo img { max-width: 12mm; max-height: 12mm; }
        .cc-company { font-weight: 600; color: #2e3192; font-size: 12pt; letter-spacing: .4px; }
        .cc-company-line { font-size: 8pt; color: #64748b; }
        .cc-meta { text-align: right; font-size: 8.4pt; color: #475569; line-height: 1.7; }
        .cc-meta b { color: #111827; }
        .cc-title { font: 700 25pt 'Playfair Display', Georgia, serif; color: #2e3192; text-align: center; margin: 3mm 0 0; }
        .cc-orn { display: flex; align-items: center; justify-content: center; gap: 2mm; margin: 1mm 0 3.5mm; }
        .cc-orn span { width: 22mm; height: 1px; background: #c9a96e; }
        .cc-orn i { width: 2mm; height: 2mm; background: #a07d3b; transform: rotate(45deg); }
        .cc-facts { background: #f3f4f8; border-radius: 1.5mm; padding: 3mm 5mm; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.4mm 6mm; }
        .cc-fact-k { font-size: 7pt; letter-spacing: 1px; color: #64748b; text-transform: uppercase; }
        .cc-fact-v { font-weight: 600; color: #111827; font-size: 9pt; line-height: 1.35; }
        .cc-body { margin-top: 3mm; text-align: justify; }
        .cc-body p { margin: 0 0 2mm; }
        .cc-hi { color: #2e3192; font-weight: 600; }
        .cc-signs { margin-top: auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 7mm; padding-top: 3mm; }
        .cc-sign-label { font-size: 7pt; letter-spacing: 1px; color: #64748b; text-transform: uppercase; height: 9mm; }
        .cc-sign-line { border-top: 1px solid #6b7280; margin-bottom: 1.2mm; }
        .cc-sign-name { font-weight: 600; font-size: 9pt; }
        .cc-sign-sub { font-size: 7.6pt; color: #64748b; }
        .cc-stack + .cc-stack { margin-top: 7mm; }
        .cc-void { position: absolute; top: 40%; left: 0; right: 0; text-align: center; font-size: 72pt; font-weight: 800;
          color: rgba(220,38,38,.16); transform: rotate(-14deg); pointer-events: none; }
        @media print {
          html, body, #root, .cc { background: #fff !important; }
          .cc { padding: 0; }
          .cc-toolbar { display: none !important; }
          .cc-sheet { box-shadow: none; margin: 0; }
          @page { size: letter landscape; margin: 0; }
        }
      `}</style>
      <div className="cc-toolbar">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="cc-sheet">
        {cc.status === 'voided' && <div className="cc-void">VOID</div>}
        <div className="cc-frame">
          <div className="cc-inner">
            <div className="cc-head">
              <div className="cc-brand">
                <div className="cc-logo"><img src={mark} alt="" /></div>
                <div>
                  <div className="cc-company">{COMPANY}</div>
                  <div className="cc-company-line">{COMPANY_LINE}</div>
                </div>
              </div>
              <div className="cc-meta">
                <div>Certificate No. <b>{cc.coc_no}</b></div>
                <div>Date Issued <b>{longDate(cc.date_created)}</b></div>
              </div>
            </div>

            <div className="cc-title">{acceptance ? 'Certificate of Acceptance' : 'Certificate of Completion'}</div>
            <div className="cc-orn"><span /><i /><span /></div>

            <div className="cc-facts">
              {facts.map(([k, v]) => (
                <div key={k}><div className="cc-fact-k">{k}</div><div className="cc-fact-v">{v || ' '}</div></div>
              ))}
            </div>

            <div className="cc-body">
              {acceptance ? (
                <>
                  <p>This is to certify that we received in full and accepted the above Contract Package
                    {cc.contract_package ? <> (<b>{cc.contract_package}</b>)</> : ''} in accordance with the Contract Documents.</p>
                  <p>The date below is hereby established as the Date of Acceptance which is also the Date of Commencement of all
                    warranties and guarantees required under the Contract. The guarantee period after issuance of the Certificate of
                    Acceptance of the Work by the Owner will expire after one (1) year.</p>
                  <p>This certificate does not relieve the Contractor from responsibilities pertaining to the rectification/replacement
                    of any defect on the accepted project as stipulated in the Contract.</p>
                </>
              ) : (
                <>
                  <p>This is to certify that <span className="cc-hi">{CONTRACTOR}</span> has performed and completed the scope of work
                    for <b>{project}</b>{cc.location ? <> at <b>{cc.location}</b></> : ''}, under the above approved Purchase Order No., as
                    required in the contract agreement with <b>{client}</b>{/.$/.test(client) ? '' : '.'}</p>
                  <p>All discrepancies and deficiencies in the accomplishment of the work have been checked, and the necessary adjustments
                    and rectifications have been made accordingly.</p>
                  <p>Nothing contained herein shall be construed as a waiver of the rights of the Owner/Developer, Architects, Design
                    Consultants, and Project and Construction Managers to reject all or any portion of the aforementioned work, should it
                    later be found to have been constructed or implemented in violation of the terms and conditions of the Contract.</p>
                  <p><span className="cc-hi">{CONTRACTOR}</span> further certifies that the said scope of work has been satisfactorily
                    completed in accordance with the approved plans, specifications, and installation standards.</p>
                  <p>This certification is issued for the processing of <b>100% Progress Billing</b>.</p>
                </>
              )}
            </div>

            <div className="cc-signs">
              <Sign label="Submitted By" name={cc.submitted_by_name} title="Contractor" />
              <div>{certifiers.map((p, i) => <div key={p.id} className="cc-stack"><Sign label={i ? '' : 'Certified By'} name={p.name} title={p.job_title} /></div>)}</div>
              <div>{approvers.map((p, i) => <div key={p.id} className="cc-stack"><Sign label={i ? '' : 'Approved By'} name={p.name} title={p.job_title} /></div>)}</div>
              <Sign label={acceptance ? 'Date of Acceptance' : 'Date of Completion'} date />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
