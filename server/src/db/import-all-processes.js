// One-off script: pulls the ENTIRE real "Processes" master list from the live
// GraphicStar site's JSON API into our local database (not a representative sample --
// every record). Cost brackets ("Process Costing") are a separate, much slower pass --
// see import-all-process-costs.js -- this script only imports the process header rows.
// Not part of the running app -- run manually:
//   node src/db/import-all-processes.js
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

const unitCache = new Map();
async function ensureUnit(code) {
  const key = code || 'EACH';
  if (unitCache.has(key)) return unitCache.get(key);
  const [[existing]] = await pool.query('SELECT id FROM units_of_measure WHERE code = ?', [key]);
  if (existing) { unitCache.set(key, existing.id); return existing.id; }
  const [result] = await pool.query('INSERT INTO units_of_measure (code, title) VALUES (?, ?)', [key, key]);
  unitCache.set(key, result.insertId);
  console.log(`  + created unit ${key}`);
  return result.insertId;
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

  const [[{ existingCount }]] = await pool.query('SELECT COUNT(*) AS existingCount FROM processes');
  console.log(`Local processes table currently has ${existingCount} rows. Starting full import...`);

  let offset = 0;
  let totalSeen = 0;
  let imported = 0;
  let skipped = 0;

  for (;;) {
    const resp = await apiCall(page, 'get_processes', {
      where: {},
      order: [['Name_Proc', 'ASC']],
      limit: PAGE_SIZE,
      offset,
    });
    const batch = resp?.data || [];
    if (!batch.length) break;

    for (const p of batch) {
      totalSeen++;
      const [[existing]] = await pool.query('SELECT id FROM processes WHERE process_code = ?', [p.UserPK_Proc]);
      if (existing) { skipped++; continue; }

      const unitId = await ensureUnit(p.UOM_Proc);
      await pool.query(
        'INSERT INTO processes (process_code, process_name, base_unit_id, is_active) VALUES (?, ?, ?, ?)',
        [p.UserPK_Proc, p.Name_Proc, unitId, !!p.IsActive_Proc]
      );
      imported++;
    }

    console.log(`Page offset=${offset}: fetched ${batch.length} (running total seen=${totalSeen}, imported=${imported}, skipped-existing=${skipped})`);
    offset += PAGE_SIZE;
    if (batch.length < PAGE_SIZE) break;
  }

  console.log(`\nDone. Seen ${totalSeen} live processes; imported ${imported} new, skipped ${skipped} already-present.`);
  const [[{ finalCount }]] = await pool.query('SELECT COUNT(*) AS finalCount FROM processes');
  console.log(`Local processes table now has ${finalCount} rows.`);

  await browser.close();
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
