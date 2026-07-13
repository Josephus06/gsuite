// Cost-plus pricing formulas reverse-engineered from the live GraphicStar site's
// `/api/get_costing` (process) and `/api/get_inventories` (material) responses.
// See the plan notes for the verified example numbers these were checked against.

function num(v) {
  return v === null || v === undefined || v === '' ? 0 : Number(v);
}

// Linear-unit codes (from an item's own Unit of Measures list) converted to feet, and
// area-unit codes converted to square feet -- lets a process line's Length/Width be
// entered in whatever unit the selected UOM represents (e.g. meters) even though the
// item itself is priced by a different area unit (almost always Square Foot in the real
// catalog -- SQFT/SQTF cover 496 of 496 length+width-based items).
const LENGTH_UNIT_TO_FEET = { FT: 1, LFT: 1, IN: 1 / 12, LINCH: 1 / 12, MM: 0.00328084, CM: 0.0328084, MTR: 3.28084, M: 3.28084, LMTR: 3.28084, YD: 3 };
const AREA_UNIT_TO_SQFT = { SQFT: 1, SQTF: 1, SQM: 10.7639 };

// Converts a Length x Width entered in `uom` into the item's own base-unit area (e.g.
// Square Foot), so a 5x6 line entered in meters against a Square-Foot-priced tarpaulin
// comes out as ~322.92 sqft, not a raw (and wrong) 5x6=30. Unrecognized/blank units pass
// through unconverted (factor 1), matching the pre-conversion behavior for items whose
// Length/Width are already entered in the item's native unit.
export function convertAreaToBaseUnit(length, width, uom, baseUnitCode) {
  const lengthFactor = LENGTH_UNIT_TO_FEET[uom] ?? 1;
  const areaSqft = (num(length) * lengthFactor) * (num(width) * lengthFactor);
  const areaFactor = AREA_UNIT_TO_SQFT[baseUnitCode] ?? 1;
  return areaSqft / areaFactor;
}

// A process's cost is banded by quantity -- find the bracket whose range contains qty.
export function selectBracket(brackets, qty) {
  if (!brackets?.length) return null;
  const q = num(qty);
  return brackets.find((b) => q >= num(b.qty_min) && q <= num(b.qty_max)) || null;
}

// Per-unit process cost/price for a given bracket.
// costPerUnit = COGS only (before OPEX). pricePerUnit = COGS + OPEX, rounded up to a
// whole peso (matches every real sample: e.g. 5.47 -> 6.00) unless a manual
// selling_price_override is set on the bracket.
// costBasis = SubTotal MOH + Sub Con -- the true production cost with no markup or OPEX
// layered in, used for GP-rate reporting (as opposed to costPerUnit/TotalCOGS, which
// already has markup_cogs_pct baked in and so overstates "cost").
export function computeProcessCosting(bracket) {
  if (!bracket) return null;
  const subtotalMoh = num(bracket.click_charge) + num(bracket.ink_cost) + num(bracket.direct_labor)
    + num(bracket.moh_power_equipment) + num(bracket.moh_depreciation) + num(bracket.moh_repairs_maintenance)
    + num(bracket.moh_indirect_materials) + num(bracket.moh_indirect_labor) + num(bracket.other_charges);
  const subCon = num(bracket.sub_con);
  const costBasis = subtotalMoh + subCon;
  const costingAllowance = subtotalMoh * num(bracket.costing_allowance_pct) / 100;
  const subtotalAllowance = subtotalMoh + costingAllowance;
  const markupCogs = subtotalAllowance * num(bracket.markup_cogs_pct) / 100;
  const costPerUnit = subtotalAllowance + markupCogs; // TotalCOGS
  const opexAdmin = subtotalAllowance * num(bracket.opex_admin_pct) / 100;
  const opexSelling = subtotalAllowance * num(bracket.opex_selling_pct) / 100;
  const priceUnrounded = costPerUnit + opexAdmin + opexSelling;
  const pricePerUnit = bracket.selling_price_override != null && bracket.selling_price_override !== ''
    ? num(bracket.selling_price_override)
    : Math.ceil(priceUnrounded);
  return { subtotalMoh, subCon, costBasis, subtotalAllowance, costPerUnit, priceUnrounded, pricePerUnit };
}

// Per-unit material cost/price for an inventory item (no quantity bands).
// costPerUnit includes wastage allowance (a real cost); pricePerUnit adds markup and
// rounds up to a whole peso, matching every real sample.
export function computeMaterialCosting(inventory) {
  if (!inventory) return null;
  const baseCost = num(inventory.material_cost);
  const wastage = baseCost * num(inventory.wastage_allowance_pct) / 100;
  const costPerUnit = baseCost + wastage; // Subtotal
  const markup = costPerUnit * num(inventory.markup_pct) / 100;
  const priceUnrounded = costPerUnit + markup;
  const pricePerUnit = inventory.selling_price != null && inventory.selling_price !== ''
    ? num(inventory.selling_price)
    : Math.ceil(priceUnrounded);
  return { baseCost, wastage, costPerUnit, priceUnrounded, pricePerUnit };
}

