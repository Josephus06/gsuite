// Put a rework job order's (RWIP / RFQC) material lines back into the MOTHER job order's UOM, and
// recompute their Total (asked 2026-10-08). RWIP-1289 had its lines in SQFT where its mother
// JO-193492-1-1 had them in MM, so 2475 x 980 was read as square feet: Total 2,425,500.
//
// Each line takes the mother's UOM for the same item, else for the same process (a rework that
// swapped gloss film for matte is still the same lamination). Total = Qty x size, where size is
// Length x Width converted from that UOM into the item's own unit -- the same rule the Edit form
// uses (shared/costing.js, repeated here because the server cannot load that ES module).
//
//   node src/db/fix-rework-uom.js RWIP-1289            # preview
//   node src/db/fix-rework-uom.js RWIP-1289 --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const JO_NO = process.argv.slice(2).find((a) => !a.startsWith('--'));
const LENGTH_UNIT_TO_FEET = { FT: 1, LFT: 1, IN: 1 / 12, LINCH: 1 / 12, MM: 0.00328084, CM: 0.0328084, MTR: 3.28084, M: 3.28084, LMTR: 3.28084, YD: 3 };
const AREA_UNIT_TO_SQFT = { SQFT: 1, SQTF: 1, SQM: 10.7639 };
const num = (v) => (v == null || v === '' ? 0 : Number(v));

function size(line, uom) {
  if (line.is_length_based && line.is_width_based && num(line.length) > 0 && num(line.width) > 0) {
    const f = LENGTH_UNIT_TO_FEET[uom] ?? 1;
    return (num(line.length) * f) * (num(line.width) * f) / (AREA_UNIT_TO_SQFT[line.base_unit_code] ?? 1);
  }
  if (line.is_length_based && !line.is_width_based && num(line.length) > 0) {
    return (num(line.length) * (LENGTH_UNIT_TO_FEET[uom] ?? 1)) / (LENGTH_UNIT_TO_FEET[line.base_unit_code] ?? 1);
  }
  return 1;
}

(async () => {
  if (!JO_NO) throw new Error('Give the rework job order number, e.g. RWIP-1289');
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [[jo]] = await pool.query('SELECT id, job_order_no, parent_job_order_id FROM job_orders WHERE job_order_no = ?', [JO_NO]);
  if (!jo) throw new Error(`${JO_NO} not found`);
  if (!jo.parent_job_order_id) throw new Error(`${JO_NO} is not a rework job order`);
  const lineSql = `SELECT p.id, p.line_no, p.item_id, p.process_id, p.length, p.width, p.uom, p.qty, p.total,
                          i.display_name, i.is_length_based, i.is_width_based, u.code AS base_unit_code
                     FROM job_order_processes p
                     LEFT JOIN inventories i ON i.id = p.item_id
                     LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
                    WHERE p.job_order_id = ? ORDER BY p.line_no`;
  const [mother] = await pool.query(lineSql, [jo.parent_job_order_id]);
  const [lines] = await pool.query(lineSql, [jo.id]);
  let changed = 0;
  for (const l of lines) {
    const m = mother.find((x) => x.item_id && x.item_id === l.item_id && x.uom)
      || mother.find((x) => x.process_id && x.process_id === l.process_id && x.uom);
    if (!m || m.uom === l.uom) { console.log(`  line ${l.line_no} ${l.display_name}: ${m ? 'already ' + l.uom : 'no matching mother line'} -- left`); continue; }
    const total = Number((size(l, m.uom) * num(l.qty)).toFixed(4));
    console.log(`  line ${l.line_no} ${l.display_name}: UOM ${l.uom} -> ${m.uom}, Total ${num(l.total)} -> ${total}`);
    changed += 1;
    if (APPLY) await pool.query('UPDATE job_order_processes SET uom = ?, total = ? WHERE id = ?', [m.uom, total, l.id]);
  }
  console.log(`${APPLY ? 'Updated' : 'Would update'} ${changed} line(s).`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
