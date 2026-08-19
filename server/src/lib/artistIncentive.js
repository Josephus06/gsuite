// The artist incentive, in one place. It is worked out in two unrelated ways depending on
// the document, and both the Artist Incentive report and the Assigned JO worklist have to
// show the same figure -- a second copy of these rules is how the report and the artist's
// own list end up quoting different numbers for the same job.

// A Job Order earns a flat 7.50 per unit of layout work -- NOT a percentage. It has no
// per-line price to take a percentage of (its process lines record process_cost only, and
// its layout is described by a PMS Job Type carrying minutes, not pesos), so the incentive
// is a fixed amount rather than a rate.
//
// Scaled by layout_qty -- the number of files/designs the artist laid out -- because that is
// how the rest of the system measures the same effort (planned end = the layout job type's
// minutes_consume x layout_qty). layout_qty defaults to 1, so for the ordinary single-layout
// job this is simply 7.50 per Job Order.
const JO_INCENTIVE_AMOUNT = 7.5;

// A Non-Standard Job Order carries its incentive per materials line, worked out when the
// order was saved (5% of that line's Process Price -- ARTIST_INCENTIVE_RATE in
// nonStandardJobOrders.js). Reading the stored figure rather than recomputing means a later
// change to the rate cannot restate what past work already earned.
const NSTDJO_INCENTIVE_RATE = 0.05;

const joLayoutQty = (alias = 'jo') => `COALESCE(NULLIF(${alias}.layout_qty, 0), 1)`;

const jobOrderIncentiveExpression = (alias = 'jo') =>
  `ROUND(${JO_INCENTIVE_AMOUNT} * ${joLayoutQty(alias)}, 2)`;

const nstdjoIncentiveExpression = (alias = 'n') =>
  `ROUND(COALESCE((SELECT SUM(m.artist_incentive) FROM non_standard_job_order_materials m
                    WHERE m.non_standard_job_order_id = ${alias}.id), 0), 2)`;

// What the figure is made of, for display next to the amount -- an artist looking at "15.00"
// should be able to see why it is 15 without opening the report.
// layout_qty is a DECIMAL, so concatenating it straight renders "7.50 x 1.0000". The
// trailing zeros (and then a bare trailing point) are trimmed so a whole quantity reads
// "7.50 x 1" while a genuine fraction still shows as "7.50 x 1.5".
const joIncentiveBasis = (alias = 'jo') =>
  `CONCAT('${JO_INCENTIVE_AMOUNT.toFixed(2)} x ',
          TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM ${joLayoutQty(alias)})))`;
const NSTDJO_INCENTIVE_BASIS = `${(NSTDJO_INCENTIVE_RATE * 100).toFixed(0)}% per line`;

module.exports = {
  JO_INCENTIVE_AMOUNT,
  NSTDJO_INCENTIVE_RATE,
  NSTDJO_INCENTIVE_BASIS,
  jobOrderIncentiveExpression,
  nstdjoIncentiveExpression,
  joIncentiveBasis,
};
