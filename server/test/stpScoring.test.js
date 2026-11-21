// RFVC scoring (lib/stpScoring.js). Run: npm test (from server/).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS: S, scoreLowerBetter, scoreHigherBetter, scoreOverduePct, windowStart, computeMetrics,
  characterScore, weightedTotal, tierFor, warningsFor, scoreAccount, effectiveTier, validateOverride, validateSettings,
  settingsToRow, rowToSettings,
} = require('../src/lib/stpScoring');

const AS_OF = '2026-11-21';
const inv = (id, date, due, net, amountDue = net * 1.12) => ({ id, date_created: date, date_due: due, net_of_tax: net, amount_due: amountDue });
const pay = (invoiceId, date, amount, no = `CPAY-${invoiceId}-${date}`) => ({ sales_invoice_id: invoiceId, payment_no: no, payment_date: date, applied_amount: amount });
const metrics = (rows) => computeMetrics(rows, AS_OF, 12);

// --- each factor's score -------------------------------------------------------------------------

test('Recency: <=30 = 5, 31-60 = 4, 61-90 = 3, 91-180 = 2, >180 = 1', () => {
  const r = (d) => scoreLowerBetter(d, S.recency);
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91, 180, 181, 900].map(r), [5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
});

test('Frequency: >=24 = 5, 12-23 = 4, 6-11 = 3, 2-5 = 2, <=1 = 1', () => {
  const f = (n) => scoreHigherBetter(n, S.frequency);
  assert.deepEqual([40, 24, 23, 12, 11, 6, 5, 2, 1, 0].map(f), [5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
});

test('Volume: >=500k = 5, 250k-499,999 = 4, 100k-249,999 = 3, 25k-99,999 = 2, <25k = 1', () => {
  const v = (n) => scoreHigherBetter(n, S.volume);
  assert.deepEqual([500000, 499999, 250000, 249999, 100000, 99999, 25000, 24999, 0, -5000].map(v), [5, 4, 4, 3, 3, 2, 2, 1, 1, 1]);
});

test('Character (days late): within terms = 5, +1-15 = 4, +16-30 = 3, +31-60 = 2, >60 = 1', () => {
  const c = (d) => scoreLowerBetter(d, S.character);
  assert.deepEqual([0, 1, 15, 16, 30, 31, 60, 61].map(c), [5, 4, 4, 3, 3, 2, 2, 1]);
});

test('Character fallback (overdue % of volume) uses strict "<" cut-offs', () => {
  const o = (p) => scoreOverduePct(p, S.character_overdue);
  assert.deepEqual([0, 0.9, 1, 9.9, 10, 24.9, 25, 59.9, 60, 500].map(o), [5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
});

test('missing values score null, not 1', () => {
  assert.equal(scoreLowerBetter(null, S.recency), null);
  assert.equal(scoreHigherBetter(undefined, S.volume), null);
  assert.equal(scoreOverduePct(NaN, S.character_overdue), null);
});

test('rolling window: 12 months to 2026-11-21 starts 2025-11-22; month ends clamp', () => {
  assert.equal(windowStart('2026-11-21', 12), '2025-11-22');
  assert.equal(windowStart('2026-03-31', 1), '2026-03-01');
  assert.equal(windowStart('2024-02-29', 12), '2023-03-01');
});

// --- the facts behind the scores (edge cases) ---------------------------------------------------

test('no invoices -> prospect: no score, no tier', () => {
  assert.equal(metrics({}), null);
  const r = scoreAccount(null, S);
  assert.equal(r.is_prospect, true);
  assert.equal(r.total, null);
  assert.equal(r.tier, null);
  assert.deepEqual(r.warnings, []);
});

test('an invoice dated after the as-of date is ignored (still a prospect)', () => {
  assert.equal(metrics({ invoices: [inv(1, '2026-12-01', '2026-12-31', 1000)] }), null);
});

test('recency counts from the latest invoice ever; frequency/volume only inside the window', () => {
  const m = metrics({ invoices: [inv(1, '2024-01-10', '2024-02-09', 50000), inv(2, '2026-10-22', '2026-11-21', 20000)] });
  assert.equal(m.last_invoice_date, '2026-10-22');
  assert.equal(m.days_since_last_order, 30);
  assert.equal(m.order_count, 1);
  assert.equal(m.net_volume, 20000);
});

test('credit memos in the window reduce volume; older ones do not', () => {
  const m = metrics({
    invoices: [inv(1, '2026-06-01', '2026-07-01', 300000)],
    creditMemos: [{ date_created: '2026-07-15', net_of_tax: 60000 }, { date_created: '2025-01-01', net_of_tax: 99999 }],
  });
  assert.equal(m.net_volume, 240000);
  assert.equal(scoreHigherBetter(m.net_volume, S.volume), 3); // would be 4 before the credit memo
});

test('credit memos larger than invoices give negative volume, scored 1', () => {
  const m = metrics({ invoices: [inv(1, '2026-06-01', '2026-07-01', 1000)], creditMemos: [{ date_created: '2026-06-02', net_of_tax: 5000 }] });
  assert.equal(m.net_volume, -4000);
  assert.equal(scoreAccount(m, S).scores.volume, 1);
});

test('no payment history -> no days-to-pay; Character falls back to the overdue balance', () => {
  const m = metrics({
    invoices: [inv(1, '2026-06-01', '2026-07-01', 100000)],
    openItems: [{ type: 'Invoice', due_date: '2026-07-01', balance: 30000 }],
  });
  assert.equal(m.has_payment_history, false);
  assert.equal(m.avg_days_to_pay, null);
  assert.equal(m.pct_on_time, null);
  assert.equal(m.overdue_balance, 30000);
  assert.equal(m.overdue_pct, 30); // 30,000 of 100,000
  assert.deepEqual(characterScore(m, S), { score: 2, source: 'overdue' });
});

test('no payment history and nothing fallen due yet -> neutral Character 3', () => {
  const m = metrics({ invoices: [inv(1, '2026-11-20', '2026-12-20', 100000)] });
  assert.equal(m.overdue_pct, null);
  assert.deepEqual(characterScore(m, S), { score: 3, source: 'neutral' });
});

test('imported (CPAY-INV-) payments are not payment history: their dates are not real', () => {
  const m = metrics({
    invoices: [inv(1, '2026-06-01', '2026-07-01', 100000)],
    payments: [pay(1, '2026-06-01', 112000, 'CPAY-INV-1')],
  });
  assert.equal(m.has_payment_history, false);
  assert.equal(m.avg_days_to_pay, null);
  assert.equal(m.overdue_pct, 0); // paid per AR aging (no open items) -> 0% overdue -> 5
  assert.deepEqual(characterScore(m, S), { score: 5, source: 'overdue' });
});

test('unpaid invoice past due: counted late for on-time %, and overdue from AR aging', () => {
  const m = metrics({
    invoices: [inv(1, '2026-05-01', '2026-05-31', 100000, 112000), inv(2, '2026-08-01', '2026-08-31', 100000, 112000)],
    payments: [pay(1, '2026-05-20', 112000)], // invoice 1 paid on time; invoice 2 never paid
    openItems: [{ type: 'Invoice', due_date: '2026-08-31', balance: 112000 }],
  });
  assert.equal(m.pct_on_time, 50);
  assert.equal(m.avg_days_to_pay, 19);
  assert.equal(m.avg_days_late, 0);
  assert.equal(m.overdue_balance, 112000);
  assert.equal(characterScore(m, S).source, 'payments');
  assert.equal(characterScore(m, S).score, 5); // paid within terms; on-time % and overdue are shown, not scored
});

test('partial payments: each part weighted by its own amount and date', () => {
  // ₱100,000 due 2026-07-01: ₱40,000 paid on 06-21 (20 days, on time), ₱60,000 on 07-31 (60 days, 30 late)
  const m = metrics({
    invoices: [inv(1, '2026-06-01', '2026-07-01', 100000, 100000)],
    payments: [pay(1, '2026-06-21', 40000), pay(1, '2026-07-31', 60000)],
  });
  assert.equal(m.avg_days_to_pay, 44); // (40k*20 + 60k*60) / 100k
  assert.equal(m.avg_days_late, 18); // (40k*0 + 60k*30) / 100k
  assert.equal(m.pct_on_time, 0); // not fully settled by its due date
  assert.equal(characterScore(m, S).score, 3); // 18 days late -> +16-30
});

test('a credit memo applied before the due date helps settle the invoice on time', () => {
  const m = metrics({
    invoices: [inv(1, '2026-06-01', '2026-07-01', 100000, 100000)],
    payments: [pay(1, '2026-06-25', 90000)],
    creditApps: [{ sales_invoice_id: 1, date_created: '2026-06-10', amount: 10000 }],
  });
  assert.equal(m.pct_on_time, 100);
});

test('open credit (unapplied payment / credit memo) offsets the overdue balance, never below 0', () => {
  const base = { invoices: [inv(1, '2026-06-01', '2026-07-01', 100000)] };
  assert.equal(metrics({ ...base, openItems: [{ type: 'Invoice', due_date: '2026-07-01', balance: 50000 }, { type: 'Credit Memo', balance: -20000 }] }).overdue_balance, 30000);
  assert.equal(metrics({ ...base, openItems: [{ type: 'Invoice', due_date: '2026-07-01', balance: 5000 }, { type: 'Unapplied Payment', balance: -20000 }] }).overdue_balance, 0);
});

test('an invoice not yet due is not overdue', () => {
  const m = metrics({ invoices: [inv(1, '2026-11-01', '2026-12-01', 100000)], openItems: [{ type: 'Invoice', due_date: '2026-12-01', balance: 112000 }] });
  assert.equal(m.overdue_balance, 0);
});

test('overdue with no volume in the window counts as 100%', () => {
  const m = metrics({ invoices: [inv(1, '2024-06-01', '2024-07-01', 100000)], openItems: [{ type: 'Invoice', due_date: '2024-07-01', balance: 1000 }] });
  assert.equal(m.net_volume, 0);
  assert.equal(m.overdue_pct, 100);
});

// --- weighted total, tier, override, warnings --------------------------------------------------

test('weighted total: equal weights is the plain average', () => {
  assert.equal(weightedTotal({ recency: 5, frequency: 4, volume: 4, character: 2 }, S.weights), 3.75);
});

test('weighted total honours unequal weights and skips 0-weight factors', () => {
  assert.equal(weightedTotal({ recency: 5, frequency: 1, volume: 1, character: 1 }, { recency: 40, frequency: 20, volume: 20, character: 20 }), 2.6);
  assert.equal(weightedTotal({ recency: 5, frequency: 1, volume: 5, character: 1 }, { recency: 50, frequency: 0, volume: 50, character: 0 }), 5);
});

test('tier: A >= 4.0, B >= 2.5, else C', () => {
  assert.deepEqual([5, 4, 3.99, 2.5, 2.49, 1].map((t) => tierFor(t, S)), ['A', 'A', 'B', 'B', 'C', 'C']);
  assert.equal(tierFor(null, S), null);
  assert.equal(tierFor(3.5, { tier_a_min: 3.5, tier_b_min: 2 }), 'A');
});

test('a manual override wins over the computed tier', () => {
  assert.equal(effectiveTier('C', 'A'), 'A');
  assert.equal(effectiveTier('B', null), 'B');
  assert.equal(effectiveTier(null, null), null);
});

test('override validation: reason required when the setting says so', () => {
  assert.equal(validateOverride({ tier: 'A', reason: '' }, true).ok, false);
  assert.deepEqual(validateOverride({ tier: 'a', reason: ' Strategic account ' }, true), { ok: true, tier: 'A', reason: 'Strategic account' });
  assert.deepEqual(validateOverride({ tier: 'B', reason: '' }, false), { ok: true, tier: 'B', reason: null });
  assert.equal(validateOverride({ tier: 'D', reason: 'x' }, true).ok, false);
  assert.deepEqual(validateOverride({ tier: null }, true), { ok: true, tier: null, reason: null }); // clearing needs no reason
});

test('warning: big buyer, slow payer = Volume >= 4 and Character <= 2', () => {
  assert.deepEqual(warningsFor({ recency: 5, frequency: 4, volume: 4, character: 2 }), ['big_buyer_slow_payer']);
  assert.deepEqual(warningsFor({ recency: 5, frequency: 4, volume: 3, character: 1 }), []);
  assert.deepEqual(warningsFor({ recency: 5, frequency: 4, volume: 5, character: 3 }), []);
});

test('warning: slipping away = Volume >= 3 and Recency <= 2', () => {
  assert.deepEqual(warningsFor({ recency: 2, frequency: 2, volume: 3, character: 4 }), ['slipping_away']);
  assert.deepEqual(warningsFor({ recency: 1, frequency: 2, volume: 5, character: 1 }), ['big_buyer_slow_payer', 'slipping_away']);
  assert.deepEqual(warningsFor({ recency: 3, frequency: 2, volume: 5, character: 4 }), []);
});

test('scoreAccount end to end: the mockup\'s Sample Account C (3.75, tier B, slow payer)', () => {
  const m = {
    days_since_last_order: 12, order_count: 14, net_volume: 300000, avg_days_late: 31, overdue_pct: 20,
  };
  const r = scoreAccount(m, S);
  assert.deepEqual(r.scores, { recency: 5, frequency: 4, volume: 4, character: 2 });
  assert.equal(r.total, 3.75);
  assert.equal(r.tier, 'B');
  assert.deepEqual(r.warnings, ['big_buyer_slow_payer']);
});

// --- settings --------------------------------------------------------------------------------

test('settings: defaults are valid and survive a round trip through the table row', () => {
  const { errors, settings } = validateSettings(S);
  assert.deepEqual(errors, []);
  const row = settingsToRow(settings);
  assert.deepEqual(rowToSettings({ ...row, require_override_reason: 1 }), settings);
});

test('settings: weights must total 100, cut-offs must be ordered, tiers A > B', () => {
  assert.match(validateSettings({ weights: { recency: 30, frequency: 25, volume: 25, character: 25 } }).errors.join(' '), /add up to 100/);
  assert.match(validateSettings({ recency: [60, 30, 90, 180] }).errors.join(' '), /Recency cut-offs must increase/);
  assert.match(validateSettings({ volume: [100, 200, 300, 400] }).errors.join(' '), /Volume cut-offs must decrease/);
  assert.match(validateSettings({ tier_a_min: 2, tier_b_min: 3 }).errors.join(' '), /Tier cut-offs/);
  assert.match(validateSettings({ window_months: 0 }).errors.join(' '), /Window/);
});
