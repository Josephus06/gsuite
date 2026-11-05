import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAuth } from '../../context/useAuth';

// BIR Form No. 2307, January 2018 (ENCS) -- Certificate of Creditable Tax Withheld at Source -- for
// one supplier and one quarter (asked 2026-11-05), opened from BIR Reports > BIR 2307 to Suppliers.
// The sheet copies the official form box for box on A4 so it prints as the certificate itself.
// Above it (not printed) everything on it can be checked and corrected first: the supplier's TIN /
// address as typed in Master Lists, the Payor, and the ATC of each line -- imported bills carry no
// withholding tax, so their ATC is suggested from the rate and must be confirmed here.
// Print needs can_print on /reports/bir-2307, and each print is logged as the 2307 issued.

const money = (v) => (Number(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const mdy = (iso) => (iso ? `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}` : '');

// "407-996-782-00001" -> ['407', '996', '782', '00001']: nine digits and a five-digit branch code.
function tinParts(tin) {
  const d = String(tin || '').replace(/\D/g, '');
  if (!d) return ['', '', '', ''];
  const branch = d.slice(9, 14);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), d.length > 9 ? branch.padStart(5, '0') : '00000'];
}

function Boxes({ value, n }) {
  const chars = String(value || '').padEnd(n, ' ').slice(0, n).split('');
  return <span className="f-boxes">{chars.map((c, i) => <span key={i} className="f-box">{c.trim()}</span>)}</span>;
}
function Tin({ value }) {
  const [a, b, c, d] = tinParts(value);
  return (
    <span className="f-tin">
      <Boxes value={a} n={3} /><span className="f-dash">-</span><Boxes value={b} n={3} /><span className="f-dash">-</span>
      <Boxes value={c} n={3} /><span className="f-dash">-</span><Boxes value={d} n={5} />
    </span>
  );
}
function DateBoxes({ iso }) {
  const v = mdy(iso);
  return <span className="f-tin"><Boxes value={v.slice(0, 2)} n={2} /><Boxes value={v.slice(2, 4)} n={2} /><Boxes value={v.slice(4)} n={4} /></span>;
}

