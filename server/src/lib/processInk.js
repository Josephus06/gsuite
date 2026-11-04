// The process Ink Calculation (2026-11-04), as Costing's INK COST workbook works it out (sheets
// INK-052723 / InkData-12Sep'23 / INK.V1-02Jun'23) and the source's process set-up shows it. Mirrored
// in client/src/utils/processInk.js -- keep the two the same. "unit" is the process's UOM (SQFT,
// LI INCH ...): the media usage is measured in it.
//
//   INK WEIGHT        = media weight with print - media weight without print        (gms)
//   INK PER unit      = ink weight / media usage                                     (gms/unit)
//   NET INK WEIGHT    = weight of ink full container - empty container               (gms)
//   INK DENSITY       = net ink weight / ink volume (that container's ml)            (gms/ml)
//   INK USAGE         = ink per unit / ink density                                   (ml/unit)
//   INK PRICE PER ML  = total ink price / total volume -- each ink's own volume, so a 600 ml White
//                       among 700 ml cartridges counts as 600 (INK (2): 37,500 / 6,900)
//   INK COST PER unit = ink usage x ink price per ml
//
// COSTING PRICE is the workbook's MANUAL column: an ink usage and a price per ml Costing sets by
// hand, cost = their product. Left blank, each takes the computed figure rounded to 2 decimals
// (source: 22.20 x 1.73 = 38.41 beside the computed 22.20 x 1.7283 = 38.37).
const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const blank = (v) => v == null || v === '' || Number.isNaN(Number(v));
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

function computeInk(p, inks) {
  const list = inks || [];
  const inkWeight = n(p.ink_media_weight_w_print) - n(p.ink_media_weight_wo_print);
  const inkPerUnit = n(p.ink_media_usage) ? inkWeight / n(p.ink_media_usage) : 0;
  const netInkWeight = n(p.ink_weight_full) - n(p.ink_weight_empty);
  const density = n(p.ink_volume) ? netInkWeight / n(p.ink_volume) : 0;
  const inkUsage = density ? inkPerUnit / density : 0;
  const totalPrice = list.reduce((s, i) => s + n(i.ink_price), 0);
  const volumeOf = (i) => (blank(i.volume_ml) ? n(p.ink_volume) : n(i.volume_ml));
  const totalVolume = list.reduce((s, i) => s + volumeOf(i), 0);
  const perMl = totalVolume ? totalPrice / totalVolume : 0;
  const usageCosting = blank(p.ink_usage_costing) ? r2(inkUsage) : n(p.ink_usage_costing);
  const perMlCosting = blank(p.ink_price_per_ml_costing) ? r2(perMl) : n(p.ink_price_per_ml_costing);
  return {
    inkWeight, inkPerUnit, netInkWeight, density, inkUsage, totalPrice, totalVolume, perMl, volumeOf,
    costPerUnit: inkUsage * perMl,
    usageCosting, perMlCosting, costPerUnitCosting: usageCosting * perMlCosting,
  };
}

module.exports = { computeInk, r2 };
