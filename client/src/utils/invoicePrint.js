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
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: twoDigitYear ? '2-digit' : 'numeric' });
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
