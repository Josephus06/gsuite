// One-off: Bill Credits already fully applied but still Open (BC-7431), from before
// lib/billCreditStatus.js kept the status in step with the applied amount. Uses the same rule.
//
//   node src/db/backfill-bill-credit-status.js           # dry run
//   node src/db/backfill-bill-credit-status.js --apply
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const WHERE = "status = 'open' AND total_amount > 0 AND applied_amount >= total_amount - 0.005";

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  const [rows] = await pool.query(`SELECT bill_credit_no FROM bill_credits WHERE ${WHERE} ORDER BY id`);
  console.log(`Open but fully applied: ${rows.length}${rows.length ? ` (e.g. ${rows.slice(0, 10).map((r) => r.bill_credit_no).join(', ')})` : ''}`);
  if (!APPLY || !rows.length) return;
  const [r] = await pool.query(`UPDATE bill_credits SET status = 'fully_applied' WHERE ${WHERE}`);
  console.log(`Set ${r.affectedRows} to Fully Applied.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
