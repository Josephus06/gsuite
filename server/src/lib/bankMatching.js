// Matching a bank statement to the documents that produced it.
//
// The system PROPOSES; a person CONFIRMS. Nothing here writes a confirmed match -- every match it
// makes lands as "awaiting review" with a confidence saying how it was arrived at, and a
// reconciliation cannot be finished while any proposal is still unreviewed. An auto-matcher that
// quietly decided what cleared would be worse than no auto-matcher at all: it would produce a
// reconciliation that balances and means nothing.
//
// THREE PASSES, strongest first, each claiming what it is sure of before the next runs. Order is
// the whole algorithm -- a weak amount-only guess must never take a document that a later line
// could have claimed by its cheque number.
//
//   1. exact   the statement line quotes the document's reference (cheque number) AND the amount
//              agrees. A cheque number is unique enough that this is not really a guess.
//   2. strong  amount and direction agree, inside the date window, and exactly ONE document is a
//              candidate. Nothing else it could be.
//   3. weak    amount agrees but several documents could be it. The nearest by date is proposed
//              and flagged weak, because on these statements several cheques a week share a round
//              amount and only a person can say which one the bank took.
//
// Everything left over stays unmatched: statement lines with nothing to match (bank charges,
// interest, a document never entered) and documents the statement does not show (outstanding
// cheques, deposits in transit) -- which is exactly the information a reconciliation exists to
// produce.

// How far apart a statement line and a document may be and still be the same event. A cheque
// clears days after it is handed over, and a deposit posts a day or two after it is made; beyond
// a fortnight the amount agreeing is a coincidence rather than evidence.
const DATE_WINDOW_DAYS = 14;

// Amounts are compared in CENTAVOS as integers. Comparing two DECIMAL(15,2) values through JS
// floats is how 4406.43 fails to equal 4406.43.
const cents = (v) => Math.round(Number(v || 0) * 100);

const daysApart = (a, b) => {
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  const ms = Math.abs(new Date(String(a).slice(0, 10)) - new Date(String(b).slice(0, 10)));
  return Math.round(ms / 86400000);
};

// Digit runs of 4 or more from a statement line's reference and description. Banks write the
// cheque number in whichever of the two they feel like, padded, prefixed, or buried in a sentence
// -- so pull every plausible number out and see whether one of them IS the document's reference.
function referenceCandidates(line) {
  const text = `${line.reference || ''} ${line.description || ''}`;
  return new Set((text.match(/\d{4,}/g) || []).map((s) => s.replace(/^0+/, '') || '0'));
}

const normalisedRef = (movement) => {
  const raw = String(movement.reference || '').trim();
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
};

// statementLines and movements are plain rows; nothing is written here. Returns the proposals and
// what was left over on both sides.
function proposeMatches(statementLines, movements, { windowDays = DATE_WINDOW_DAYS } = {}) {
  const takenMovements = new Set();
  const takenLines = new Set();
  const proposals = [];

  // Index the book side by amount, so each pass is a lookup rather than a scan of 16,000 rows per
  // statement line.
  const byAmount = new Map();
  for (const m of movements) {
    const key = cents(m.amount);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(m);
  }

  const available = (key) => (byAmount.get(key) || []).filter((m) => !takenMovements.has(`${m.source_kind}:${m.source_id}`));

  const claim = (line, m, confidence) => {
    takenMovements.add(`${m.source_kind}:${m.source_id}`);
    takenLines.add(line.id);
    proposals.push({
      statement_line_id: line.id,
      source_kind: m.source_kind,
      source_id: m.source_id,
      amount: m.amount,
      confidence,
    });
  };

  // Pass 1 -- the statement quotes the cheque number.
  for (const line of statementLines) {
    if (takenLines.has(line.id)) continue;
    const refs = referenceCandidates(line);
    if (!refs.size) continue;
    const candidates = available(cents(line.amount));
    const hit = candidates.find((m) => {
      const ref = normalisedRef(m);
      return ref && refs.has(ref);
    });
    if (hit) claim(line, hit, 'exact');
  }

  // Passes 2 and 3 take the MOST CONSTRAINED LINE FIRST -- the one with fewest candidates left.
  //
  // Without that, plain top-to-bottom order loses matches it had no need to lose: two statement
  // lines of the same amount days apart, the first takes whichever document it likes, and the
  // second is left with none in its window and reported unmatched even though its own document was
  // sitting there. Measured on a statement built from real July documents, that cost one match in
  // sixty. A line with one possible document must be allowed to take it before a line with five
  // does. Recomputed each round because every claim changes what is left.
  const remaining = () => statementLines.filter((l) => !takenLines.has(l.id));
  const candidatesFor = (line) => available(cents(line.amount))
    .filter((m) => daysApart(m.txn_date, line.txn_date) <= windowDays)
    .sort((a, b) => daysApart(a.txn_date, line.txn_date) - daysApart(b.txn_date, line.txn_date));

  // Pass 2 -- nothing else it could be.
  for (;;) {
    const next = remaining()
      .map((line) => ({ line, candidates: candidatesFor(line) }))
      .find((x) => x.candidates.length === 1);
    if (!next) break;
    claim(next.line, next.candidates[0], 'strong');
  }

  // Pass 3 -- several candidates; propose the nearest by date and say it is a guess. Fewest
  // candidates first again, so the tightest choices are made while the most is still available.
  for (;;) {
    const options = remaining()
      .map((line) => ({ line, candidates: candidatesFor(line) }))
      .filter((x) => x.candidates.length > 0)
      .sort((a, b) => a.candidates.length - b.candidates.length);
    if (!options.length) break;
    // A single candidate can reappear here as earlier claims free nothing but narrow others.
    claim(options[0].line, options[0].candidates[0], options[0].candidates.length === 1 ? 'strong' : 'weak');
  }

  return {
    proposals,
    unmatchedLines: statementLines.filter((l) => !takenLines.has(l.id)),
    unmatchedMovements: movements.filter((m) => !takenMovements.has(`${m.source_kind}:${m.source_id}`)),
  };
}

// What the reconciliation adds up to, given what has been CONFIRMED.
//
//   statement balance                        what the bank says
//   less deposits the bank has not shown     money in, in transit
//   add back cheques the bank has not paid   money out, still outstanding
//   = adjusted bank balance, which must equal the balance per book
//
// Written out rather than collapsed into one expression because this is the arithmetic somebody
// will check by hand against the printed statement.
function reconciliationSummary({ statementBalance, bookBalance, outstanding }) {
  const depositsInTransit = outstanding
    .filter((m) => Number(m.amount) > 0)
    .reduce((s, m) => s + Number(m.amount), 0);
  const outstandingPayments = outstanding
    .filter((m) => Number(m.amount) < 0)
    .reduce((s, m) => s + Number(m.amount), 0); // negative

  const adjustedBank = Number(statementBalance) + depositsInTransit + outstandingPayments;
  const difference = Number((adjustedBank - Number(bookBalance)).toFixed(2));

  return {
    statement_balance: Number(Number(statementBalance).toFixed(2)),
    deposits_in_transit: Number(depositsInTransit.toFixed(2)),
    outstanding_payments: Number(Math.abs(outstandingPayments).toFixed(2)),
    adjusted_bank_balance: Number(adjustedBank.toFixed(2)),
    book_balance: Number(Number(bookBalance).toFixed(2)),
    difference,
    balanced: Math.abs(difference) < 0.005,
  };
}

module.exports = { DATE_WINDOW_DAYS, proposeMatches, reconciliationSummary, cents, daysApart };
