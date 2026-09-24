// How often a customer should be visited, by CRM priority.
//
// customers.visit_every_days overrides this per account; NULL means "use the priority's default".
// Kept in one place because both the customer profile (routes/crm.js, "visit due on") and the
// needs-attention scoring read it, and they must agree on when a visit is overdue.
const PRIORITIES = ['high', 'normal', 'low'];

const DEFAULT_VISIT_EVERY_DAYS = { high: 14, normal: 30, low: 90 };

function visitEveryDays(priority, override) {
  const n = Number(override);
  if (Number.isInteger(n) && n > 0) return n;
  return DEFAULT_VISIT_EVERY_DAYS[priority] || DEFAULT_VISIT_EVERY_DAYS.normal;
}

module.exports = { PRIORITIES, DEFAULT_VISIT_EVERY_DAYS, visitEveryDays };
