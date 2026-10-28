import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { monthTitle } from './HrDaReport';

// The DA Report as the company's sheet prints it ("DA REPORT FORMAT.xlsx"): one bordered table --
// the title "Discipline Management Report (OCTOBER 2026)" (Times New Roman 13 bold), each section's
// heading (Times 10 bold), the column heads, then the lines (Calibri 11, centred but the name).
// Column widths keep the sheet's own (32 / 54 / 51 / 20). The last section is padded with blank
// rows to the sheet's nine, so a short month still prints as the form.
const MIN_ROWS = 9;

export default function HrDaReportPrint() {
  const [params] = useSearchParams();
  const month = params.get('month');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/hr-da-reports/print', { params: { month } })
      .then(({ data: d }) => setData(d))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the report.'));
  }, [month]);

  if (error) return <div style={{ maxWidth: 620, margin: '80px auto', textAlign: 'center', font: '14px system-ui' }}>{error}</div>;
  if (!data) return <LoadingSpinner />;

  const groups = [];
  for (const r of data.rows) {
    let g = groups.find((x) => x.stage === r.stage);
    if (!g) { g = { stage: r.stage, rows: [] }; groups.push(g); }
    g.rows.push(r);
  }
  if (!groups.length) groups.push({ stage: 'NOTICE TO EXPLAIN', rows: [] });
  const blanks = Math.max(0, MIN_ROWS - data.rows.length);

  return (
    <div className="dap">
      <style>{`
        .dap { background: #f1f5f9; padding: 16px 0 40px; }
        .dap-toolbar { max-width: 215.9mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; }
        .dap-sheet { width: 215.9mm; min-height: 279.4mm; margin: 0 auto; padding: 25.4mm 19mm; background: #fff; color: #000;
          box-sizing: border-box; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
        .dap table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .dap th, .dap td { border: 1px solid #000; padding: 2px 4px; background: none; color: #000; white-space: normal; overflow-wrap: anywhere; }
        .dap .dap-title { font: bold 13pt 'Times New Roman', serif; text-align: center; padding: 3px 4px; }
        .dap .dap-stage, .dap .dap-head { font: bold 10pt 'Times New Roman', serif; text-align: center; text-transform: none; letter-spacing: 0; }
        .dap td.dap-cell { font: 11pt Calibri, 'Segoe UI', sans-serif; text-align: center; vertical-align: middle; height: 36pt; }
        .dap td.dap-name { text-align: left; }
        .dap td.dap-blank { height: 15pt; }
        @media print {
          html, body, #root, .dap { background: #fff !important; }
          .dap { padding: 0; }
          .dap-toolbar { display: none !important; }
          .dap-sheet { box-shadow: none; margin: 0; min-height: 0; }
          @page { size: letter portrait; margin: 0; }
        }
      `}</style>
      <div className="dap-toolbar">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="dap-sheet">
        <table>
          <colgroup>
            <col style={{ width: '20.5%' }} /><col style={{ width: '34.3%' }} /><col style={{ width: '32.5%' }} /><col style={{ width: '12.7%' }} />
          </colgroup>
          <tbody>
            <tr><td colSpan={4} className="dap-title">Discipline Management Report ({monthTitle(month)})</td></tr>
            {groups.map((g, gi) => [
              <tr key={`s${gi}`}><td colSpan={4} className="dap-stage">{g.stage}</td></tr>,
              <tr key={`h${gi}`}>
                <td className="dap-head">EMPLOYEE NAME</td><td className="dap-head">VIOLATION</td>
                <td className="dap-head">SECTION VIOLATED</td><td className="dap-head">FINAL SANCTION</td>
              </tr>,
              ...g.rows.map((r) => (
                <tr key={r.id}>
                  <td className="dap-cell dap-name">{r.employee_name}</td>
                  <td className="dap-cell">{r.violation}</td>
                  <td className="dap-cell">{r.section_violated}</td>
                  <td className="dap-cell">{r.final_sanction}</td>
                </tr>
              )),
              ...(gi === groups.length - 1
                ? Array.from({ length: blanks }, (_, i) => (
                  <tr key={`b${i}`}>{[0, 1, 2, 3].map((c) => <td key={c} className="dap-cell dap-blank" />)}</tr>
                ))
                : []),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}
