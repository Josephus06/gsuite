// Import named source Estimates with their full detail (job lines, processes/materials, customer,
// contact, rep), through the same importOneEstimate the app's own estimate sync uses. Estimates
// already in T1S are skipped, so it is safe to re-run.
//
// Input: a file of lines "EST-###### <SysPK>" (the key saves a lookup per estimate), or of bare
// numbers, which are looked up.
//
//   node src/db/import-estimates-by-number.js --file=estimates.txt
const fs = require('fs');
const pool = require('../db');
const { login, apiCall, importOneEstimate, freshCache } = require('../lib/liveEstimateSync');
require('dotenv').config();

const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1];
if (!fileArg) { console.error('Usage: --file=path (lines: "EST-123 <SysPK>" or "EST-123")'); process.exit(2); }
const items = fs.readFileSync(fileArg, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [no, pk] = l.split(/\s+/);
  return { no, pk: pk || null };
});
const CONCURRENCY = 3;

async function main() {
  console.log(`${items.length} estimate(s). Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  let token = await login();
  const cache = freshCache();
  const out = { imported: 0, skipped: 0, notFound: 0, failed: [] };
  let cursor = 0, since = 0;
  async function worker() {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= items.length) return;
      const it = items[i];
      if ((since += 1) >= 300) { since = 0; token = await login(); }
      try {
        let pk = it.pk;
        if (!pk) {
          const r = await apiCall(token, 'get_transactions', { where: { UserPK_TransH: it.no, Module_TransH: 'ESTIMATES' }, limit: 1 });
          const row = (Array.isArray(r?.data?.[0]) ? r.data[0] : r?.data || [])[0];
          if (!row) { out.notFound += 1; continue; }
          pk = row.SysPK_TransH;
        }
        const res = await importOneEstimate(cache, token, { est_pk: pk, est_upk: it.no });
        if (res.outcome === 'skipped') out.skipped += 1;
        else if (res.outcome === 'imported' || res.outcome === 'created' || res.estimateId || res.id) out.imported += 1;
        else out.failed.push(`${it.no}: ${JSON.stringify(res).slice(0, 160)}`);
      } catch (e) { out.failed.push(`${it.no}: ${e.message}`); }
      const done = out.imported + out.skipped;
      if (done && done % 100 === 0) console.log(`  ...${out.imported} imported, ${out.skipped} already present`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Imported ${out.imported} | already in T1S ${out.skipped} | not in source ${out.notFound}`);
  if (out.failed.length) console.log(`\nFailed (${out.failed.length}):\n  ` + out.failed.slice(0, 30).join('\n  '));
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
