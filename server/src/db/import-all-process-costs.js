// One-off script: pulls the ENTIRE real "Process Costing" data (quantity-bracket cost
// rows) from the live GraphicStar site's JSON API into our local database. Must be run
// AFTER import-all-processes.js, since every costing record is matched to a local
// process by process_code. One `get_costing` detail call per costing record (~1,500),
// so this is slow -- logs progress every 25 records and is resumable (skips any process
// that already has bracket rows). Not part of the running app -- run manually:
//   node src/db/import-all-process-costs.js
const { chromium } = require('playwright');
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph/';
const USERNAME = process.env.LIVE_SITE_USERNAME;
const PASSWORD = process.env.LIVE_SITE_PASSWORD;
const PAGE_SIZE = 200;

if (!USERNAME || !PASSWORD) {
  console.error('Set LIVE_SITE_USERNAME and LIVE_SITE_PASSWORD in server/.env before running this script.');
  process.exit(1);
}

async function apiCall(page, endpoint, body) {
  return page.evaluate(async ({ endpoint, body }) => {
    const res = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    return res.json();
  }, { endpoint, body });
}

function parseRange(range) {
  const [minStr, maxStr] = String(range).trim().split('-');
  return { qtyMin: Number(minStr), qtyMax: Number(maxStr) };
}

async function importBracketsForCosting(page, processId, sysPkCstng) {
  const detail = await apiCall(page, 'get_costing', { pk: sysPkCstng });
  const brackets = detail?.data?.[1] || [];
  let count = 0;
  for (const b of brackets) {
    const { qtyMin, qtyMax } = parseRange(b.Range_CstngL);
    if (Number.isNaN(qtyMin) || Number.isNaN(qtyMax)) continue;
    await pool.query(
      `INSERT INTO process_cost_brackets
         (process_id, qty_min, qty_max, click_charge, ink_cost, direct_labor,
          moh_power_equipment, moh_depreciation, moh_repairs_maintenance,
          moh_indirect_materials, moh_indirect_labor, other_charges,
          costing_allowance_pct, markup_cogs_pct, opex_admin_pct, opex_selling_pct,
          disc_ceiling_pct, disc_supervisor_pct, disc_manager_pct, disc_gm_pct,
          selling_price_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        processId, qtyMin, qtyMax,
        b.ClickCharge_CstngL || 0, b.InkjetCostCalc_CstngL || 0, b.DL_CstngL || 0,
        b.MOHPE_CstngL || 0, b.MOHDC_CstngL || 0, b.MOHRM_CstngL || 0,
        b.MOHIMC_CstngL || 0, b.MOHIL_CstngL || 0, b.OtherCharges_CostingL || 0,
        b.CostingAllowancePrcnt_CstngL || 0, b.MarkUpCOGSPrcnt_CstngL || 0,
        b.OPEXAdminPrcnt_CstngL || 0, b.OPEXSellingPrcnt_CstngL || 0,
        b.DiscCeilingPer_CstngL || 0, b.DCSSPercent_CstngL || 0, b.DCSMPercent_CstngL || 0, b.DCGMPercent_CstngL || 0,
        b.SellingPrice_CstngL || null,
      ]
    );
    count++;
  }
  return count;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const inputs = await page.$$('input');
  await inputs[0].fill(USERNAME);
  await inputs[1].fill(PASSWORD);
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(2500);
  if (page.url().includes('login')) {
    console.error('Login failed.');
    process.exit(1);
  }

  // Build the full local process_code -> id map once.
  const [localProcs] = await pool.query('SELECT id, process_code FROM processes');
  const localByCode = new Map(localProcs.map((p) => [p.process_code, p.id]));
  console.log(`Local processes available to match against: ${localByCode.size}`);

  // Pull every costing stub record (module: Process) across all pages.
  let offset = 0;
  const costingStubs = [];
  for (;;) {
    const resp = await apiCall(page, 'get_costings', { module: 'Process', limit: PAGE_SIZE, offset });
    const [batch, total] = resp?.data || [[], 0];
    if (!batch.length) break;
    costingStubs.push(...batch);
    console.log(`Fetched costing stubs offset=${offset}: ${batch.length} (running total=${costingStubs.length} of ${total})`);
    offset += PAGE_SIZE;
    if (batch.length < PAGE_SIZE) break;
  }
  console.log(`\nTotal costing records on live site: ${costingStubs.length}`);

  let imported = 0;
  let skippedNoLocalProcess = 0;
  let skippedAlreadyHasBrackets = 0;
  let totalBracketRows = 0;

  for (let i = 0; i < costingStubs.length; i++) {
    const stub = costingStubs[i];
    const processId = localByCode.get(stub.UserPK_Proc);
    if (!processId) { skippedNoLocalProcess++; continue; }

    const [[existing]] = await pool.query('SELECT id FROM process_cost_brackets WHERE process_id = ? LIMIT 1', [processId]);
    if (existing) { skippedAlreadyHasBrackets++; continue; }

    const count = await importBracketsForCosting(page, processId, stub.SysPK_Cstng);
    imported++;
    totalBracketRows += count;

    if ((i + 1) % 25 === 0 || i === costingStubs.length - 1) {
      console.log(`[${i + 1}/${costingStubs.length}] processed -- imported=${imported}, bracket rows=${totalBracketRows}, skipped(no local process)=${skippedNoLocalProcess}, skipped(already has brackets)=${skippedAlreadyHasBrackets}`);
    }
  }

  console.log(`\nDone. Costing records imported: ${imported} (${totalBracketRows} bracket rows total).`);
  console.log(`Skipped -- no matching local process: ${skippedNoLocalProcess}; already had brackets: ${skippedAlreadyHasBrackets}.`);

  await browser.close();
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
