// A source Customer Payment list row's header details, in this system's terms. Shared by the
// payment importers and backfill-customer-payment-header.js so they can never disagree.
//
// Receipt: the source's OrderConfirmation_TransH is CR / OR / PR. A PR (Provisional Receipt)
// carries its number in PONo_TransH and leaves ORNo_TransH blank -- that is why the source list
// has separate OR/CR and PR columns. Here both live in or_no, told apart by receipt_type.
//
// Prepared By / Issued By are source user NAMES ("Cindy Marie Deniay_AYALA"), not T1S logins, so
// they are kept as text (prepared_by_name / issued_by_name) rather than guessed onto a user id.
const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());

const RECEIPT_TYPES = { CR: 'Collection Receipt', OR: 'Official Receipt', PR: 'Provisional Receipt' };
const PAYMENT_TYPES = {
  full: 'Full Payment', partial: 'Partial Payment', downpayment: 'Down Payment', 'down payment': 'Down Payment',
  balance: 'Balance Payment',
};

function sourcePaymentHeader(p) {
  const receiptCode = clean(p.OrderConfirmation_TransH).toUpperCase();
  const receiptType = RECEIPT_TYPES[receiptCode] || null;
  const number = receiptCode === 'PR' ? clean(p.PONo_TransH) || clean(p.ORNo_TransH) : clean(p.ORNo_TransH);
  const type = clean(p.Type_TransH);
  return {
    receipt_type: receiptType,
    or_no: number.slice(0, 50) || null,
    payment_type: PAYMENT_TYPES[type.toLowerCase()] || type || null,
    reference_no: clean(p.ReferrenceNO_TransH).slice(0, 100) || null,
    prepared_by_name: clean(p.PreparedBy_TransH).slice(0, 150) || null,
    issued_by_name: clean(p.IssuedBy_TransH).slice(0, 150) || null,
  };
}

module.exports = { sourcePaymentHeader, RECEIPT_TYPES, PAYMENT_TYPES };
