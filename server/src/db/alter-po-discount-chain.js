// Purchase Order lines can carry a chain of discounts -- "10;5" is 10% off, then 5% off what is
// left (lib/discountChain.js). The chain as typed is kept in disc_formula for the screens; the one
// percent it comes to (14.5% for 10;5) stays in disc_percent, which every receipt, return, bill
// and GL posting already reads, so none of them changes.
//
// disc_percent was DECIMAL(5,2). A chain rarely lands on two decimals -- 10;5;3 is 17.065% -- and
// rounding it there would put receipts and bills a centavo or more off the PO. Widened to (9,6)
// on the PO line and on the lines that copy it; widening keeps every stored value as it is.
const pool = require('../db');

async function colType(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows[0]?.Type || null;
}

(async () => {
  try {
    if (!(await colType('purchase_order_lines', 'disc_formula'))) {
      await pool.query('ALTER TABLE purchase_order_lines ADD COLUMN disc_formula VARCHAR(60) NULL AFTER disc_percent');
      console.log('Added purchase_order_lines.disc_formula');
    } else console.log('purchase_order_lines.disc_formula exists');

    for (const table of ['purchase_order_lines', 'purchase_order_receipt_lines', 'purchase_return_lines', 'vendor_bill_lines']) {
      const type = await colType(table, 'disc_percent');
      if (!type) { console.log(`${table}.disc_percent missing -- skipped`); continue; }
      if (/decimal\(9,6\)/i.test(type)) { console.log(`${table}.disc_percent already ${type}`); continue; }
      await pool.query(`ALTER TABLE ${table} MODIFY disc_percent DECIMAL(9,6) NULL DEFAULT 0`);
      console.log(`Widened ${table}.disc_percent ${type} -> decimal(9,6)`);
    }
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
