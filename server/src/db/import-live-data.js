// One-off script: pulls a representative batch of real Processes (+ their cost
// brackets) and Inventory items (+ their costing fields) from the live GraphicStar
// site's JSON API into our local database, so the Estimate wizard's pricing engine
// has real data to compute against. Not part of the running app -- run manually:
//   node src/db/import-live-data.js
const { chromium } = require('playwright');
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph/';
const USERNAME = process.env.LIVE_SITE_USERNAME;
const PASSWORD = process.env.LIVE_SITE_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Set LIVE_SITE_USERNAME and LIVE_SITE_PASSWORD in server/.env before running this script.');
  process.exit(1);
}

const PROCESS_KEYWORDS = ['CNC', 'BLUEPRINT', 'ASSY', 'CUTT'];
const INVENTORY_KEYWORDS = ['CLAMP', 'OUTLET', 'SWITCH', 'STKR', 'SOFA'];
const BATCH_SIZE_PER_KEYWORD = 10;

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

async function ensureUnit(code) {
  if (!code) code = 'EACH';
  const [[existing]] = await pool.query('SELECT id FROM units_of_measure WHERE code = ?', [code]);
  if (existing) return existing.id;
  const [result] = await pool.query('INSERT INTO units_of_measure (code, title) VALUES (?, ?)', [code, code]);
  console.log(`  + created unit ${code}`);
  return result.insertId;
}

async function ensureCategory(name) {
  if (!name) return null;
  const [[existing]] = await pool.query('SELECT id FROM inventory_categories WHERE name = ?', [name]);
  if (existing) return existing.id;
  const [result] = await pool.query('INSERT INTO inventory_categories (name) VALUES (?)', [name]);
  console.log(`  + created category ${name}`);
  return result.insertId;
}

function parseRange(range) {
  const [minStr, maxStr] = String(range).trim().split('-');
  return { qtyMin: Number(minStr), qtyMax: Number(maxStr) };
}

async function importProcesses(page) {
  const seen = new Set();
  let imported = 0;

  for (const keyword of PROCESS_KEYWORDS) {
    const listResp = await apiCall(page, 'get_processes', {
      where: { search: { fields: ['UserPK_Proc', 'Name_Proc', 'UOM_Proc'], searchKey: keyword }, and: { IsActive_Proc: 1 } },
      order: [['Name_Proc', 'ASC']],
      limit: BATCH_SIZE_PER_KEYWORD,
      offset: 0,
    });
    const procs = listResp?.data || [];
    console.log(`Processes matching "${keyword}": ${procs.length}`);

    for (const p of procs) {
      if (seen.has(p.UserPK_Proc)) continue;
      seen.add(p.UserPK_Proc);

      const [[existing]] = await pool.query('SELECT id FROM processes WHERE process_code = ?', [p.UserPK_Proc]);
      if (existing) { console.log(`  skip (exists) ${p.UserPK_Proc}`); continue; }

      const unitId = await ensureUnit(p.UOM_Proc);
      const [result] = await pool.query(
        'INSERT INTO processes (process_code, process_name, base_unit_id, is_active) VALUES (?, ?, ?, ?)',
        [p.UserPK_Proc, p.Name_Proc, unitId, !!p.IsActive_Proc]
      );
      const processId = result.insertId;
      imported++;
      console.log(`  + process ${p.UserPK_Proc} (#${processId})`);

      // Find its costing record via get_costings search, then pull bracket detail.
      const costingList = await apiCall(page, 'get_costings', { searchKey: p.UserPK_Proc, module: 'Process', limit: 5, offset: 0 });
      const match = (costingList?.data?.[0] || []).find((c) => c.UserPK_Proc === p.UserPK_Proc);
      if (!match) { console.log(`    (no costing record found)`); continue; }

      const detail = await apiCall(page, 'get_costing', { pk: match.SysPK_Cstng });
      const brackets = detail?.data?.[1] || [];
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
      }
      console.log(`    + ${brackets.length} cost bracket(s)`);
    }
  }
  console.log(`Imported ${imported} processes.`);
}

async function importInventories(page) {
  const seen = new Set();
  let imported = 0;

  for (const keyword of INVENTORY_KEYWORDS) {
    const listResp = await apiCall(page, 'get_inventories', {
      where: {
        search: { fields: ['UserPK_Invty', 'DisplayName_Invty', 'UnitTitle_Invty'], searchKey: keyword },
        Module_Invty: 'INVTY', IsApproved_Invty: '1', IsActive_Invty: '1', IsApproveCosting_Invty: '1', IsApproveAccounting_Invty: '1',
      },
      include: ['inventory_category'],
      limit: BATCH_SIZE_PER_KEYWORD,
      offset: 0,
      order: [['DisplayName_Invty', 'ASC']],
    });
    const items = listResp?.data || [];
    console.log(`Inventories matching "${keyword}": ${items.length}`);

    for (const it of items) {
      if (seen.has(it.UserPK_Invty)) continue;
      seen.add(it.UserPK_Invty);

      const [[existing]] = await pool.query('SELECT id FROM inventories WHERE item_code = ?', [it.UserPK_Invty]);
      if (existing) { console.log(`  skip (exists) ${it.UserPK_Invty}`); continue; }

      const unitId = await ensureUnit(it.BaseUnit_Invty || it.UnitTitle_Invty);
      const categoryId = await ensureCategory(it.inventory_category?.Name_Cat);

      await pool.query(
        `INSERT INTO inventories
           (item_code, display_name, sales_description, category_id, base_unit_id, item_type,
            is_active, is_length_based, is_width_based, last_purchase_price, last_purchase_date,
            average_cost, material_cost, price_indicator, tolerance_pct, wastage_allowance_pct, markup_pct,
            selling_price, beg_selling_price, disc_ceiling_pct, disc_supervisor_pct, disc_manager_pct, disc_gm_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          it.UserPK_Invty, it.DisplayName_Invty, it.SalesDescription_Invty || null, categoryId, unitId, it.Type_Invty || 'INVENTORY',
          !!it.IsActive_Invty, !!it.IsLength_Invty, !!it.IsWidth_Invty,
          it.MaxLastPurchPrice_Invty || null, it.LastPurchaseDate_Invty || null,
          // average_cost = real weighted-average purchase cost (stock/purchase unit);
          // material_cost = the separate, base-unit-normalized costing basis the
          // Sales/Pricing formula runs on -- these are two distinct real fields
          // (MaxAveCost_Invty vs MaterialCost_Invty), not duplicates.
          it.MaxAveCost_Invty || null, it.MaterialCost_Invty || null, it.PriceIndicator_Invty || 0, it.Tolerance_Invty || 0,
          it.WAPercent_Invty || 0, it.MUPercent_Invty || 0,
          it.SellingPrice_Invty || null, it.BegSellingPrice_Invty || null,
          it.DCPercent_Invty || 0, it.DCSSPercent_Invty || 0, it.DCSMPercent_Invty || 0, it.DCGMPercent_Invty || 0,
        ]
      );
      imported++;
      console.log(`  + inventory ${it.UserPK_Invty}`);
    }
  }
  console.log(`Imported ${imported} inventories.`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const inputs = await page.$$('input');
  await inputs[0].fill(USERNAME);
  await inputs[1].fill(PASSWORD);
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(2500);

  await importProcesses(page);
  await importInventories(page);

  await browser.close();
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
