// Fixed-asset valuation: what an asset cost, what it has depreciated, and what it is worth now.
//
// Two rules hold this together, and both exist because the alternative silently drifts:
//
//  1. Capitalised cost is the SUM of asset_cost_lines, never a stored total. Freight and
//     installation are capitalised alongside the purchase price, and a later improvement adds
//     another line -- a single column would have to be recomputed by every writer, and the one
//     that forgets is the one nobody finds.
//
//  2. Accumulated depreciation is the SUM of POSTED depreciation lines, never a stored balance.
//     It is the same argument as the custody ledger: a running total can be edited into agreeing
//     with nothing, whereas a sum over documents can always be traced back to the months that
//     produced it.
//
// Both are cheap here -- an asset accrues one depreciation line a month, so even a decade-old
// machine sums 120 rows.
const pool = require('../db');

const STRAIGHT_LINE = 'straight_line';

function db(conn) { return conn || pool; }

const money = (v) => Number((Number(v) || 0).toFixed(2));

// Period keys are always the first of the month. Everything downstream compares periods as dates,
// so a run for "2026-09" and one for "2026-09-30" must not be able to look like different months.
function periodStart(value) {
  return `${String(value).slice(0, 7)}-01`;
}

function monthsBetween(fromDate, toDate) {
  const [fy, fm] = String(fromDate).slice(0, 7).split('-').map(Number);
  const [ty, tm] = String(toDate).slice(0, 7).split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

async function capitalizedCost(assetId, conn) {
  const [[r]] = await db(conn).query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM asset_cost_lines WHERE asset_id = ?',
    [assetId],
  );
  return money(r.total);
}

// Accumulated depreciation from POSTED runs only.
//
// Two ways to bound it, and they mean different things:
//   beforePeriod  -- exclusive: everything strictly BEFORE this month. Used when computing a
//                    month, so re-running an open period is idempotent rather than cumulative.
//   throughPeriod -- inclusive: everything up to and INCLUDING this month. Used for reporting a
//                    balance as at a date.
async function accumulatedDepreciation(assetId, { beforePeriod = null, throughPeriod = null, conn = null } = {}) {
  const params = [assetId];
  let sql = `SELECT COALESCE(SUM(l.amount), 0) AS total
               FROM asset_depreciation_lines l
               JOIN asset_depreciation_runs r ON r.id = l.run_id
              WHERE l.asset_id = ? AND r.status = 'posted'`;
  if (beforePeriod) { sql += ' AND r.period_month < ?'; params.push(periodStart(beforePeriod)); }
  if (throughPeriod) { sql += ' AND r.period_month <= ?'; params.push(periodStart(throughPeriod)); }
  const [[r]] = await db(conn).query(sql, params);
  return money(r.total);
}

// How many months an asset has already been depreciated for. Counted as posted LINES rather than
// as elapsed calendar months, so a month that was skipped (the asset was not yet in service, or a
// run was voided) does not quietly shorten the remaining life.
async function depreciatedMonths(assetId, { beforePeriod = null, conn = null } = {}) {
  const params = [assetId];
  let sql = `SELECT COUNT(*) AS n
               FROM asset_depreciation_lines l
               JOIN asset_depreciation_runs r ON r.id = l.run_id
              WHERE l.asset_id = ? AND r.status = 'posted' AND l.amount <> 0`;
  if (beforePeriod) { sql += ' AND r.period_month < ?'; params.push(periodStart(beforePeriod)); }
  const [[r]] = await db(conn).query(sql, params);
  return Number(r.n) || 0;
}

// Straight-line depreciation for one asset for one month.
//
// Expressed as "what is left, spread over the months that are left" rather than the textbook
// (cost - salvage) / life. The two agree exactly for an asset that never changes -- but this form
// also absorbs, prospectively and without a correcting entry, the two things that do happen: an
// improvement capitalised mid-life raises the base, and a month missed for any reason shortens the
// remaining term. That is the treatment an accountant expects for a change in estimate, and it is
// self-correcting, so accumulated depreciation can never overshoot the depreciable base.
//
// The final month takes the entire remainder, which is what stops half a peso of rounding being
// left on an asset that is supposed to be fully depreciated.
function straightLineMonthly({ capitalizedCost: cost, salvageValue, usefulLifeMonths, openingAccumulated, monthsAlreadyDepreciated }) {
  const base = money(money(cost) - money(salvageValue));
  const opening = money(openingAccumulated);
  const remainingValue = money(base - opening);
  if (remainingValue <= 0) return { amount: 0, base, remainingLifeMonths: 0, reason: 'fully_depreciated' };

  const remainingLife = Number(usefulLifeMonths) - Number(monthsAlreadyDepreciated);
  if (!Number.isFinite(remainingLife) || remainingLife <= 0) {
    // Past its estimated life but still carrying value -- take the remainder now rather than
    // depreciating forever or, worse, dividing by zero and writing NaN into the ledger.
    return { amount: remainingValue, base, remainingLifeMonths: 0, reason: 'life_exhausted_remainder' };
  }
  if (remainingLife === 1) return { amount: remainingValue, base, remainingLifeMonths: 1, reason: 'final_month' };

  const raw = money(remainingValue / remainingLife);
  return { amount: Math.min(raw, remainingValue), base, remainingLifeMonths: remainingLife, reason: 'straight_line' };
}

