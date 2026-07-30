// Accounting-period lock: once a fiscal-year month is closed (via Manage Accounting Period), no
// transaction dated in that month may be posted, edited, or voided. Each transaction type maps to a
// close category -- 'ar' (receivables), 'ap' (payables), 'other_gl' (cash/journal/etc), 'non_gl' --
// and a month is locked for it when that category's flag is set OR when Close All is set.
const pool = require('../db');

const CATEGORY_FLAG = { ar: 'close_ar', ap: 'close_ap', other_gl: 'close_other_gl', non_gl: 'close_non_gl' };
const CATEGORY_LABEL = { ar: 'A/R', ap: 'A/P', other_gl: 'Other GL', non_gl: 'Non-GL' };

// Returns a short reason string if the given date's month is locked for `category`, else null.
async function periodLock(dateStr, category, conn = pool) {
  if (!dateStr) return null;
  const [y, m] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m) return null;
  const [[row]] = await conn.query('SELECT close_all, ?? AS flag FROM accounting_periods WHERE fiscal_year = ? AND period_month = ?', [CATEGORY_FLAG[category] || 'close_all', y, m]);
  if (!row) return null;
  if (row.close_all) return 'Close All';
  if (row.flag) return `Close ${CATEGORY_LABEL[category] || category}`;
  return null;
}

// Throws a 409 if the period is locked for this category. Pass every date the change touches (e.g.
// both the old and new dates on an edit) so you can't move a transaction across a closed boundary.
async function assertPeriodOpen(dates, category, conn = pool) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean);
  for (const d of list) {
    const reason = await periodLock(d, category, conn);
    if (reason) {
      const err = new Error(`The accounting period for ${String(d).slice(0, 10)} is closed (${reason}). Posting or editing transactions in a closed period is not allowed.`);
      err.status = 409;
      throw err;
    }
  }
}

module.exports = { periodLock, assertPeriodOpen };
