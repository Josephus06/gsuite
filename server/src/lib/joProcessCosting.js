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
// UNITS. Job order lines are typed freely -- 'mm' in lower case, 'SQFT' as the unit of a length --
// where the estimate picks from a list. The shared formula reads only exact upper-case length codes
// and passes anything else through UNCONVERTED, which on a size-priced item turns a 1050 x 1050 mm
// cut of Sintraboard into 1,102,500 square feet (20.9M of material). So the unit is normalised
// first, and a size-priced item whose size unit (or own base unit) still cannot be read is left
// UNCOSTED with a reason, never given a figure that may be off by a factor of a million.
//
//   const c = await costProcessLine(conn, line)
//   // { process_cost, material_cost, total_cost, needs_check: null | 'why it was not costed' }

const COST_FIELDS = ['process_id', 'item_id', 'process_qty', 'qty', 'length', 'width', 'uom'];

const UOM_ALIASES = {
  MILLIMETER: 'MM', MILLIMETERS: 'MM', MILIMETER: 'MM', CENTIMETER: 'CM', CENTIMETERS: 'CM',
  INCH: 'IN', INCHES: 'IN', INS: 'IN', '"': 'IN', FEET: 'FT', FOOT: 'FT', "'": 'FT',
  METER: 'M', METERS: 'M', MTRS: 'M', MTR: 'MTR', YARD: 'YD', YARDS: 'YD',
};
const normUom = (u) => {
  const s = String(u || '').trim().toUpperCase().replace(/\.$/, '');
  return UOM_ALIASES[s] || s;
};

async function costProcessLine(q, line) {
  const { computeAutoPricing, LENGTH_UNIT_TO_FEET, AREA_UNIT_TO_SQFT } = await costing();
  const none = (why) => ({ process_cost: null, material_cost: null, total_cost: null, needs_check: why });
  const [brackets] = line.process_id
    ? await q.query('SELECT * FROM process_cost_brackets WHERE process_id = ? AND is_active = 1 ORDER BY qty_min', [line.process_id])
    : [[]];
  const [[inventory]] = line.item_id
    ? await q.query(
      `SELECT i.*, u.code AS base_unit_code FROM inventories i
         LEFT JOIN units_of_measure u ON u.id = i.base_unit_id WHERE i.id = ?`, [line.item_id])
    : [[null]];

  const uom = normUom(line.uom);
  if (inventory) inventory.base_unit_code = normUom(inventory.base_unit_code);
  // A size-priced item with a size given: both the size's unit and the item's own unit must be ones
  // the formula converts, or the material figure is meaningless.
  const sized = inventory && inventory.is_length_based && Number(line.length) > 0;
  if (sized) {
    if (!(uom in LENGTH_UNIT_TO_FEET)) return none(`size unit "${line.uom || ''}" is not a length unit`);
    const base = inventory.base_unit_code;
    const baseOk = inventory.is_width_based ? base in AREA_UNIT_TO_SQFT : base in LENGTH_UNIT_TO_FEET;
    if (!baseOk) return none(`item's unit "${base || ''}" is not a ${inventory.is_width_based ? 'square' : 'length'} unit`);
  }

  const c = computeAutoPricing({
    brackets, inventory: inventory || null,
    processQty: line.process_qty, qty: line.qty, length: line.length, width: line.width, uom,
  }) || {};
  return { process_cost: c.process_cost ?? null, material_cost: c.material_cost ?? null, total_cost: c.total_cost ?? null, needs_check: null };
}

// Does an edit to a line touch anything its cost depends on?
function costInputsChanged(before, after) {
  const norm = (v) => (v === null || v === undefined || v === '' ? '' : String(Number.isFinite(Number(v)) ? Number(v) : v));
  return COST_FIELDS.some((f) => after[f] !== undefined && norm(before[f]) !== norm(after[f]));
}

// Costs every line of a job order that has no cost yet (total_cost NULL). Called once a job
// order's lines are written; a line copied over WITH its cost keeps it, and one that cannot be
// costed safely (needs_check) stays NULL.
async function costMissingLines(q, jobOrderId) {
  const [lines] = await q.query(
    `SELECT id, ${COST_FIELDS.join(', ')} FROM job_order_processes WHERE job_order_id = ? AND total_cost IS NULL`, [jobOrderId]);
  for (const l of lines) {
    const c = await costProcessLine(q, l);
    if (c.needs_check) continue;
    await q.query('UPDATE job_order_processes SET process_cost = ?, material_cost = ?, total_cost = ? WHERE id = ?',
      [c.process_cost, c.material_cost, c.total_cost, l.id]);
  }
  return lines.length;
}

module.exports = { costProcessLine, costInputsChanged, costMissingLines, COST_FIELDS, normUom };