// Every asset that should appear on the depreciation run for `period`, with the figures needed to
// depreciate it. Ordering is stable so a run and its re-run list assets identically.
//
// Eligibility, and why each clause is here:
//   - capitalised, and in a class flagged depreciable  -> Land is never depreciated
//   - in service on or before the END of the period    -> an asset bought in September does not
//                                                          depreciate in August
//   - not disposed before the START of the period      -> an asset sold in September still takes
//                                                          September's depreciation, which is the
//                                                          usual convention and keeps the gain
//                                                          calculation honest
//   - no posted line for this same period              -> the guard against depreciating twice
async function eligibleAssets(period, conn = null) {
  const start = periodStart(period);
  const q = db(conn);
  const [rows] = await q.query(
    `SELECT a.id, a.reference_no, a.salvage_value, a.useful_life_months, a.in_service_date,
            a.depreciation_method, a.asset_class_id,
            ai.display_name AS item_name,
            c.name AS class_name, c.is_depreciable, c.default_useful_life_months,
            c.depreciation_expense_account_id, c.accumulated_depreciation_account_id,
            ea.account_code AS expense_account_code, ea.account_name AS expense_account_name,
            aa.account_code AS accumulated_account_code, aa.account_name AS accumulated_account_name,
            (SELECT COALESCE(SUM(cl.amount), 0) FROM asset_cost_lines cl WHERE cl.asset_id = a.id) AS capitalized_cost
       FROM assets a
       JOIN asset_classes c ON c.id = a.asset_class_id
       LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
       LEFT JOIN chart_of_accounts ea ON ea.id = c.depreciation_expense_account_id
       LEFT JOIN chart_of_accounts aa ON aa.id = c.accumulated_depreciation_account_id
      WHERE a.is_capitalized = TRUE
        AND c.is_depreciable = TRUE
        AND a.in_service_date IS NOT NULL
        AND a.in_service_date < DATE_ADD(?, INTERVAL 1 MONTH)
        AND NOT EXISTS (
              SELECT 1 FROM asset_disposals d
               WHERE d.asset_id = a.id AND d.status = 'posted' AND d.disposal_date < ?
            )
        AND NOT EXISTS (
              SELECT 1 FROM asset_depreciation_lines l
                JOIN asset_depreciation_runs r ON r.id = l.run_id
               WHERE l.asset_id = a.id AND r.status = 'posted' AND r.period_month = ?
            )
      ORDER BY c.name, ai.display_name, a.reference_no`,
    [start, start, start],
  );

  const out = [];
  for (const a of rows) {
    const opening = await accumulatedDepreciation(a.id, { beforePeriod: start, conn });
    const months = await depreciatedMonths(a.id, { beforePeriod: start, conn });
    const life = Number(a.useful_life_months) || Number(a.default_useful_life_months) || 0;

    const calc = straightLineMonthly({
      capitalizedCost: a.capitalized_cost,
      salvageValue: a.salvage_value,
      usefulLifeMonths: life,
      openingAccumulated: opening,
      monthsAlreadyDepreciated: months,
    });
    if (calc.amount <= 0) continue; // fully depreciated, or nothing left to take

    out.push({
      ...a,
      capitalized_cost: money(a.capitalized_cost),
      useful_life_months: life,
      depreciable_base: calc.base,
      opening_accumulated: opening,
      amount: money(calc.amount),
      closing_accumulated: money(opening + calc.amount),
      remaining_life_months: calc.remainingLifeMonths,
      basis: calc.reason,
    });
  }
  return out;
}

// Cost, accumulated depreciation and net book value for one asset -- as of now, or as at the end
// of the month containing `asOf`.
async function assetValuation(assetId, { asOf = null, conn = null } = {}) {
  const cost = await capitalizedCost(assetId, conn);
  const accumulated = await accumulatedDepreciation(assetId, { throughPeriod: asOf, conn });
  return { capitalized_cost: cost, accumulated_depreciation: accumulated, net_book_value: money(cost - accumulated) };
}

module.exports = {
  STRAIGHT_LINE,
  money,
  periodStart,
  monthsBetween,
  capitalizedCost,
  accumulatedDepreciation,
  depreciatedMonths,
  straightLineMonthly,
  eligibleAssets,
  assetValuation,
};
