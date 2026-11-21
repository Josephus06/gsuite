// STP (Sales Territory Planning) -- the values the screens show that are worked out, never stored
// (next visit due, territory roll-ups, rep workload) and the input rules. Pure functions;
// routes/stp.js feeds them rows. Tested in test/stp.test.js.

const TERRITORY_STATUSES = ['Planned', 'Active', 'Under review', 'Unassigned'];
const SEGMENTS = ['Corporate', 'SME', 'Government', 'Education', 'Retail'];
const CADENCE_DAYS = { Weekly: 7, 'Every 2 weeks': 14, Monthly: 30, Quarterly: 91 };
const CADENCES = Object.keys(CADENCE_DAYS);

const day = (v) => (v ? String(v).slice(0, 10) : null);

function addDays(dateStr, days) {
  const d = new Date(`${day(dateStr)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The visit that counts: the latest of the STP visit log (kept on stp_accounts.last_visit_date)
// and the latest completed CRM visit, so a rep never logs the same visit twice (agreed 2026-11-21).
function effectiveLastVisit(...dates) {
  return dates.map(day).filter(Boolean).sort().pop() || null;
}

function nextVisitDue(lastVisit, cadence) {
  const days = CADENCE_DAYS[cadence];
  if (!lastVisit || !days) return null;
  return addDays(lastVisit, days);
}

// Overdue = the next visit was due before today. Never visited -> no next date, and not counted as
// overdue: it shows as "Not scheduled" (and, for a prospect, the Unvisited prospect flag).
function isVisitOverdue(nextDue, today) {
  return !!nextDue && nextDue < today;
}

// Due within the next `days` days, today included; an overdue visit counts as due as well.
function isVisitDueWithin(nextDue, today, days) {
  return !!nextDue && nextDue <= addDays(today, days);
}

// The flags an account shows: the score's own, plus Unvisited prospect -- worked out on read because
// logging a visit should clear it at once, not at the next scoring run.
function accountFlags({ score_warnings: scoreWarnings, is_prospect: isProspect, last_visit: lastVisit }) {
  const flags = scoreWarnings ? String(scoreWarnings).split(',').filter(Boolean) : [];
  if (isProspect && !lastVisit) flags.push('unvisited_prospect');
  return flags;
}

// Division that reads "not measurable" rather than 0 or Infinity when the base is zero.
const ratio = (num, den) => (Number(den) > 0 ? Number(num || 0) / Number(den) : null);

function tierCounts(accounts) {
  const out = { A: 0, B: 0, C: 0, Prospect: 0 };
  for (const a of accounts) {
    const t = a.tier_override || a.computed_tier;
    if (t && out[t] != null) out[t] += 1;
    else out.Prospect += 1;
  }
  return out;
}

function averageScore(accounts) {
  const scored = accounts.filter((a) => a.total_score != null);
  if (!scored.length) return null;
  return Math.round((scored.reduce((s, a) => s + Number(a.total_score), 0) / scored.length) * 100) / 100;
}

// One territory's roll-up. revenueByCustomer: Map(customer_id -> ₱ invoiced in the fiscal year).
function territoryMetrics(territory, accounts, revenueByCustomer) {
  const potential = accounts.reduce((s, a) => s + Number(a.annual_potential || 0), 0);
  const seen = new Set();
  let revenue = 0;
  for (const a of accounts) {
    const cid = Number(a.scoring_customer_id);
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    revenue += Number(revenueByCustomer.get(cid) || 0);
  }
  return {
    account_count: accounts.length,
    total_potential: potential,
    current_revenue: Math.round(revenue * 100) / 100,
    target_vs_potential: ratio(territory.target_amount, potential),
    penetration: ratio(revenue, potential),
    average_score: averageScore(accounts),
    tier_counts: tierCounts(accounts),
  };
}

// The summary cards over a set of territories already given their metrics.
function portfolioSummary(territories) {
  const target = territories.reduce((s, t) => s + Number(t.target_amount || 0), 0);
  const potential = territories.reduce((s, t) => s + t.total_potential, 0);
  const revenue = territories.reduce((s, t) => s + t.current_revenue, 0);
  return {
    territory_count: territories.length,
    account_count: territories.reduce((s, t) => s + t.account_count, 0),
    total_target: target, total_potential: potential, current_revenue: revenue, penetration: ratio(revenue, potential),
  };
}

// One rep's workload. An account belongs to its owner: owner_user_id, else its territory's rep.
function repMetrics(repId, territories, accounts, capacity) {
  const id = Number(repId);
  const mine = territories.filter((t) => Number(t.rep_user_id) === id);
  const owned = accounts.filter((a) => Number(a.effective_owner_id) === id);
  const cap = capacity != null && Number(capacity) > 0 ? Number(capacity) : null;
  const workload = cap ? owned.length / cap : null;
  return {
    territory_count: mine.length,
    accounts_owned: owned.length,
    account_capacity: cap,
    workload_pct: workload,
    over_capacity: workload != null && workload > 1,
    total_target: mine.reduce((s, t) => s + Number(t.target_amount || 0), 0),
    average_score: averageScore(owned),
    tier_counts: tierCounts(owned),
  };
}

// RULE: one customer (or lead) in only ONE territory per fiscal year. `existing` is every account
// in that fiscal year for the same customer/lead; editing an account may keep its own row.
function territoryConflict(existing, candidate) {
  const clash = existing.find((a) => Number(a.id) !== Number(candidate.id || 0)
    && Number(a.fiscal_year) === Number(candidate.fiscal_year)
    && ((candidate.customer_id && Number(a.customer_id) === Number(candidate.customer_id))
      || (candidate.lead_id && Number(a.lead_id) === Number(candidate.lead_id))));
  return clash
    ? `Already assigned to ${clash.territory_name || 'another territory'} for FY ${candidate.fiscal_year}. A customer can be in only one territory per period -- move that assignment instead.`
    : null;
}

const money = (v) => (v === '' || v == null ? 0 : Number(v));
const isYear = (y) => Number.isInteger(Number(y)) && Number(y) >= 2000 && Number(y) <= 2100;

function validateTerritory(b) {
  const errors = [];
  const name = String(b.name || '').trim();
  if (!name) errors.push('Territory name is required.');
  if (name.length > 150) errors.push('Territory name must be 150 characters or fewer.');
  if (!isYear(b.fiscal_year)) errors.push('Choose a valid period (fiscal year).');
  const target = money(b.target_amount);
  if (!Number.isFinite(target) || target < 0) errors.push('Target must be ₱0 or more.');
  const status = b.status || 'Planned';
  if (!TERRITORY_STATUSES.includes(status)) errors.push(`Status must be one of: ${TERRITORY_STATUSES.join(', ')}.`);
  const rep = b.rep_user_id ? Number(b.rep_user_id) : null;
  if (status !== 'Unassigned' && !rep) errors.push('Choose a rep, or set the status to Unassigned.');
  return {
    errors,
    value: {
      name, fiscal_year: Number(b.fiscal_year), rep_user_id: rep, coverage_area: String(b.coverage_area || '').trim() || null,
      target_amount: target, status, notes: String(b.notes || '').trim() || null,
    },
  };
}

function validateAccount(b) {
  const errors = [];
  const customer = b.customer_id ? Number(b.customer_id) : null;
  const lead = b.lead_id ? Number(b.lead_id) : null;
  const prospect = String(b.prospect_name || '').trim() || null;
  if ([customer, lead, prospect].filter(Boolean).length !== 1) errors.push('Choose a customer, a lead, or type a prospect name -- exactly one.');
  if (prospect && prospect.length > 200) errors.push('Prospect name must be 200 characters or fewer.');
  if (!b.territory_id) errors.push('Choose a territory.');
  if (!SEGMENTS.includes(b.segment)) errors.push(`Segment must be one of: ${SEGMENTS.join(', ')}.`);
  const cadence = b.visit_cadence || 'Monthly';
  if (!CADENCES.includes(cadence)) errors.push(`Visit cadence must be one of: ${CADENCES.join(', ')}.`);
  const potential = money(b.annual_potential);
  if (!Number.isFinite(potential) || potential < 0) errors.push('Annual potential must be ₱0 or more.');
  const lastVisit = day(b.last_visit_date);
  if (lastVisit && !/^\d{4}-\d{2}-\d{2}$/.test(lastVisit)) errors.push('Last visit must be a valid date.');
  return {
    errors,
    value: {
      customer_id: customer, lead_id: lead, prospect_name: prospect, territory_id: b.territory_id ? Number(b.territory_id) : null,
      segment: b.segment, annual_potential: potential, owner_user_id: b.owner_user_id ? Number(b.owner_user_id) : null,
      visit_cadence: cadence, last_visit_date: lastVisit, notes: String(b.notes || '').trim() || null,
    },
  };
}

function validateVisit(b, today) {
  const errors = [];
  const d = day(b.visit_date);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push('Visit date is required.');
  else if (d > today) errors.push('A visit cannot be logged in the future.');
  const notes = String(b.notes || '').trim();
  if (notes.length > 2000) errors.push('Keep visit notes under 2,000 characters.');
  return { errors, value: { visit_date: d, notes: notes || null, rep_user_id: b.rep_user_id ? Number(b.rep_user_id) : null } };
}

// ₱#,##0 -- whole pesos, as every STP amount is shown.
function formatPeso(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '';
  const whole = Math.round(Math.abs(n));
  return `${n < 0 && whole !== 0 ? '-' : ''}₱${whole.toLocaleString('en-US')}`;
}

module.exports = {
  TERRITORY_STATUSES, SEGMENTS, CADENCE_DAYS, CADENCES,
  addDays, effectiveLastVisit, nextVisitDue, isVisitOverdue, isVisitDueWithin, accountFlags, ratio, tierCounts,
  averageScore, territoryMetrics, portfolioSummary, repMetrics, territoryConflict,
  validateTerritory, validateAccount, validateVisit, formatPeso,
};
