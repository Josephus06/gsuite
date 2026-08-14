// Propagates item / location / department from purchase order lines onto the receiving report
// and vendor bill lines that came from them.
//
// Those two share the purchase order's problem: 20,123 receiving report lines and 19,780
// vendor bill lines sit on the MISC-PO placeholder rather than the real item, and location is
// null on 35,701 and 35,097 of them respectively (department on 35,098 vendor bill lines).
//
// WHY SQL AND NOT THE API. Every receiving report line and vendor bill line already carries
// purchase_order_line_id -- 35,704 of 35,704 and 35,099 of 35,099. Checking live directly,
// 71 of 71 sampled lines had item, location and department IDENTICAL to the purchase order
// line they came from, with none differing. So the values are inherited, and reading them
// back from live would mean roughly 78,000 API calls to learn what a join already knows.
//
// MUST RUN AFTER backfill-po-line-item-location-department.js, which is what puts the correct
// values on the purchase order lines in the first place. Running it before would faithfully
// copy the placeholder.
//
// Only fills what is empty, and only replaces an item that is still the MISC-PO placeholder,
// so a line that resolved properly on its own is never overwritten. IDEMPOTENT.
//
//   node src/db/backfill-rr-vb-line-item-location-department.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[misc]] = await pool.query("SELECT id FROM inventories WHERE item_code = 'MISC-PO' LIMIT 1");
  const miscId = misc?.id || null;
  if (!miscId) console.log('No MISC-PO placeholder found -- item replacement will only fill nulls.');

  const report = async (label, sql, params = []) => {
    const [r] = await pool.query(sql, params);
    console.log(`  ${label}: ${r.affectedRows}`);
    return r.affectedRows;
  };

  console.log('\nReceiving report lines (no department column on this table):');
  await report('item', `
    UPDATE purchase_order_receipt_lines rl
      JOIN purchase_order_lines pl ON pl.id = rl.purchase_order_line_id
       SET rl.item_id = pl.item_id
     WHERE pl.item_id IS NOT NULL
       AND (rl.item_id IS NULL OR rl.item_id = ?)
       AND pl.item_id <> ?`, [miscId, miscId]);
  await report('location', `
    UPDATE purchase_order_receipt_lines rl
      JOIN purchase_order_lines pl ON pl.id = rl.purchase_order_line_id
       SET rl.location_id = pl.location_id
     WHERE pl.location_id IS NOT NULL AND rl.location_id IS NULL`);

  console.log('\nVendor bill lines:');
  await report('item', `
    UPDATE vendor_bill_lines vl
      JOIN purchase_order_lines pl ON pl.id = vl.purchase_order_line_id
       SET vl.item_id = pl.item_id
     WHERE pl.item_id IS NOT NULL
       AND (vl.item_id IS NULL OR vl.item_id = ?)
       AND pl.item_id <> ?`, [miscId, miscId]);
  await report('location', `
    UPDATE vendor_bill_lines vl
      JOIN purchase_order_lines pl ON pl.id = vl.purchase_order_line_id
       SET vl.location_id = pl.location_id
     WHERE pl.location_id IS NOT NULL AND vl.location_id IS NULL`);
  await report('department', `
    UPDATE vendor_bill_lines vl
      JOIN purchase_order_lines pl ON pl.id = vl.purchase_order_line_id
       SET vl.department_id = pl.department_id
     WHERE pl.department_id IS NOT NULL AND vl.department_id IS NULL`);

  const [[rr]] = await pool.query(`
    SELECT COUNT(*) AS n, SUM(location_id IS NULL) AS nl,
           SUM(item_id = ?) AS misc FROM purchase_order_receipt_lines`, [miscId]);
  const [[vb]] = await pool.query(`
    SELECT COUNT(*) AS n, SUM(location_id IS NULL) AS nl, SUM(department_id IS NULL) AS nd,
           SUM(item_id = ?) AS misc FROM vendor_bill_lines`, [miscId]);
  console.log(`\nReceiving report lines: ${rr.n} | still no location: ${rr.nl} | still MISC-PO: ${rr.misc}`);
  console.log(`Vendor bill lines:      ${vb.n} | still no location: ${vb.nl} | no department: ${vb.nd} | still MISC-PO: ${vb.misc}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
