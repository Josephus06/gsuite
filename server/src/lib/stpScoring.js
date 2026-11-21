// STP customer scoring -- RFVC (Recency, Frequency, Volume, Character). Pure functions only: the
// database reads live in lib/stpScoringData.js, which hands the raw rows in here. Kept apart so
// every rule below is tested without a database (test/stpScoring.test.js).
//
// Each factor scores 1 (worst) to 5 (best) from four cut-offs held in stp_scoring_settings:
//   "lower is better"  (Recency days, days late): value <= c[0] -> 5, <= c[1] -> 4, <= c[2] -> 3, <= c[3] -> 2, else 1
//   "higher is better" (Frequency, Volume):       value >= c[0] -> 5, >= c[1] -> 4, >= c[2] -> 3, >= c[3] -> 2, else 1
//
// Character (agreed 2026-11-21). The data import generated a payment for every settled invoice,
// dated the invoice's own day, so for now there are no real collection dates. Character is:
//   1. amount-weighted days paid PAST the due date, from real payments in the window, else
//   2. the AR-aging overdue balance as a % of the window's volume, else
//   3. a neutral 3 (nothing has fallen due yet).

const FACTORS = ['recency', 'frequency', 'volume', 'character'];
const TIERS = ['A', 'B', 'C'];

// Payment numbers the import generated (one per invoice it found settled). They prove an invoice
// was paid but not when: they count toward the overdue balance (through AR aging) and never
// toward days to pay, days late or on-time %.
const SYNTHETIC_PAYMENT_PREFIX = 'CPAY-INV-';

// Warning rules (from the spec, fixed rather than configurable).
const WARNING_RULES = {
  big_buyer_slow_payer: { volume_min: 4, character_max: 2 },
  slipping_away: { volume_min: 3, recency_max: 2 },
};
const WARNING_LABELS = {
  big_buyer_slow_payer: 'Big buyer, slow payer',
  slipping_away: 'Slipping away',
  unvisited_prospect: 'Unvisited prospect',
};

const DEFAULT_SETTINGS = {
  window_months: 12,
  weights: { recency: 25, frequency: 25, volume: 25, character: 25 },
  recency: [30, 60, 90, 180], // days since the last invoice, lower is better
  frequency: [24, 12, 6, 2], // invoices in the window, higher is better
  volume: [500000, 250000, 100000, 25000], // ₱ net of tax less credit memos, higher is better
  character: [0, 15, 30, 60], // amount-weighted days paid past due, lower is better (<= 0 = within terms)
  character_overdue: [1, 10, 25, 60], // fallback: overdue as % of volume, lower is better (strict <)
  tier_a_min: 4.0,
  tier_b_min: 2.5,
  require_override_reason: true,
};

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const day = (v) => (v == null ? null : String(v).slice(0, 10));

function scoreLowerBetter(value, cutoffs) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  for (let i = 0; i < 4; i += 1) if (v <= cutoffs[i]) return 5 - i;
  return 1;
}

function scoreHigherBetter(value, cutoffs) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  for (let i = 0; i < 4; i += 1) if (v >= cutoffs[i]) return 5 - i;
  return 1;
}

// Strict "<": 0% overdue against a 1% cut-off is a 5; exactly 1% is a 4.
function scoreOverduePct(value, cutoffs) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  for (let i = 0; i < 4; i += 1) if (v < cutoffs[i]) return 5 - i;
  return 1;
}

