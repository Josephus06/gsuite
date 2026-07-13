// Shared by qualityInspections.js, itemDeliveries.js, and salesInvoices.js -- every
// place that can move a Sales Order's status forward recomputes it fresh from every one
// of its lines, rather than each route guessing its own next-status in isolation.
//
// The core rule: a line that's already fully delivered/invoiced is "done" and doesn't
// drag the order backward -- but a line that hasn't even gotten a Job Order yet (or has
// one still in production, nothing built+QI'd) always wins over a further-along line.
//
// "Partially Delivered" means there's ready stock (built+QI'd) sitting undelivered on
// some line -- an action is owed (ship it). That's different from a line where
// Built === Inspected === Delivered but short of the full ordered qty: nothing produced
// so far is sitting around unshipped, it's just not fully produced yet, so whatever *has*
// shipped is fully billable right now. That's 'pending_billing_partially_delivered' --
// distinct from plain 'pending_billing', which means the *entire* order shipped and is
// just waiting on the invoice.
function computeSalesOrderStatus(lines) {
  let hasAnyJO = false;
  let allFullyInvoiced = true;
  let allFullyDelivered = true;
  let anyNotReady = false;
  let anyPartial = false;
  let anySettledPartial = false;
  let anyReadyUndelivered = false;

  for (const l of lines) {
    const qty = Number(l.quantity || 0);
    if (!l.job_order_id) {
      allFullyInvoiced = false;
      allFullyDelivered = false;
      anyNotReady = true;
      continue;
    }
    hasAnyJO = true;
    const built = Number(l.quantity_built || 0);
    const inspected = Number(l.quantity_inspected || 0);
    const delivered = Number(l.quantity_delivered || 0);
    const invoiced = Number(l.quantity_invoiced || 0);
    const cap = Math.min(built, inspected);

    if (invoiced < qty) allFullyInvoiced = false;
    if (delivered < qty) allFullyDelivered = false;

    if (qty > 0 && delivered >= qty) continue; // this line is finished -- doesn't drag the order backward

    if (cap <= 0) { anyNotReady = true; continue; }

    const readyUndelivered = cap - delivered;
    if (delivered <= 0) { anyReadyUndelivered = true; continue; }
    if (readyUndelivered > 0) { anyPartial = true; continue; }
    anySettledPartial = true; // delivered caught up to everything ready -- just not the full order yet
  }

  if (!hasAnyJO) return 'pending_for_jo';
  if (allFullyInvoiced) return 'billed';
  if (allFullyDelivered) return 'pending_billing';
  if (anyNotReady) return 'jo_in_process';
  if (anyPartial) return 'partially_delivered';
  if (anySettledPartial) return 'pending_billing_partially_delivered';
  if (anyReadyUndelivered) return 'pending_delivery';
  return 'jo_in_process';
}

module.exports = { computeSalesOrderStatus };
