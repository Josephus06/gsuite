// STP planning values and rules (lib/stp.js). Run: npm test (from server/).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CADENCE_DAYS, effectiveLastVisit, nextVisitDue, isVisitOverdue, isVisitDueWithin, accountFlags, territoryMetrics,
  portfolioSummary, repMetrics, tierCounts, territoryConflict, validateTerritory, validateAccount, validateVisit, formatPeso,
} = require('../src/lib/stp');

const TODAY = '2026-11-21';

// --- next visit / overdue ----------------------------------------------------------------------

test('next visit due = last visit + 7 / 14 / 30 / 91 days', () => {
  assert.deepEqual(CADENCE_DAYS, { Weekly: 7, 'Every 2 weeks': 14, Monthly: 30, Quarterly: 91 });
  assert.equal(nextVisitDue('2026-11-12', 'Every 2 weeks'), '2026-11-26');
  assert.equal(nextVisitDue('2026-11-12', 'Weekly'), '2026-11-19');
  assert.equal(nextVisitDue('2026-10-15', 'Monthly'), '2026-11-14');
  assert.equal(nextVisitDue('2026-12-15', 'Quarterly'), '2027-03-16'); // across a year end
  assert.equal(nextVisitDue(null, 'Monthly'), null);
});

test('overdue only when the next visit was due BEFORE today', () => {
  assert.equal(isVisitOverdue('2026-11-20', TODAY), true);
  assert.equal(isVisitOverdue('2026-11-21', TODAY), false); // due today is not yet overdue
  assert.equal(isVisitOverdue('2026-11-26', TODAY), false);
  assert.equal(isVisitOverdue(null, TODAY), false); // never visited: "Not scheduled"
});

test('due within 7 days includes today, day 7 and anything overdue', () => {
  assert.equal(isVisitDueWithin('2026-11-28', TODAY, 7), true);
  assert.equal(isVisitDueWithin('2026-11-29', TODAY, 7), false);
  assert.equal(isVisitDueWithin('2026-11-01', TODAY, 7), true);
  assert.equal(isVisitDueWithin(null, TODAY, 7), false);
});

test('last visit = the later of the STP log and the CRM', () => {
  assert.equal(effectiveLastVisit('2026-11-01', '2026-11-12'), '2026-11-12');
  assert.equal(effectiveLastVisit('2026-11-15', '2026-11-12 08:00:00'), '2026-11-15');
  assert.equal(effectiveLastVisit(null, '2026-11-12'), '2026-11-12');
  assert.equal(effectiveLastVisit(null, null), null);
});

test('flags: score warnings plus "unvisited prospect" for a prospect with no visit', () => {
  assert.deepEqual(accountFlags({ score_warnings: 'big_buyer_slow_payer,slipping_away', is_prospect: false, last_visit: null }), ['big_buyer_slow_payer', 'slipping_away']);
  assert.deepEqual(accountFlags({ score_warnings: null, is_prospect: true, last_visit: null }), ['unvisited_prospect']);
  assert.deepEqual(accountFlags({ score_warnings: null, is_prospect: true, last_visit: '2026-11-01' }), []);
});

// --- territory and rep roll-ups ----------------------------------------------------------------

const accounts = [
  { territory_id: 1, scoring_customer_id: 10, annual_potential: 500000, effective_owner_id: 7, total_score: 4.75, computed_tier: 'A' },
  { territory_id: 1, scoring_customer_id: 11, annual_potential: 350000, effective_owner_id: 7, total_score: 3.75, computed_tier: 'B' },
  { territory_id: 2, scoring_customer_id: 12, annual_potential: 300000, effective_owner_id: 8, total_score: 2.0, computed_tier: 'C', tier_override: 'B' },
  { territory_id: 2, scoring_customer_id: null, annual_potential: 200000, effective_owner_id: 7, total_score: null, computed_tier: null },
];
const revenue = new Map([[10, 300000], [11, 170000], [12, 80000]]);

test('territory: accounts, potential, revenue from invoices, target / potential, penetration', () => {
  const t = territoryMetrics({ target_amount: 600000 }, accounts.filter((a) => a.territory_id === 1), revenue);
  assert.equal(t.account_count, 2);
  assert.equal(t.total_potential, 850000);
  assert.equal(t.current_revenue, 470000);
  assert.equal(Math.round(t.target_vs_potential * 100), 71);
  assert.equal(Math.round(t.penetration * 100), 55);
  assert.equal(t.average_score, 4.25);
  assert.deepEqual(t.tier_counts, { A: 1, B: 1, C: 0, Prospect: 0 });
});

test('territory with no potential: ratios are null, not Infinity', () => {
  const t = territoryMetrics({ target_amount: 90000 }, [], revenue);
  assert.equal(t.target_vs_potential, null);
  assert.equal(t.penetration, null);
  assert.equal(t.average_score, null);
});

test('a prospect brings no revenue; tier counts use the override and count prospects', () => {
  const t = territoryMetrics({ target_amount: 0 }, accounts.filter((a) => a.territory_id === 2), revenue);
  assert.equal(t.current_revenue, 80000);
  assert.deepEqual(t.tier_counts, { A: 0, B: 1, C: 0, Prospect: 1 });
  assert.deepEqual(tierCounts(accounts), { A: 1, B: 2, C: 0, Prospect: 1 });
});

