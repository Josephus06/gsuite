import { displayDate } from './dates';
// Shared by both invoice print formats (Type 1 pre-printed overlay, Type 2 full form).

export const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};

// Quantities print as whole numbers when they are whole -- the forms' qty blanks are narrow,
// and "12" is what the live statement shows, not "12.0000".
export const qtyText = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
};

export const formatDate = (v, twoDigitYear = false) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return displayDate(d);
};

// Tax codes in this data are 'VAT_PH:VATIN-12' | 'VAT_PH:ZRATE' | 'VAT_PH:0-VAT' |
// 'VAT_PH:EXEMPT' (and a few unprefixed variants), which map onto the BIR sales buckets
// the pre-printed form prints labels for.
export function taxBucket(line) {
  const code = (line.tax_code || '').toUpperCase();
  if (code.includes('EXEMPT')) return 'exempt';
  if (code.includes('ZRATE') || code.includes('0-VAT')) return 'zeroRated';
  if (Number(line.tax_amount) > 0 || code.includes('VATIN') || code.includes('VAT12')) return 'vatable';
  return 'exempt'; // no tax code and no tax charged -- not VATable, so it cannot sit in that box
}

export function invoiceTotals(si) {
  if (!si) return null;
  const buckets = { vatable: 0, exempt: 0, zeroRated: 0 };
  for (const l of si.lines || []) buckets[taxBucket(l)] += Number(l.net_of_tax || 0);
  return {
    ...buckets,
    vat: Number(si.tax_amount || 0),
    totalSales: Number(si.gross_amount || 0),
    withholding: Number(si.ewt_amount || 0),
    quantity: (si.lines || []).reduce((s, l) => s + Number(l.quantity || 0), 0),
    // amount_due is drawn down by payments and credit memos, so a settled invoice would
    // print 0.00. What the form asks for is what this document billed, so derive it.
    amountDue: Number(si.gross_amount || 0) - Number(si.ewt_amount || 0),
  };
}

// All figures in this database are Philippine peso. The sample Type 2 template was an export
// invoice denominated in US$ -- change this if that format is used for dollar billing.
export const CURRENCY = { code: 'PHP', symbol: '₱' };

export const paginate = (lines, perPage) => {
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages;
};

// DESCRIPTIONS THAT DO NOT FIT ON ONE LINE.
//
// The description blank is 95mm wide and every field here was nowrap + overflow:hidden, so
// anything past about 56 characters at 8pt was cut off with nothing on the paper to show it --
// 25,926 of the 121,012 invoice lines in this database, a fifth of them, and the longest runs to
// 347 characters. A printed invoice that silently drops what was sold is the worst kind of wrong.
//
// It wraps instead, and a long description uses the empty rows beneath it. That space is nearly
// always there: 56,883 of the invoices carry a SINGLE line item against six row slots, and 7,911
// carry two. An item consumes as many whole 5mm rows as its wrapped text needs, and the next item
// starts on the next ruled line after it, so every item's Qty/Unit Price/Amount still land on a
// rule of the pre-printed form.
//
// Courier advances every glyph by exactly 0.6em, so the character capacity of a millimetre width
// is arithmetic rather than measurement -- the break points are identical on screen and on paper,
// which is what a pre-printed overlay needs. Wrapping is done here rather than left to CSS for
// the same reason: the browser's line breaking is not something a calibration can be measured
// against.
const PT_TO_MM = 25.4 / 72;
const charWidthMm = (pt) => 0.6 * pt * PT_TO_MM;
const lineHeightMm = (pt) => pt * PT_TO_MM * 1.15; // 1.15 = .si-form's line-height

export function wrapMono(text, widthMm, pt) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const perLine = Math.max(1, Math.floor(widthMm / charWidthMm(pt)));
  const out = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    // A single word longer than the blank -- a part code, a URL -- is broken hard rather than
    // allowed to overrun the column into Unit Price.
    if (word.length > perLine) {
      if (line) { out.push(line); line = ''; }
      for (let i = 0; i < word.length; i += perLine) out.push(word.slice(i, i + perLine));
      line = out.pop() ?? '';
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

// One page's worth of items, each with its wrapped description and the row it starts on.
// Replaces a fixed six-items-per-page split: pages are now filled by ROWS, because an item is no
// longer always one row tall.
export function layoutPages(lines, form) {
  const { rowHeight, rowsPerPage, columns } = form.items;
  const lh = lineHeightMm(form.baseFontPt);
  const rowsForLines = (n) => Math.max(1, Math.ceil((n * lh) / rowHeight));
  // The most one item can take is the whole band; past that there is nowhere left to put it.
  const maxLines = Math.floor((rowsPerPage * rowHeight) / lh);

  const items = (lines || []).map((l) => {
    let wrapped = wrapMono(l.description, columns.description.w, form.baseFontPt);
    if (wrapped.length > maxLines) {
      // Visibly cut, never silently: the ellipsis is the whole point, so whoever reads the
      // invoice knows to look at the system for the rest.
      wrapped = wrapped.slice(0, maxLines);
      wrapped[maxLines - 1] = `${wrapped[maxLines - 1].slice(0, Math.max(0, wrapped[maxLines - 1].length - 1))}…`;
    }
    return { line: l, wrapped, rows: rowsForLines(wrapped.length) };
  });

  const pages = [[]];
  let used = 0;
  for (const item of items) {
    if (used + item.rows > rowsPerPage && pages[pages.length - 1].length) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push({ ...item, rowOffset: used });
    used += item.rows;
  }
  // Rows consumed on the final page, so the Order ID line below the items knows where to sit.
  pages.usedOnLastPage = used;
  return pages;
}
