import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import PrintLetterhead from '../components/PrintLetterhead';

// PAR -- the PROJECT ACCOMPLISHMENT REPORT, laid out as the source system's own: the customer's
// sign-off that the installation is done. The order's details and this Job Order's Installation
// Scope row are printed; everything else on the page -- installation dates, the installation
// log, the checklist, Prepared By -- is left blank to be filled in by hand on site.
const LOG_ROWS = 7;
const CHECKLIST = [
  'The Physical installation is complete(as indicated in the Job Order and Accomplishment details above)',
  'All signs are lighting properly (if within the scope of the project)',
  'The building or site facade was left in satisfactory condition',
  'The work and/or staging area was left clean and all debris was removed from the work site',
  'Other Comments:',
];

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function JobOrderPar() {
  const { id } = useParams();
  const [jo, setJo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/job-orders/${id}/par`)
      .then(({ data }) => setJo(data))
      .catch((err) => setError(err.response?.data?.error || 'This Job Order could not be loaded.'));
  }, [id]);

  if (error) return <div className="card" style={{ margin: 24, padding: 24 }}>{error}</div>;
  if (!jo) return <LoadingSpinner />;

  return (
    <div className="estimate-print">
      <style>{`
        @page { size: A4 portrait; margin: 12mm; }
        .par { font-size: 11px; color: #222; }
        .par h2 { text-align: center; font-size: 14px; letter-spacing: .3px; margin: 2px 0 14px; color: #444; }
        .par p { margin: 0 0 6px; }
        .par table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 18px; }
        .par th, .par td {
          border: 1px solid #c8c8c8; padding: 5px 5px; text-align: left; font-weight: 400;
          vertical-align: top; white-space: normal; overflow-wrap: anywhere;
        }
        .par .caption td { padding: 6px 5px; }
        .par .head td { width: 25%; }
        .par .log td { height: 22px; }
        .par .check { margin: 0 0 3px; }
        .par .sig { margin-top: 44px; }
        .par .sig div { margin-bottom: 18px; }
        .par .important { margin-top: 20px; font-weight: 600; }
        @media print { .estimate-print .print-sheet { padding: 0; } }
      `}</style>

      <div className="print-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="print-sheet par">
        <PrintLetterhead />
        <h2>PROJECT ACCOMPLISHMENT REPORT</h2>

        <p>
          This is to certify that Cebu Graphicstar Imaging Corporation has completely accomplished the following
          work, as specified below,to be without defects in material, construction or workmanship.
        </p>

        <table className="head">
          <tbody>
            <tr><td>Client Name</td><td colSpan={3}>{jo.customer_name}</td></tr>
            <tr><td>Order ID</td><td colSpan={3}>{jo.order_no}</td></tr>
            <tr><td>Description</td><td colSpan={3}>{jo.contract_description}</td></tr>
            <tr><td>Contact Person</td><td colSpan={3}>{jo.contact_name}</td></tr>
            <tr><td>Installation Start Date</td><td /><td>Installation Complete Date</td><td /></tr>
          </tbody>
        </table>

        <table>
          <colgroup><col style={{ width: '10%' }} /><col style={{ width: '35%' }} /><col style={{ width: '25%' }} /><col style={{ width: '20%' }} /><col style={{ width: '10%' }} /></colgroup>
          <tbody>
            <tr className="caption"><td colSpan={5}>Installation Scope</td></tr>
            <tr><td>JO ID</td><td>Job Description</td><td>Site Location</td><td>Contact Person</td><td>Order Qty</td></tr>
            <tr>
              <td>{jo.job_order_no}</td>
              <td>{jo.description || jo.job_type_name}</td>
              <td>{jo.site_location || ''}</td>
              <td />
              <td>{qty(jo.quantity)}</td>
            </tr>
          </tbody>
        </table>

        <table className="log">
          <colgroup><col style={{ width: '10%' }} /><col style={{ width: '10%' }} /><col style={{ width: '10%' }} /><col style={{ width: '35%' }} /><col style={{ width: '20%' }} /><col style={{ width: '15%' }} /></colgroup>
          <tbody>
            <tr className="caption"><td colSpan={6}>Installation Scope</td></tr>
            <tr>
              <td>Installation Date</td><td>Installed Qty</td><td>Completion Date</td>
              <td style={{ textAlign: 'center' }}>Concerns / Additional Site Works</td>
              <td style={{ textAlign: 'center' }}>Contact Person</td><td style={{ textAlign: 'center' }}>Client Signature</td>
            </tr>
            {Array.from({ length: LOG_ROWS }, (_, i) => (
              <tr key={i}><td /><td /><td /><td /><td /><td /></tr>
            ))}
          </tbody>
        </table>

        {CHECKLIST.map((c) => <div className="check" key={c}>[&nbsp;&nbsp;&nbsp;] {c}</div>)}

        <div className="sig">
          <div>Prepared By : ______________________________</div>
          <div>Date : ___________________________________</div>
        </div>

        <p className="important">
          IMPORTANT: Pls. report any defects or complaints to our Customer Service Representatives at 238-1234 within 7
          working days after project installation completion date as indicated above.Otherwise, a rework fee may be
          charged to your account accordingly.
        </p>
      </div>
    </div>
  );
}