export default function Bir2307Print() {
  const { can } = useAuth();
  const mayPrint = can('/reports/bir-2307', 'can_print');
  const [params] = useSearchParams();
  const quarter = params.get('quarter');
  const payeeKey = params.get('payee');
  const [src, setSrc] = useState(null);
  const [f, setF] = useState(null); // what prints
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    api.get('/reports/bir/2307/form', { params: { quarter, payee: payeeKey } })
      .then(({ data }) => {
        setSrc(data);
        setF({
          from: data.from, to: data.to,
          payee: { ...data.payee, foreign: '' },
          payor: { ...data.payor },
          lines: data.lines.map((l) => ({ ...l })),
        });
        document.title = `BIR 2307 ${data.quarter} - ${data.payee.name}`;
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not load this 2307.'));
  }, [quarter, payeeKey]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t open this 2307</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!f) return <LoadingSpinner />;

  const set = (part, k, v) => setF((x) => ({ ...x, [part]: { ...x[part], [k]: v } }));
  const setLine = (i, patch) => setF((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const pickAtc = (i, atc) => {
    const o = src.atc_options.find((a) => a.atc === atc);
    setLine(i, { atc, nature: o ? o.nature : f.lines[i].nature, suggested: false });
  };
  const totals = src.totals;
  const unconfirmed = f.lines.filter((l) => l.suggested).length;
  const noAtc = f.lines.filter((l) => !l.atc).length;
  const rows = Math.max(10, f.lines.length);
  const p = f.payor;
  const signLine = [p.signatory, p.signatory_title, p.signatory_tin ? `TIN ${p.signatory_tin}` : ''].filter(Boolean).join(' / ');

  async function print() {
    setPrinting(true); setNote('');
    try {
      await api.post('/reports/bir/2307/issued', {
        quarter: src.quarter, payee_key: src.payee_key, supplier_id: src.supplier_id, payee_name: f.payee.name,
        income_total: totals.total, tax_total: totals.tax,
      });
    } catch (e) {
      setNote(e.response?.data?.error || 'Printed, but it could not be recorded as issued.');
    }
    setPrinting(false);
    window.print();
  }

  return (
    <div className="f2307">
      <style>{`
        .f2307 { background: #f1f5f9; padding: 16px 0 40px; }
        .f-panel { max-width: 210mm; margin: 0 auto 14px; background: #fff; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 4px rgba(0,0,0,.15);
          font: 13px/1.5 system-ui, 'Segoe UI', sans-serif; color: #1f2937; }
        .f-panel h3 { margin: 0 0 8px; font-size: 14px; }
        .f-panel .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 12px; }
        .f-panel label { display: block; font-size: 11px; color: #64748b; }
        .f-panel input, .f-panel select { width: 100%; box-sizing: border-box; padding: 4px 6px; font: inherit; border: 1px solid #cbd5e1; border-radius: 4px; }
        .f-panel table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        .f-panel td, .f-panel th { padding: 4px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; font-size: 12px; }
        .f-warn { color: #b45309; }
        .f-bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }

        .f-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 4mm 8mm 3mm; box-sizing: border-box; background: #fff; color: #000;
          font-family: Arial, Helvetica, sans-serif; font-size: 7.5pt; line-height: 1.2; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
        .f-top { display: grid; grid-template-columns: 30mm 1fr 30mm; align-items: center; }
        .f-use { font-size: 6.5pt; border: 0.3mm solid #000; padding: 0.5mm 1mm; width: max-content; background: #d9d9d9; }
        .f-rep { text-align: center; font-weight: 700; font-size: 7.5pt; line-height: 1.25; }
        .f-frame { border: 0.4mm solid #000; }
        .f-head { display: grid; grid-template-columns: 38mm 1fr 44mm; border-bottom: 0.4mm solid #000; }
        .f-head > div { padding: 1mm 2mm; }
        .f-formno { border-right: 0.4mm solid #000; text-align: center; }
        .f-formno .n { font-size: 22pt; font-weight: 800; line-height: 1; }
        .f-title { text-align: center; font-size: 15pt; font-weight: 700; display: flex; align-items: center; justify-content: center; line-height: 1.15; }
        .f-code { border-left: 0.4mm solid #000; display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-end; font-size: 6.5pt; }
        .f-bars { width: 100%; height: 6mm; background: repeating-linear-gradient(90deg, #000 0 0.4mm, #fff 0.4mm 0.9mm, #000 0.9mm 1.6mm, #fff 1.6mm 2.1mm); margin-bottom: 1mm; }
        .f-row { display: flex; align-items: center; gap: 2mm; padding: 0.6mm 2mm; border-bottom: 0.3mm solid #000; }
        .f-row.tall { flex-direction: column; align-items: stretch; gap: 0.4mm; }
        .f-num { font-weight: 700; margin-right: 1mm; }
        .f-hint { font-style: italic; }
        .f-part { text-align: center; font-weight: 700; background: #bfbfbf; border-bottom: 0.3mm solid #000; padding: 0.6mm; }
        .f-line { border: 0.3mm solid #000; min-height: 4mm; padding: 0.6mm 1.5mm; font-size: 8.5pt; font-weight: 700; display: flex; align-items: center; }
        .f-addr { display: grid; grid-template-columns: 1fr 22mm; gap: 2mm; align-items: end; }
        .f-boxes { display: inline-flex; border: 0.3mm solid #000; background: #fff; }
        .f-box { width: 3.4mm; height: 4.2mm; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5pt; font-weight: 700; }
        .f-box + .f-box { border-left: 0.15mm solid #999; }
        .f-tin { display: inline-flex; align-items: center; gap: 1.2mm; }
        .f-dash { font-weight: 700; background: #bfbfbf; padding: 0 0.6mm; }
        /* The app's global table rules (index.css: th, td { white-space: nowrap; padding: 9px 12px; ... },
           tbody tr:hover) would run the long BIR labels across the columns -- every one restated here. */
        .f-t { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.5pt; color: #000; }
        .f-t th, .f-t td { border: 0.3mm solid #000; padding: 0.2mm 1mm; white-space: normal; overflow-wrap: break-word;
          text-align: left; vertical-align: middle; line-height: 1.15; color: #000; background: #fff; }
        .f-t tbody tr:hover { background: none; }
        .f-t th { font-weight: 700; text-align: center; background: #d9d9d9; font-size: 7pt; }
        .f-t td { height: 3.1mm; font-size: 7.5pt; }
        .f-t td.amt { text-align: right; font-weight: 700; white-space: nowrap; }
        .f-t td.nat { font-size: 5.6pt; line-height: 1.1; }
        .f-t td.atc { text-align: center; font-weight: 700; }
        .f-t tr.tot td { font-weight: 700; background: #d9d9d9; }
        .f-t tr.sec td { font-weight: 700; background: #d9d9d9; font-size: 7pt; }
        .f-t .shade { background: #d9d9d9; }
        .f-decl { padding: 0.8mm 2mm; text-align: justify; font-size: 6.5pt; border-bottom: 0.3mm solid #000; }
        .f-sign { height: 6.5mm; display: flex; align-items: flex-end; justify-content: center; font-weight: 700; font-size: 8.5pt; padding-bottom: 0.5mm; }
        .f-signlbl { text-align: center; background: #d9d9d9; border-top: 0.3mm solid #000; border-bottom: 0.3mm solid #000; padding: 0.5mm; font-size: 7pt; }
        .f-agent { display: grid; grid-template-columns: 36mm 1fr auto auto auto auto; gap: 2mm; align-items: center; padding: 0.5mm 2mm; font-size: 6.5pt; border-bottom: 0.3mm solid #000; }
        .f-agent .blank { border: 0.3mm solid #000; height: 4.2mm; }
        .f-conf { text-align: center; font-weight: 700; background: #bfbfbf; border-bottom: 0.3mm solid #000; padding: 0.5mm; }
        .f-note { font-size: 6.5pt; margin-top: 1mm; }
        @media print {
          html, body, #root, .f2307 { background: #fff !important; }
          .f2307 { padding: 0; }
          .f-no-print { display: none !important; }
          .f-sheet { box-shadow: none; margin: 0; min-height: 0; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      <div className="f-panel f-no-print">
        <div className="f-bar">
          <div>
            <strong>BIR 2307 · {src.label}</strong> — {f.payee.name}
            <div style={{ fontSize: 12, color: '#64748b' }}>Check the details below. Changes here apply to this printout only.</div>
          </div>
          {mayPrint
            ? <button className="btn btn-primary" disabled={printing} onClick={print}>{printing ? 'Recording…' : 'Print 2307'}</button>
            : <span className="f-warn">You can view this 2307 but not print it.</span>}
        </div>
        {note && <div className="f-warn" style={{ marginTop: 6 }}>{note}</div>}
        {(unconfirmed > 0 || noAtc > 0 || !f.payee.tin || !p.tin || !p.name) && (
          <ul className="f-warn" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {unconfirmed > 0 && <li>{unconfirmed} line{unconfirmed === 1 ? '' : 's'} with an ATC suggested from the withholding rate. Confirm or change it below.</li>}
            {noAtc > 0 && <li>{noAtc} line{noAtc === 1 ? '' : 's'} with no ATC. Choose one below.</li>}
            {!f.payee.tin && <li>The supplier has no TIN in Master Lists. Type it below, and add it to the supplier.</li>}
            {(!p.tin || !p.name) && <li>The Payor details are not set. Fill them in on BIR 2307 to Suppliers (Edit), or type them below.</li>}
          </ul>
        )}

        <h3 style={{ marginTop: 12 }}>Part I – Payee</h3>
        <div className="grid">
          <div><label>TIN</label><input value={f.payee.tin} onChange={(e) => set('payee', 'tin', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><label>Payee&rsquo;s name</label><input value={f.payee.name} onChange={(e) => set('payee', 'name', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Registered address</label><input value={f.payee.address} onChange={(e) => set('payee', 'address', e.target.value)} /></div>
          <div><label>ZIP code</label><input value={f.payee.zip} onChange={(e) => set('payee', 'zip', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><label>Foreign address, if applicable</label><input value={f.payee.foreign} onChange={(e) => set('payee', 'foreign', e.target.value)} /></div>
        </div>

        <h3 style={{ marginTop: 12 }}>Part II – Payor</h3>
        <div className="grid">
          <div><label>TIN</label><input value={p.tin} onChange={(e) => set('payor', 'tin', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><label>Payor&rsquo;s name</label><input value={p.name} onChange={(e) => set('payor', 'name', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Registered address</label><input value={p.address} onChange={(e) => set('payor', 'address', e.target.value)} /></div>
          <div><label>ZIP code</label><input value={p.zip} onChange={(e) => set('payor', 'zip', e.target.value)} /></div>
          <div><label>Signatory</label><input value={p.signatory} onChange={(e) => set('payor', 'signatory', e.target.value)} /></div>
          <div><label>Title</label><input value={p.signatory_title} onChange={(e) => set('payor', 'signatory_title', e.target.value)} /></div>
          <div><label>Signatory TIN</label><input value={p.signatory_tin} onChange={(e) => set('payor', 'signatory_tin', e.target.value)} /></div>
        </div>

        <h3 style={{ marginTop: 12 }}>Part III – ATC per line</h3>
        <table>
          <thead><tr><th style={{ width: 170 }}>ATC</th><th>Nature of income payment</th><th style={{ textAlign: 'right' }}>Income</th><th style={{ textAlign: 'right' }}>Tax</th></tr></thead>
          <tbody>
            {f.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select value={l.atc} onChange={(e) => pickAtc(i, e.target.value)}>
                    <option value="">— choose —</option>
                    {src.atc_options.map((o) => <option key={o.id} value={o.atc}>{o.atc} · {o.rate}%</option>)}
                    {l.atc && !src.atc_options.some((o) => o.atc === l.atc) && <option value={l.atc}>{l.atc}</option>}
                  </select>
                  <div style={{ fontSize: 11, color: '#64748b' }}>
                    Withheld at {l.rate != null ? `${Number(l.rate)}%` : '?'}{l.suggested && <span className="f-warn"> · suggested</span>}
                  </div>
                </td>
                <td><input value={l.nature} onChange={(e) => setLine(i, { nature: e.target.value })} /></td>
                <td style={{ textAlign: 'right' }}>{money(l.total)}</td>
                <td style={{ textAlign: 'right' }}>{money(l.tax)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer' }}>Source documents ({src.docs.length})</summary>
          <table>
            <thead><tr><th>Document</th><th>Date</th><th>ATC</th><th style={{ textAlign: 'right' }}>Tax base</th><th style={{ textAlign: 'right' }}>Withheld</th></tr></thead>
            <tbody>
              {src.docs.map((d) => (
                <tr key={`${d.doc_type}-${d.id}`}>
                  <td>{d.doc_type} {d.doc_no}{d.reference_no ? ` · ${d.reference_no}` : ''}</td>
                  <td>{d.date_created}</td>
                  <td>{d.atc || '—'}{d.atc_suggested ? ' (suggested)' : ''}</td>
                  <td style={{ textAlign: 'right' }}>{money(d.tax_base)}</td>
                  <td style={{ textAlign: 'right' }}>{money(d.wtax_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <div className="f-sheet">
        <div className="f-top">
          <div className="f-use">For BIR&nbsp;&nbsp;BCS/<br />Use Only&nbsp;Item:</div>
          <div className="f-rep">Republic of the Philippines<br />Department of Finance<br />Bureau of Internal Revenue</div>
          <div />
        </div>
        <div className="f-frame" style={{ marginTop: 1.5 + 'mm' }}>
          <div className="f-head">
            <div className="f-formno">BIR Form No.<div className="n">2307</div>January 2018 (ENCS)</div>
            <div className="f-title">Certificate of Creditable Tax<br />Withheld at Source</div>
            <div className="f-code"><div className="f-bars" />2307 01/18ENCS</div>
          </div>
          <div className="f-row" style={{ fontSize: '6.5pt', padding: '0.4mm 2mm' }}>Fill in all applicable spaces. Mark all appropriate boxes with an &ldquo;X&rdquo;.</div>
          <div className="f-row">
            <span><span className="f-num">1</span>For the Period</span>
            <span style={{ marginLeft: '10mm' }}>From</span> <DateBoxes iso={f.from} /> <span className="f-hint">(MM/DD/YYYY)</span>
            <span style={{ marginLeft: '12mm' }}>To</span> <DateBoxes iso={f.to} /> <span className="f-hint">(MM/DD/YYYY)</span>
          </div>

          <div className="f-part">Part I – Payee Information</div>
          <div className="f-row"><span style={{ width: '62mm' }}><span className="f-num">2</span>Taxpayer Identification Number <span className="f-hint">(TIN)</span></span><Tin value={f.payee.tin} /></div>
          <div className="f-row tall">
            <span><span className="f-num">3</span>Payee&rsquo;s Name <span className="f-hint">(Last Name, First Name, Middle Name for Individual OR Registered Name for Non-Individual)</span></span>
            <div className="f-line">{f.payee.name}</div>
          </div>
          <div className="f-row tall">
            <div className="f-addr"><span><span className="f-num">4</span>Registered Address</span><span><span className="f-num">4A</span>ZIP Code</span></div>
            <div className="f-addr"><div className="f-line">{f.payee.address}</div><Boxes value={f.payee.zip} n={4} /></div>
          </div>
          <div className="f-row tall">
            <span><span className="f-num">5</span>Foreign Address, <span className="f-hint">if applicable</span></span>
            <div className="f-line">{f.payee.foreign}</div>
          </div>

          <div className="f-part">Part II – Payor Information</div>
          <div className="f-row"><span style={{ width: '62mm' }}><span className="f-num">6</span>Taxpayer Identification Number <span className="f-hint">(TIN)</span></span><Tin value={p.tin} /></div>
          <div className="f-row tall">
            <span><span className="f-num">7</span>Payor&rsquo;s Name <span className="f-hint">(Last Name, First Name, Middle Name for Individual OR Registered Name for Non-Individual)</span></span>
            <div className="f-line">{p.name}</div>
          </div>
          <div className="f-row tall">
            <div className="f-addr"><span><span className="f-num">8</span>Registered Address</span><span><span className="f-num">8A</span>ZIP Code</span></div>
            <div className="f-addr"><div className="f-line">{p.address}</div><Boxes value={p.zip} n={4} /></div>
          </div>

          <div className="f-part" style={{ borderBottom: 0 }}>Part III – Details of Monthly Income Payments and Taxes Withheld</div>
          <table className="f-t">
            <colgroup><col style={{ width: '25%' }} /><col style={{ width: '9%' }} /><col style={{ width: '12%' }} /><col style={{ width: '12%' }} /><col style={{ width: '12%' }} /><col style={{ width: '14%' }} /><col style={{ width: '16%' }} /></colgroup>
            <thead>
              <tr><th rowSpan={2}>Income Payments Subject to Expanded Withholding Tax</th><th rowSpan={2}>ATC</th><th colSpan={4}>AMOUNT OF INCOME PAYMENTS</th><th rowSpan={2}>Tax Withheld for the Quarter</th></tr>
              <tr><th>1st Month of the Quarter</th><th>2nd Month of the Quarter</th><th>3rd Month of the Quarter</th><th>Total</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => {
                const l = f.lines[i];
                return (
                  <tr key={i}>
                    <td className="nat">{l ? l.nature : ''}</td>
                    <td className="atc">{l ? l.atc : ''}</td>
                    <td className="amt">{l ? money(l.months[0]) : ''}</td>
                    <td className="amt">{l ? money(l.months[1]) : ''}</td>
                    <td className="amt">{l ? money(l.months[2]) : ''}</td>
                    <td className="amt">{l ? money(l.total) : ''}</td>
                    <td className="amt">{l ? money(l.tax) : ''}</td>
                  </tr>
                );
              })}
              <tr className="tot">
                <td>Total</td><td />
                <td className="amt">{money(totals.months[0])}</td><td className="amt">{money(totals.months[1])}</td>
                <td className="amt">{money(totals.months[2])}</td><td className="amt">{money(totals.total)}</td><td className="amt">{money(totals.tax)}</td>
              </tr>
              <tr className="sec"><td>Money Payments Subject to Withholding of Business Tax (Government &amp; Private)</td><td colSpan={6} className="shade" /></tr>
              {Array.from({ length: Math.max(3, 10 - Math.max(0, f.lines.length - 10)) }, (_, i) => <tr key={`b${i}`}><td /><td /><td /><td /><td /><td /><td /></tr>)}
              <tr className="tot"><td>Total</td><td /><td /><td /><td /><td /><td /></tr>
            </tbody>
          </table>

          <div className="f-decl">
            We declare under the penalties of perjury that this certificate has been made in good faith, verified by us, and to the best of our knowledge and belief, is true and
            correct, pursuant to the provisions of the National Internal Revenue Code, as amended, and the regulations issued under authority thereof. Further, we give our consent to
            the processing of our information as contemplated under the *Data Privacy Act of 2012 (R.A. No. 10173) for legitimate and lawful purposes.
          </div>
          <div className="f-sign">{signLine}</div>
          <div className="f-signlbl">Signature over Printed Name of Payor/Payor&rsquo;s Authorized Representative/Tax Agent<br /><span className="f-hint">(Indicate Title/Designation and TIN)</span></div>
          <div className="f-agent">
            <span>Tax Agent Accreditation No./ Attorney&rsquo;s Roll No. (if applicable)</span><div className="blank" />
            <span>Date of Issue<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso="" />
            <span>Date of Expiry<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso="" />
          </div>
          <div className="f-conf">CONFORME:</div>
          <div className="f-sign" />
          <div className="f-signlbl">Signature over Printed Name of Payee/Payee&rsquo;s Authorized Representative/Tax Agent<br /><span className="f-hint">(Indicate Title/Designation and TIN)</span></div>
          <div className="f-agent" style={{ borderBottom: 0 }}>
            <span>Tax Agent Accreditation No./ Attorney&rsquo;s Roll No. (if applicable)</span><div className="blank" />
            <span>Date of Issue<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso="" />
            <span>Date of Expiry<br /><span className="f-hint">(MM/DD/YYYY)</span></span><DateBoxes iso="" />
          </div>
        </div>
        <div className="f-note">*NOTE: The BIR Data Privacy is in the BIR website (www.bir.gov.ph)</div>
      </div>
    </div>
  );
}