// Ties process + material costing together for one estimate process line. Mirrors the
// real site's own column layout (Process | Process Qty | Process UOM | Item | Length |
// Width | UOM | Qty | Total | Unit | Process Price | ...) -- Process Qty and material
// Qty are two independent numbers, not the same field:
//
// - Process cost/price is driven by `processQty` (falls back to `qty` if that's the
//   only one filled in, since a line with a single quantity most likely means the same
//   count for both): bracket matched by `processQty`, per-unit rate x processQty.
// - Material cost/price is driven by the material's own `qty`, further scaled by area
//   (length x width, converted into the item's own base unit via `uom` -- see
//   convertAreaToBaseUnit) when the selected inventory item is flagged
//   is_length_based && is_width_based -- material usage scales with area even though
//   process labor is priced per piece. `total` = qty x area, matching the real site's
//   "Total" column.
//
// process_cost/process_price and material_cost/material_price are each the EXTENDED
// (already qty-multiplied) amount for this line -- not per-unit rates -- so that
// total_cost = process_cost + material_cost and total_price = process_price +
// material_price are plain sums, and each column reflects the actual peso amount for
// the quantity entered rather than a rate the reader has to multiply themselves.
//
// process_cost and material_cost are true production cost, not price, and are
// deliberately sourced from different figures than process_price/material_price:
// - process_cost = (SubTotal MOH + Sub Con) x procQuantity -- the Process Costing tab's
//   own bracket fields, with no COGS markup or OPEX layered in (unlike process_price,
//   which is the full COGS+OPEX selling rate).
// - material_cost = Average Cost (Base Cost) x area x matQuantity -- the inventory's
//   real weighted-average purchase cost normalized to its base unit via
//   conversion_factor. This is intentionally NOT the same field material_price is
//   derived from (Material Cost (Base Cost), the separate sales-pricing basis) -- Average
//   Cost is what the material actually costs; Material Cost is what its price is built on.
//
// discAmount (process_disc_amount) and materialDiscAmount (material_disc_amount) are the
// only other user-entered numbers this touches, mirroring each other:
// disc_process_price = process_price - discAmount, disc_material_price = material_price -
// materialDiscAmount -- the discounted amounts (not the raw ones) are what flow into
// total_price/gross_amount, since a discount on either line should actually reduce what's
// charged. tax_amount is a flat 12% VAT on net_of_tax, and gross_amount = net_of_tax +
// tax_amount (the tax-inclusive amount the customer actually pays; total_price stays
// tax-exclusive, matching net_of_tax, since cost/margin figures should compare against
// the pre-tax price). gp_rate is the resulting margin: (net_of_tax - total_cost) / net_of_tax.
export function computeAutoPricing({ brackets, inventory, processQty, qty, length, width, uom, discAmount, materialDiscAmount }) {
  const procQuantity = num(processQty) || num(qty) || 0;
  const matQuantity = num(qty) || 0;
  const area = (inventory?.is_length_based && inventory?.is_width_based && num(length) > 0 && num(width) > 0)
    ? convertAreaToBaseUnit(length, width, uom, inventory.base_unit_code)
    : 1;

  const bracket = selectBracket(brackets, procQuantity);
  const proc = computeProcessCosting(bracket);
  const mat = computeMaterialCosting(inventory);
  const avgCostBase = inventory ? num(inventory.average_cost) / (num(inventory.conversion_factor) || 1) : null;

  const process_cost = proc ? Number((proc.costBasis * procQuantity).toFixed(2)) : null;
  const process_price = proc ? Number((proc.pricePerUnit * procQuantity).toFixed(2)) : null;
  const material_cost = inventory ? Number((avgCostBase * area * matQuantity).toFixed(2)) : null;
  const material_price = mat ? Number((mat.pricePerUnit * area * matQuantity).toFixed(2)) : null;

  const disc_process_price = process_price != null ? Number((process_price - num(discAmount)).toFixed(2)) : null;
  const disc_material_price = material_price != null ? Number((material_price - num(materialDiscAmount)).toFixed(2)) : null;
  const net_of_tax = (disc_process_price != null || disc_material_price != null)
    ? Number(((disc_process_price || 0) + (disc_material_price || 0)).toFixed(2))
    : null;
  const tax_amount = net_of_tax != null ? Number((net_of_tax * 0.12).toFixed(2)) : null;

  const total_cost = (process_cost != null || material_cost != null)
    ? Number(((process_cost || 0) + (material_cost || 0)).toFixed(2))
    : null;
  const total_price = (disc_process_price != null || disc_material_price != null)
    ? Number(((disc_process_price ?? process_price ?? 0) + (disc_material_price ?? material_price ?? 0)).toFixed(2))
    : null;
  const gp_rate = net_of_tax ? Number((((net_of_tax - (total_cost || 0)) / net_of_tax) * 100).toFixed(2)) : null;
  const gross_amount = net_of_tax != null ? Number((net_of_tax + (tax_amount || 0)).toFixed(2)) : null;

  return {
    process_cost, process_price, material_cost, material_price,
    disc_process_price, disc_material_price, net_of_tax, tax_amount,
    total_cost, total_price, gp_rate, gross_amount,
    total: area !== 1 ? Number((area * matQuantity).toFixed(4)) : matQuantity,
  };
}