test('portfolio summary: totals and overall penetration', () => {
  const ts = [
    { target_amount: 600000, ...territoryMetrics({ target_amount: 600000 }, accounts.filter((a) => a.territory_id === 1), revenue) },
    { target_amount: 400000, ...territoryMetrics({ target_amount: 400000 }, accounts.filter((a) => a.territory_id === 2), revenue) },
  ];
  const s = portfolioSummary(ts);
  assert.equal(s.total_target, 1000000);
  assert.equal(s.total_potential, 1350000);
  assert.equal(s.current_revenue, 550000);
  assert.equal(Math.round(s.penetration * 100), 41);
});

test('rep: territories, accounts owned, workload %, total target, avg score, A/B/C', () => {
  const territories = [{ id: 1, rep_user_id: 7, target_amount: 600000 }, { id: 2, rep_user_id: 8, target_amount: 400000 }];
  const r = repMetrics(7, territories, accounts, 40);
  assert.equal(r.territory_count, 1);
  assert.equal(r.accounts_owned, 3); // owner override puts territory 2's prospect with rep 7
  assert.equal(r.workload_pct, 3 / 40);
  assert.equal(r.over_capacity, false);
  assert.equal(r.total_target, 600000);
  assert.equal(r.average_score, 4.25);
  assert.deepEqual(r.tier_counts, { A: 1, B: 1, C: 0, Prospect: 1 });
});

test('rep over capacity (> 100%), and no capacity set = no workload figure', () => {
  assert.equal(repMetrics(7, [], accounts, 2).over_capacity, true);
  assert.equal(repMetrics(7, [], accounts, 3).over_capacity, false); // exactly 100%
  const none = repMetrics(7, [], accounts, null);
  assert.equal(none.workload_pct, null);
  assert.equal(none.over_capacity, false);
});

// --- one territory per customer per period -----------------------------------------------------

test('one-territory rule: same customer, same fiscal year, other territory -> blocked', () => {
  const existing = [{ id: 5, fiscal_year: 2026, customer_id: 10, lead_id: null, territory_name: 'Cebu City North' }];
  assert.match(territoryConflict(existing, { fiscal_year: 2026, customer_id: 10 }), /Cebu City North/);
});

test('one-territory rule: editing the same assignment, another year, or another customer is fine', () => {
  const existing = [{ id: 5, fiscal_year: 2026, customer_id: 10, lead_id: null }];
  assert.equal(territoryConflict(existing, { id: 5, fiscal_year: 2026, customer_id: 10 }), null);
  assert.equal(territoryConflict(existing, { fiscal_year: 2027, customer_id: 10 }), null);
  assert.equal(territoryConflict(existing, { fiscal_year: 2026, customer_id: 11 }), null);
});

test('one-territory rule applies to leads too; free-typed prospects are not matched', () => {
  const existing = [{ id: 6, fiscal_year: 2026, customer_id: null, lead_id: 3, territory_name: 'Talisay' }];
  assert.match(territoryConflict(existing, { fiscal_year: 2026, lead_id: 3 }), /Talisay/);
  assert.equal(territoryConflict(existing, { fiscal_year: 2026, prospect_name: 'New Co' }), null);
});

// --- form validation ---------------------------------------------------------------------------

test('territory form: name, period, status and rep rules', () => {
  assert.deepEqual(validateTerritory({ name: 'Cebu North', fiscal_year: 2026, rep_user_id: 7, target_amount: '600000', status: 'Active' }).errors, []);
  assert.match(validateTerritory({ fiscal_year: 2026, rep_user_id: 7 }).errors.join(' '), /name is required/);
  assert.match(validateTerritory({ name: 'X', fiscal_year: 2026, status: 'Active' }).errors.join(' '), /Choose a rep/);
  assert.deepEqual(validateTerritory({ name: 'X', fiscal_year: 2026, status: 'Unassigned' }).errors, []);
  assert.match(validateTerritory({ name: 'X', fiscal_year: 2026, rep_user_id: 7, target_amount: -1 }).errors.join(' '), /Target/);
  assert.match(validateTerritory({ name: 'X', fiscal_year: 2026, rep_user_id: 7, status: 'Closed' }).errors.join(' '), /Status/);
});

test('account form: exactly one of customer / lead / prospect name', () => {
  const base = { territory_id: 1, segment: 'SME', visit_cadence: 'Monthly' };
  assert.deepEqual(validateAccount({ ...base, customer_id: 10 }).errors, []);
  assert.deepEqual(validateAccount({ ...base, prospect_name: 'New Co' }).errors, []);
  assert.match(validateAccount(base).errors.join(' '), /exactly one/);
  assert.match(validateAccount({ ...base, customer_id: 10, prospect_name: 'New Co' }).errors.join(' '), /exactly one/);
  assert.match(validateAccount({ ...base, customer_id: 10, segment: 'Hospital' }).errors.join(' '), /Segment/);
  assert.match(validateAccount({ ...base, customer_id: 10, visit_cadence: 'Daily' }).errors.join(' '), /cadence/);
});

test('visit form: date required, not in the future', () => {
  assert.deepEqual(validateVisit({ visit_date: '2026-11-21' }, TODAY).errors, []);
  assert.match(validateVisit({ visit_date: '2026-11-22' }, TODAY).errors.join(' '), /future/);
  assert.match(validateVisit({}, TODAY).errors.join(' '), /required/);
});

test('₱#,##0 formatting', () => {
  assert.equal(formatPeso(1340000), '₱1,340,000');
  assert.equal(formatPeso(820000.49), '₱820,000');
  assert.equal(formatPeso(0), '₱0');
  assert.equal(formatPeso(-4500.6), '-₱4,501');
  assert.equal(formatPeso(null), '');
});
