// Renders an estimate as an email a customer can actually read.
//
// SENT AS HTML IN THE BODY, NOT AS A PDF ATTACHMENT. The obvious idea is to attach the same
// document the Print button produces, but that print view is rendered by the browser from the
// React app -- reproducing it server-side would mean running a headless browser on the API host,
// and the cloud container has no browser binaries installed. An HTML body needs nothing beyond
// what already exists, renders on a phone, and does not sit unopened as an attachment. If a PDF
// is wanted later, this is the function that would gain one.
//
// STYLES ARE INLINE ON PURPOSE. Gmail and Outlook strip <style> blocks; a stylesheet would render
// as an unstyled wall of text for most recipients. The same goes for the table layout, which is
// the only thing that lays out reliably across mail clients.

const peso = (n) => `PHP ${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? String(d).slice(0, 10) : '');

// Every value a customer sees goes through this. The figures are ours, but the names, memos and
// descriptions came from a form somebody typed into -- an unescaped apostrophe or angle bracket
// would break the layout at best, and inject markup into the mail at worst.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const TD = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;';
const TH = 'padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:12px;text-align:left;'
  + 'text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;';

// The customer is being asked to approve a price for work described in their own terms. They are
// shown the job lines and what each costs -- deliberately NOT the process and material breakdown
// underneath, which is our costing, carries our margin, and is nobody else's business.
function jobRows(jobOrders) {
  if (!jobOrders?.length) return `<tr><td style="${TD}" colspan="5">No job lines on this estimate.</td></tr>`;
  return jobOrders.map((jo, i) => `
    <tr>
      <td style="${TD}">${i + 1}</td>
      <td style="${TD}">${esc(jo.description || jo.job_type || '')}</td>
      <td style="${TD};text-align:right">${esc(jo.quantity ?? '')}</td>
      <td style="${TD}">${esc(jo.units || '')}</td>
      <td style="${TD};text-align:right">${peso(jo.gross_amount ?? jo.subtotal)}</td>
    </tr>`).join('');
}

function row(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr><td style="padding:2px 0;color:#6b7280;font-size:13px;">${esc(label)}</td>
    <td style="padding:2px 0 2px 14px;font-size:13px;"><strong>${esc(value)}</strong></td></tr>`;
}

function buildHtml(est, jobOrders, { companyName, senderName, senderEmail, note }) {
  const totals = [
    ['Subtotal', est.subtotal],
    ['Discount', est.discount_total],
    ['Net of Tax', est.net_of_tax],
    ['Tax', est.tax_total],
  ].filter(([, v]) => v !== null && v !== undefined && Number(v) !== 0);

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;max-width:720px;margin:0 auto;padding:8px;">
  <div style="background:#1e3a8a;color:#fff;padding:18px 20px;border-radius:8px 8px 0 0;">
    <div style="font-size:18px;font-weight:700;">${esc(companyName)}</div>
    <div style="font-size:22px;font-weight:700;margin-top:6px;">Estimate ${esc(est.estimate_no || '')}</div>
    <div style="opacity:0.85;font-size:13px;margin-top:2px;">Dated ${esc(day(est.date_created))}</div>
  </div>

  <div style="border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px;padding:20px;">
    <p style="font-size:14px;margin:0 0 14px;">
      Good day${est.contact_person_name ? ` ${esc(est.contact_person_name)}` : ''},
    </p>
    <p style="font-size:14px;margin:0 0 16px;">
      Please find below our estimate for your requirement. Kindly review it and let us know if you
      would like to proceed, or if anything needs adjusting.
    </p>

    ${note ? `<div style="background:#f3f4f6;border-left:3px solid #1e3a8a;padding:10px 14px;margin:0 0 18px;font-size:13px;white-space:pre-wrap;">${esc(note)}</div>` : ''}

    <table style="width:100%;border-collapse:collapse;margin:0 0 18px;">
      <tbody>
        ${row('Customer', est.customer_name)}
        ${row('Contact', est.contact_person_name)}
        ${row('Sales Rep.', est.sales_rep_name)}
        ${row('Credit Term', est.credit_term)}
        ${row('Production Lead Time', est.production_lead_time)}
        ${row('Price Validity', est.price_validity)}
      </tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin:0 0 6px;">
      <thead><tr>
        <th style="${TH}">#</th><th style="${TH}">Description</th>
        <th style="${TH};text-align:right">Qty</th><th style="${TH}">Unit</th>
        <th style="${TH};text-align:right">Amount</th>
      </tr></thead>
      <tbody>${jobRows(jobOrders)}</tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin:10px 0 0;">
      <tbody>
        ${totals.map(([l, v]) => `<tr>
          <td style="padding:3px 10px;text-align:right;font-size:13px;color:#6b7280;">${esc(l)}</td>
          <td style="padding:3px 10px;text-align:right;font-size:13px;width:150px;">${peso(v)}</td></tr>`).join('')}
        <tr>
          <td style="padding:9px 10px;text-align:right;font-weight:700;font-size:15px;border-top:2px solid #d1d5db;">Total</td>
          <td style="padding:9px 10px;text-align:right;font-weight:700;font-size:15px;border-top:2px solid #d1d5db;">${peso(est.total_amount)}</td>
        </tr>
      </tbody>
    </table>

    <p style="font-size:13px;color:#4b5563;margin:22px 0 0;">
      To accept this estimate, simply reply to this email${senderName ? ` and ${esc(senderName)} will pick it up` : ''}.
    </p>
    <p style="font-size:13px;margin:14px 0 0;">
      ${senderName ? `<strong>${esc(senderName)}</strong><br>` : ''}
      ${senderEmail ? `<a href="mailto:${esc(senderEmail)}" style="color:#1e3a8a;">${esc(senderEmail)}</a><br>` : ''}
      ${esc(companyName)}
    </p>
  </div>
</div>`;
}

// The plain-text alternative. Not decoration: a message sent as HTML alone is markedly more
// likely to be filed as junk, and some clients still show this instead.
function buildText(est, jobOrders, { companyName, senderName, note }) {
  const lines = [
    `${companyName}`,
    `Estimate ${est.estimate_no || ''} -- ${day(est.date_created)}`,
    '',
    `Good day${est.contact_person_name ? ` ${est.contact_person_name}` : ''},`,
    '',
    'Please find our estimate below. Kindly review it and let us know if you would like to proceed.',
    '',
  ];
  if (note) lines.push(note, '');
  for (const [i, jo] of (jobOrders || []).entries()) {
    lines.push(`${i + 1}. ${jo.description || jo.job_type || ''} -- ${jo.quantity ?? ''} ${jo.units || ''} -- ${peso(jo.gross_amount ?? jo.subtotal)}`);
  }
  lines.push('', `TOTAL: ${peso(est.total_amount)}`, '');
  lines.push('To accept this estimate, simply reply to this email.');
  if (senderName) lines.push('', senderName);
  lines.push(companyName);
  return lines.join('\n');
}

function buildEstimateEmail(est, jobOrders, opts) {
  const o = { companyName: 'Cebu Graphicstar Imaging Corp.', ...opts };
  return {
    subject: `Estimate ${est.estimate_no || ''} from ${o.companyName}`.trim(),
    html: buildHtml(est, jobOrders, o),
    text: buildText(est, jobOrders, o),
  };
}

module.exports = { buildEstimateEmail };
