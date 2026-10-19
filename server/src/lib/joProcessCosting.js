const { costing } = require('./costing');

// Process Cost / Material Cost / Total Cost for a job order's process line, worked out with the
// same formula the Estimate uses (shared/costing.js computeAutoPricing): the process's active
// Process Costing bracket for the quantity, and the item's average cost for the material.
//
// Why it exists (2026-10-19): a job order from a Sales Order copies these from its estimate, but
// one raised any other way -- from a Non-Standard Sales Order, an RWIP / rework, or a line added on
// the job order itself -- was saved with no cost at all, so every one of the 81 NSJOs made in T1S
// showed a Total Cost of nothing and a GP of 100%.
//
//   const c = await costProcessLine(conn, line)   // { process_cost, material_cost, total_cost }

const COST_FIELDS = ['process_id', 'item_id', 'process_qty', 'qty', 'length', 'width', 'uom'];

async function costProcessLine(q, line) {
  const { computeAutoPricing } = await costing();
  const [brackets] = line.process_id
    ? await q.query('SELECT * FROM process_cost_brackets WHERE process_id = ? AND is_active = 1 ORDER BY qty_min', [line.process_id])
    : [[]];
  const [[inventory]] = line.item_id
    ? await q.query(
      `SELECT i.*, u.code AS base_unit_code FROM inventories i
         LEFT JOIN units_of_measure u ON u.id = i.base_unit_id WHERE i.id = ?`, [line.item_id])
    : [[null]];
  const c = computeAutoPricing({
    brackets, inventory: inventory || null,
    processQty: line.process_qty, qty: line.qty, length: line.length, width: line.width, uom: line.uom,
  }) || {};
  return { process_cost: c.process_cost ?? null, material_cost: c.material_cost ?? null, total_cost: c.total_cost ?? null };
}

// Does an edit to a line touch anything its cost depends on?
function costInputsChanged(before, after) {
  const norm = (v) => (v === null || v === undefined || v === '' ? '' : String(Number.isFinite(Number(v)) ? Number(v) : v));
  return COST_FIELDS.some((f) => after[f] !== undefined && norm(before[f]) !== norm(after[f]));
}

// Costs every line of a job order that has no cost yet (total_cost NULL). Called once a job
// order's lines are written; a line copied over WITH its cost keeps it.
async function costMissingLines(q, jobOrderId) {
  const [lines] = await q.query(
    `SELECT id, ${COST_FIELDS.join(', ')} FROM job_order_processes WHERE job_order_id = ? AND total_cost IS NULL`, [jobOrderId]);
  for (const l of lines) {
    const c = await costProcessLine(q, l);
    await q.query('UPDATE job_order_processes SET process_cost = ?, material_cost = ?, total_cost = ? WHERE id = ?',
      [c.process_cost, c.material_cost, c.total_cost, l.id]);
  }
  return lines.length;
}

module.exports = { costProcessLine, costInputsChanged, costMissingLines, COST_FIELDS };