function daysBetween(fromStr, toStr) {
  const a = Date.parse(`${day(fromStr)}T00:00:00Z`);
  const b = Date.parse(`${day(toStr)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// First day of the rolling window: as of 2026-11-21 over 12 months -> 2025-11-22.
function windowStart(asOf, months) {
  const d = new Date(`${day(asOf)}T00:00:00Z`);
  const dom = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dom, last) + 1);
  return d.toISOString().slice(0, 10);
}

const inWindow = (date, start, asOf) => {
  const d = day(date);
  return d >= start && d <= asOf;
};
const isReal = (p) => !String(p.payment_no || '').startsWith(SYNTHETIC_PAYMENT_PREFIX);
const dueOf = (inv) => day(inv.date_due || inv.date_created);

// The facts behind the scores, for ONE customer, from raw rows:
//   invoices     [{ id, date_created, date_due, net_of_tax, amount_due }]  not cancelled
//   creditMemos  [{ date_created, net_of_tax }]                            not cancelled
//   payments     [{ sales_invoice_id, payment_no, payment_date, applied_amount }]  not voided
//   creditApps   [{ sales_invoice_id, date_created, amount }]  credit memos applied to an invoice
//   openItems    AR aging's open items for the customer as of asOf (lib/arAging.js collectOpenItems)
// Returns null for a prospect -- nothing ever invoiced.
function computeMetrics({ invoices = [], creditMemos = [], payments = [], creditApps = [], openItems = [] }, asOf, months) {
  const upTo = invoices.filter((i) => day(i.date_created) <= asOf);
  if (!upTo.length) return null;
  const start = windowStart(asOf, months);

  const lastInvoice = upTo.reduce((m, i) => (day(i.date_created) > m ? day(i.date_created) : m), '');
  const windowInvoices = upTo.filter((i) => inWindow(i.date_created, start, asOf));
  const invoiced = windowInvoices.reduce((s, i) => s + Number(i.net_of_tax || 0), 0);
  const credited = creditMemos.filter((c) => inWindow(c.date_created, start, asOf))
    .reduce((s, c) => s + Number(c.net_of_tax || 0), 0);
  const volume = round2(invoiced - credited);

  // Days to pay and days late: real payment lines dated in the window, weighted by amount.
  // A partial payment is its own line, so an invoice paid in two halves counts each half at its
  // own date.
  const invoiceById = new Map(invoices.map((i) => [String(i.id), i]));
  const real = payments.filter((p) => isReal(p) && inWindow(p.payment_date, start, asOf) && Number(p.applied_amount) > 0);
  let toPay = 0;
  let late = 0;
  let weight = 0;
  for (const p of real) {
    const inv = invoiceById.get(String(p.sales_invoice_id));
    if (!inv) continue;
    const amt = Number(p.applied_amount);
    toPay += amt * Math.max(0, daysBetween(inv.date_created, p.payment_date));
    late += amt * Math.max(0, daysBetween(dueOf(inv), p.payment_date));
    weight += amt;
  }
  const hasPaymentHistory = weight > 0;

  // On time: of the invoices that fell due inside the window, the share fully settled (payments +
  // credit memos applied) by the due date. An invoice settled only by an imported payment has
  // unknown timing and is left out; one still unpaid past its due date is late. Measured only
  // once the customer has real payment history.
  let onTimePct = null;
  if (hasPaymentHistory) {
    const synthetic = new Set(payments.filter((p) => !isReal(p)).map((p) => String(p.sales_invoice_id)));
    let due = 0;
    let onTime = 0;
    for (const inv of upTo) {
      const d = dueOf(inv);
      const owed = Number(inv.amount_due || 0);
      if (!inWindow(d, start, asOf) || synthetic.has(String(inv.id)) || owed <= 0.005) continue;
      const settled = payments.filter((p) => String(p.sales_invoice_id) === String(inv.id) && day(p.payment_date) <= d)
        .reduce((s, p) => s + Number(p.applied_amount || 0), 0)
        + creditApps.filter((c) => String(c.sales_invoice_id) === String(inv.id) && day(c.date_created) <= d)
          .reduce((s, c) => s + Number(c.amount || 0), 0);
      due += 1;
      if (settled >= owed - 1) onTime += 1; // ₱1 tolerance for rounding
    }
    if (due) onTimePct = round1((onTime / due) * 100);
  }

  // Overdue: AR aging's open invoice balances past due, less any open credit the customer holds
  // (an unapplied payment or credit memo) -- what they would owe once that credit is applied.
  let pastDue = 0;
  let openCredit = 0;
  for (const item of openItems) {
    const bal = Number(item.balance || 0);
    if (bal < 0) openCredit += bal;
    else if (item.type === 'Invoice' && item.due_date && day(item.due_date) < asOf) pastDue += bal;
  }
  const overdue = round2(Math.max(0, pastDue + openCredit));
  const anyFallenDue = upTo.some((i) => dueOf(i) < asOf) || pastDue > 0;
  let overduePct = null;
  if (anyFallenDue) {
    if (overdue <= 0) overduePct = 0;
    else overduePct = volume > 0 ? round1((overdue / volume) * 100) : 100;
  }

  return {
    period_start: start,
    last_invoice_date: lastInvoice,
    days_since_last_order: daysBetween(lastInvoice, asOf),
    order_count: windowInvoices.length,
    net_volume: volume,
    has_payment_history: hasPaymentHistory,
    avg_days_to_pay: hasPaymentHistory ? round1(toPay / weight) : null,
    avg_days_late: hasPaymentHistory ? round1(late / weight) : null,
    pct_on_time: onTimePct,
    overdue_balance: overdue,
    overdue_pct: overduePct,
  };
}

// Character score and where it came from: 'payments' | 'overdue' | 'neutral'.
function characterScore(m, s) {
  if (m.avg_days_late != null) return { score: scoreLowerBetter(m.avg_days_late, s.character), source: 'payments' };
  if (m.overdue_pct != null) return { score: scoreOverduePct(m.overdue_pct, s.character_overdue), source: 'overdue' };
  return { score: 3, source: 'neutral' };
}

function weightedTotal(scores, weights) {
  let sum = 0;
  let w = 0;
  for (const f of FACTORS) {
    const wt = Number(weights?.[f]) || 0;
    if (wt <= 0 || scores[f] == null) continue;
    sum += scores[f] * wt;
    w += wt;
  }
  return w > 0 ? round2(sum / w) : null;
}

function tierFor(total, s) {
  if (total == null) return null;
  if (total >= Number(s.tier_a_min)) return 'A';
  if (total >= Number(s.tier_b_min)) return 'B';
  return 'C';
}

// Score-based warnings, worked out with the score. ("Unvisited prospect" depends on the visit
// log, which changes between runs, so it is worked out when the page is read -- see lib/stp.js.)
function warningsFor(scores) {
  const out = [];
  if (!scores) return out;
  const b = WARNING_RULES.big_buyer_slow_payer;
  const sl = WARNING_RULES.slipping_away;
  if (scores.volume >= b.volume_min && scores.character <= b.character_max) out.push('big_buyer_slow_payer');
  if (scores.volume >= sl.volume_min && scores.recency <= sl.recency_max) out.push('slipping_away');
  return out;
}

// Everything for one account. metrics null -> a prospect: no scores, no tier.
function scoreAccount(metrics, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!metrics) return { is_prospect: true, scores: null, character_source: null, total: null, tier: null, warnings: [] };
  const character = characterScore(metrics, s);
  const scores = {
    recency: scoreLowerBetter(metrics.days_since_last_order, s.recency),
    frequency: scoreHigherBetter(metrics.order_count, s.frequency),
    volume: scoreHigherBetter(metrics.net_volume, s.volume),
    character: character.score,
  };
  const total = weightedTotal(scores, s.weights);
  return { is_prospect: false, scores, character_source: character.source, total, tier: tierFor(total, s), warnings: warningsFor(scores) };
}

// A manual tier wins over the computed one; both are always shown.
function effectiveTier(computed, override) {
  return override || computed || null;
}

// Validates a tier-override request. tier null/'' clears the override.
function validateOverride({ tier, reason }, requireReason) {
  if (tier == null || tier === '') return { ok: true, tier: null, reason: null };
  const t = String(tier).toUpperCase();
  if (!TIERS.includes(t)) return { ok: false, error: 'Tier must be A, B or C.' };
  const r = String(reason || '').trim();
  if (requireReason && !r) return { ok: false, error: 'A reason is required for a manual tier override.' };
  if (r.length > 500) return { ok: false, error: 'Keep the reason under 500 characters.' };
  return { ok: true, tier: t, reason: r || null };
}

// Settings arrive from the admin form; anything malformed is refused with a message naming it.
function validateSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const errors = [];
  const months = Number(s.window_months);
  if (!Number.isInteger(months) || months < 1 || months > 60) errors.push('Window must be a whole number of months from 1 to 60.');
  const lists = {
    recency: ['Recency', 'asc'], frequency: ['Frequency', 'desc'], volume: ['Volume', 'desc'],
    character: ['Character (days late)', 'asc'], character_overdue: ['Character (overdue %)', 'asc'],
  };
  for (const [key, [label, dir]] of Object.entries(lists)) {
    const c = s[key];
    if (!Array.isArray(c) || c.length !== 4 || c.some((v) => v === '' || v == null || !Number.isFinite(Number(v)) || Number(v) < 0)) {
      errors.push(`${label} needs four cut-offs, each 0 or more.`);
      continue;
    }
    const n = c.map(Number);
    if (!n.every((v, i) => i === 0 || (dir === 'asc' ? v > n[i - 1] : v < n[i - 1]))) {
      errors.push(`${label} cut-offs must ${dir === 'asc' ? 'increase' : 'decrease'} from Score 5 to Score 2.`);
    }
    s[key] = n;
  }
  const w = s.weights || {};
  if (FACTORS.some((f) => w[f] === '' || w[f] == null || !Number.isFinite(Number(w[f])) || Number(w[f]) < 0)) {
    errors.push('Each weight must be a number from 0 to 100.');
  } else if (Math.abs(FACTORS.reduce((a, f) => a + Number(w[f]), 0) - 100) > 0.001) {
    errors.push('Weights must add up to 100%.');
  }
  s.weights = Object.fromEntries(FACTORS.map((f) => [f, Number(w[f]) || 0]));
  const A = Number(s.tier_a_min);
  const B = Number(s.tier_b_min);
  if (!(Number.isFinite(A) && Number.isFinite(B) && A <= 5 && A > B && B >= 1)) errors.push('Tier cut-offs must satisfy 5 ≥ A > B ≥ 1.');
  s.tier_a_min = A;
  s.tier_b_min = B;
  s.require_override_reason = s.require_override_reason !== false && s.require_override_reason !== 0 && s.require_override_reason !== 'false';
  s.window_months = months;
  return { settings: s, errors };
}

// stp_scoring_settings row <-> the settings object the functions above take.
function settingsToRow(s) {
  return {
    window_months: s.window_months,
    weight_recency: s.weights.recency,
    weight_frequency: s.weights.frequency,
    weight_volume: s.weights.volume,
    weight_character: s.weights.character,
    recency_cutoffs: JSON.stringify(s.recency),
    frequency_cutoffs: JSON.stringify(s.frequency),
    volume_cutoffs: JSON.stringify(s.volume),
    character_cutoffs: JSON.stringify(s.character),
    character_overdue_cutoffs: JSON.stringify(s.character_overdue),
    tier_a_min: s.tier_a_min,
    tier_b_min: s.tier_b_min,
    require_override_reason: !!s.require_override_reason,
  };
}

function rowToSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  const list = (v, fallback) => {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) && parsed.length === 4 ? parsed.map(Number) : fallback;
  };
  return {
    window_months: Number(row.window_months) || DEFAULT_SETTINGS.window_months,
    weights: {
      recency: Number(row.weight_recency), frequency: Number(row.weight_frequency),
      volume: Number(row.weight_volume), character: Number(row.weight_character),
    },
    recency: list(row.recency_cutoffs, DEFAULT_SETTINGS.recency),
    frequency: list(row.frequency_cutoffs, DEFAULT_SETTINGS.frequency),
    volume: list(row.volume_cutoffs, DEFAULT_SETTINGS.volume),
    character: list(row.character_cutoffs, DEFAULT_SETTINGS.character),
    character_overdue: list(row.character_overdue_cutoffs, DEFAULT_SETTINGS.character_overdue),
    tier_a_min: Number(row.tier_a_min),
    tier_b_min: Number(row.tier_b_min),
    require_override_reason: !!row.require_override_reason,
  };
}

module.exports = {
  FACTORS, TIERS, DEFAULT_SETTINGS, SYNTHETIC_PAYMENT_PREFIX, WARNING_RULES, WARNING_LABELS,
  settingsToRow, rowToSettings,
  scoreLowerBetter, scoreHigherBetter, scoreOverduePct, daysBetween, windowStart,
  computeMetrics, characterScore, weightedTotal, tierFor, warningsFor, scoreAccount,
  effectiveTier, validateOverride, validateSettings,
};
