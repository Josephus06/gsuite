// Sample-type Non-Standard Sales Orders carry sample/allowance amounts the other types don't:
// per line SampleQty / SampleAmount / AllowanceAmount, and header TotalAllowance / TotalSample.
// Lines also link back to the estimate job order they were pulled from (Sample nests to an
// approved Estimate, not a Sales Order). All nullable / default 0 -- ignored by the other types.
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}
async function addCol(table, column, ddl) {
  if (await colExists(table, column)) { console.log(`${table}.${column} exists`); return; }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`Added ${table}.${column}`);
}

(async () => {
  try {
    await addCol('non_standard_sales_order_lines', 'sample_qty', 'sample_qty DECIMAL(16,4) NOT NULL DEFAULT 0');
    await addCol('non_standard_sales_order_lines', 'sample_amount', 'sample_amount DECIMAL(16,2) NOT NULL DEFAULT 0');
    await addCol('non_standard_sales_order_lines', 'allowance_amount', 'allowance_amount DECIMAL(16,2) NOT NULL DEFAULT 0');
    await addCol('non_standard_sales_order_lines', 'source_estimate_job_order_id', 'source_estimate_job_order_id BIGINT NULL');
    await addCol('non_standard_sales_orders', 'total_allowance', 'total_allowance DECIMAL(16,2) NOT NULL DEFAULT 0');
    await addCol('non_standard_sales_orders', 'total_sample', 'total_sample DECIMAL(16,2) NOT NULL DEFAULT 0');
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
