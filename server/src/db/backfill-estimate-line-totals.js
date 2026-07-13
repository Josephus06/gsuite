// One-off backfill: fixes the ~1360 estimate_job_order_processes rows created by the
// live-estimate imports (liveEstimateSync.js / import-target-estimates.js) before they
// knew to compute `total` correctly, and the inventories.is_length_based/is_width_based
// flags those imports never set on already-existing items.
//
// Root cause: the import scripts wrote the live API's own `Total_LdgrInvty` field into
// the `total` column, assuming it was the line's area-based quantity total. Direct
// inspection of the live get_transaction response showed Total_LdgrInvty is always
// "0.0000000000" on every ESTIMATES line -- the real system's own displayed "Total"
// column is actually CLIENT-COMPUTED (qty x area), not read from that field at all.
// Confirmed against a real rendered example: 8.3in x 11.7in -> 0.674375 sqft x qty 2 =
// 1.34875, exactly matching the real UI's displayed Total.
//
// This entirely reuses local data (no need to re-fetch every estimate transaction):
// 1. Pull the full live inventory catalog once (paginated) to get each item's real
//    IsLength_Invty/IsWidth_Invty flags, and backfill those onto matching local
//    `inventories` rows (matched by item_code == UserPK_Invty, the same key the import
//    scripts already use).
// 2. Recompute `total` for every estimate_job_order_processes row from its own already-
//    correct length/width/uom/qty columns plus the item's now-correct flags -- the exact
//    same formula as client/src/utils/costing.js's computeAutoPricing.
//
// Not part of the running app -- run manually:
//   node src/db/backfill-estimate-line-totals.js
const pool = require('../db');
const { login, apiCall } = require('../lib/liveEstimateSync');
require('dotenv').config();

const LENGTH_UNIT_TO_FEET = { FT: 1, LFT: 1, IN: 1 / 12, LINCH: 1 / 12, MM: 0.00328084, CM: 0.0328084, MTR: 3.28084, M: 3.28084, LMTR: 3.28084, YD: 3 };

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function computeTotal({ qty, length, width, uom, isLengthBased, isWidthBased }) {
  const q = num(qty);
  const isAreaBased = !!isLengthBased && !!isWidthBased && num(length) > 0 && num(width) > 0;
  if (!isAreaBased) return q;
  const lengthFactor = LENGTH_UNIT_TO_FEET[uom] ?? 1;
  const areaSqft = (num(length) * lengthFactor) * (num(width) * lengthFactor);
  return Number((areaSqft * q).toFixed(4));
}

async function main() {
  const token = await login();

  console.log('Fetching live inventory catalog for IsLength/IsWidth flags...');
  const flagsByCode = new Map();
  let offset = 0;
  for (;;) {
    const resp = await apiCall(token, 'get_inventories', { where: {}, limit: 200, offset });
    const batch = resp?.data || [];
    if (!batch.length) break;
    for (const inv of batch) {
      const code = (inv.UserPK_Invty || '').trim();
      if (code) flagsByCode.set(code, { isLength: !!inv.IsLength_Invty, isWidth: !!inv.IsWidth_Invty });
    }
    offset += 200;
    if (batch.length < 200) break;
  }
  console.log(`Fetched flags for ${flagsByCode.size} live inventory items.`);

  console.log('Backfilling inventories.is_length_based/is_width_based...');
  const [localItems] = await pool.query('SELECT id, item_code FROM inventories');
  let itemsUpdated = 0;
  for (const item of localItems) {
    const flags = flagsByCode.get((item.item_code || '').trim());
    if (!flags) continue;
    await pool.query('UPDATE inventories SET is_length_based = ?, is_width_based = ? WHERE id = ?', [flags.isLength, flags.isWidth, item.id]);
    itemsUpdated++;
  }
  console.log(`Updated flags on ${itemsUpdated} local inventory items.`);

  console.log('Recomputing estimate_job_order_processes.total...');
  const [rows] = await pool.query(
    `SELECT p.id, p.qty, p.length, p.width, p.uom, i.is_length_based, i.is_width_based
     FROM estimate_job_order_processes p
     LEFT JOIN inventories i ON i.id = p.item_id`
  );
  let rowsChanged = 0;
  for (const r of rows) {
    const newTotal = computeTotal({
      qty: r.qty, length: r.length, width: r.width, uom: r.uom,
      isLengthBased: r.is_length_based, isWidthBased: r.is_width_based,
    });
    if (Number(r.total) !== newTotal) {
      await pool.query('UPDATE estimate_job_order_processes SET total = ? WHERE id = ?', [newTotal, r.id]);
      rowsChanged++;
    }
  }
  console.log(`Recomputed total on ${rowsChanged} of ${rows.length} process line rows.`);

  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
