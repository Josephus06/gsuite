// One-off script: imports exactly one specific estimate from the live GraphicStar site
// by its SysPK (the UUID in the URL, e.g. pasted straight from
// https://gsuite.graphicstar.com.ph/#/estimate/<SysPK>), regardless of sales rep or
// status -- unlike import-target-estimates.js / liveEstimateSync.js's syncNewEstimates,
// which only pull the narrow parallel-run-test slice. Reuses all the same master-data
// resolution logic from liveEstimateSync.js so a manually-requested one-off import stays
// consistent with the bulk imports.
//
// Not part of the running app -- run manually:
//   node src/db/import-single-estimate.js <SysPK>
const pool = require('../db');
const { login, apiCall, importOneEstimate, freshCache } = require('../lib/liveEstimateSync');
require('dotenv').config();

const sysPk = process.argv[2];
if (!sysPk) {
  console.error('Usage: node src/db/import-single-estimate.js <SysPK>');
  process.exit(1);
}

async function main() {
  const token = await login();

  const resp = await apiCall(token, 'get_transaction', {
    where: { Module_TransH: 'ESTIMATES', SysPK_TransH: sysPk },
    include: ['transaction_customer'],
  });
  const t = resp?.data?.[0];
  if (!t) {
    console.error('No estimate found for that SysPK. Raw response:', JSON.stringify(resp).slice(0, 500));
    process.exit(1);
  }
  console.log(`Found ${t.UserPK_TransH} (${t.transaction_customer?.Name_Cust || 'unknown customer'}), status "${t.Status_TransH}".`);

  const result = await importOneEstimate(freshCache(), token, { est_pk: sysPk, est_upk: t.UserPK_TransH });
  console.log(result);

  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
