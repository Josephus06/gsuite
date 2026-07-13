// One-off script: pulls a SPECIFIC, narrow slice of real Estimates (for parallel-run
// testing) from the live GraphicStar site -- only estimates whose Sales Rep is Arjie
// Bayagna, Catherine Jane Langajed, or Jocel Ann Berina, whose status is "Pending" or
// "Approved by Supervisor" (i.e. Pending Supervisor Approval / Pending Customer
// Approval), created Jul 1-11, 2026. Confirmed against the live site: 51 estimates match.
//
// Full nested detail (job order lines + process/material lines) is pulled via
// get_transaction and mapped onto estimate_job_orders / estimate_job_order_processes.
// Every referenced master-data record (customer, contact, sales rep/prepared-by/
// approved-by employees, sales division, locations, job type, tax code, inventory item)
// is looked up by name/code and auto-created locally if missing -- processes are NOT
// auto-created here since import-all-processes.js already pulled the entire live catalog.
//
// Resumable: skips any estimate whose estimate_no already exists locally, and preserves
// the live EST-###### number exactly (rather than re-numbering) so the same record is
// identifiable side-by-side against the live system during parallel-run testing.
//
// Not part of the running app -- run manually:
//   node src/db/import-target-estimates.js
const { chromium } = require('playwright');
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const USERNAME = process.env.LIVE_SITE_USERNAME;
const PASSWORD = process.env.LIVE_SITE_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Set LIVE_SITE_USERNAME and LIVE_SITE_PASSWORD in server/.env before running this script.');
  process.exit(1);
}

const TARGET_SALES_REPS = ['Arjie Bayagna', 'Catherine Jane  Langajed', 'Jocel Ann Berina'];
const TARGET_STATUSES = ['Pending', 'Approved by Supervisor'];
// Status_TransH on the detail response is "Approved By Supervisor" (capital B) even
// though the list endpoint's own status filter param takes lowercase "by" -- confirmed
// by direct comparison, not guessed. Matched case-insensitively here to not silently
// mis-map every one of these again.
const STATUS_MAP_LOWER = {
  pending: 'pending_supervisor_approval',
  'approved by supervisor': 'pending_customer_approval',
  approved: 'approved',
  cancelled: 'cancelled',
  disapproved: 'disapproved',
};
function mapStatus(liveStatus) {
  const key = String(liveStatus || '').trim().toLowerCase();
  if (STATUS_MAP_LOWER[key]) return STATUS_MAP_LOWER[key];
  console.warn(`  ! unrecognized live status "${liveStatus}" -- defaulting to pending_supervisor_approval, check mapStatus()`);
  return 'pending_supervisor_approval';
}
const DATE_RANGE = { date1: 'Jul 1, 2026', date2: 'Jul 13, 2026' };

// This app authenticates API calls via a JWT in localStorage (satellizer_token) sent as
// an Authorization header, not just cookies -- most GET-style list endpoints tolerated
// its absence, but get_transaction (the detail endpoint) strictly rejects requests
// without it, confirmed by replaying an exact captured request body with/without it.
async function apiCall(page, endpoint, body) {
  return page.evaluate(async ({ endpoint, body }) => {
    const token = localStorage.getItem('satellizer_token');
    const res = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    return res.json();
  }, { endpoint, body });
}

// ---- master-data resolvers (match by name/code, auto-create a minimal stub if missing) ----

function clean(s) { return (s || '').trim().replace(/\s+/g, ' '); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function nullableNum(v) { if (v === null || v === undefined || v === 'null') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

const cache = { employee: new Map(), customer: new Map(), salesDivision: new Map(), location: new Map(), jobType: new Map(), tax: new Map(), inventory: new Map(), unit: new Map() };

async function ensureUnit(code) {
  const key = clean(code) || 'EACH';
  if (cache.unit.has(key)) return cache.unit.get(key);
  const [[existing]] = await pool.query('SELECT id FROM units_of_measure WHERE code = ?', [key]);
  if (existing) { cache.unit.set(key, existing.id); return existing.id; }
  const [result] = await pool.query('INSERT INTO units_of_measure (code, title) VALUES (?, ?)', [key, key]);
  cache.unit.set(key, result.insertId);
  return result.insertId;
}

async function ensureEmployee(fullName) {
  const name = clean(fullName);
  if (!name) return null;
  if (cache.employee.has(name)) return cache.employee.get(name);
  const parts = name.split(' ').filter(Boolean);
  const firstName = parts[0] || name;
  const lastName = parts.slice(1).join(' ') || '-';
  const [[existing]] = await pool.query(
    'SELECT id FROM employees WHERE LOWER(CONCAT(first_name, " ", last_name)) = LOWER(?)',
    [name]
  );
  if (existing) { cache.employee.set(name, existing.id); return existing.id; }
  const code = `LIVE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [result] = await pool.query(
    'INSERT INTO employees (employee_code, first_name, last_name, is_active) VALUES (?, ?, ?, TRUE)',
    [code, firstName, lastName]
  );
  console.log(`  + created employee "${name}"`);
  cache.employee.set(name, result.insertId);
  return result.insertId;
}

async function ensureCustomer(liveCust) {
  if (!liveCust) return null;
  const name = clean(liveCust.Name_Cust || liveCust.Company_Cust);
  if (!name) return null;
  if (cache.customer.has(name)) return cache.customer.get(name);
  const [[existing]] = await pool.query('SELECT id FROM customers WHERE LOWER(name) = LOWER(?)', [name]);
  if (existing) { cache.customer.set(name, existing.id); return existing.id; }
  const code = `LIVE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [result] = await pool.query(
    'INSERT INTO customers (customer_code, name, company_name, tin, credit_limit, is_active) VALUES (?, ?, ?, ?, ?, TRUE)',
    [code, name, liveCust.Company_Cust || null, liveCust.TIN_Cust || null, nullableNum(liveCust.CreditLimit_Cust)]
  );
  console.log(`  + created customer "${name}"`);
  cache.customer.set(name, result.insertId);
  return result.insertId;
}

async function ensureCustomerContact(liveContact, customerId) {
  if (!liveContact || !customerId) return null;
  const name = clean(liveContact.Name_ContactP);
  if (!name) return null;
  const [[existing]] = await pool.query(
    'SELECT id FROM customer_contacts WHERE customer_id = ? AND LOWER(contact_name) = LOWER(?)',
    [customerId, name]
  );
  if (existing) return existing.id;
  const [result] = await pool.query(
    'INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone) VALUES (?, ?, ?, ?, ?)',
    [customerId, name, liveContact.Title_ContactP || null, liveContact.Email_ContactP || null, liveContact.ContactNo_ContactP || null]
  );
  return result.insertId;
}

async function ensureSalesDivision(name) {
  const key = clean(name);
  if (!key) return null;
  if (cache.salesDivision.has(key)) return cache.salesDivision.get(key);
  const [[existing]] = await pool.query('SELECT id FROM sales_divisions WHERE LOWER(name) = LOWER(?)', [key]);
  if (existing) { cache.salesDivision.set(key, existing.id); return existing.id; }
  const [result] = await pool.query('INSERT INTO sales_divisions (name, is_active) VALUES (?, TRUE)', [key]);
  console.log(`  + created sales division "${key}"`);
  cache.salesDivision.set(key, result.insertId);
  return result.insertId;
}

async function ensureLocation(name) {
  const key = clean(name);
  if (!key) return null;
  if (cache.location.has(key)) return cache.location.get(key);
  const [[existing]] = await pool.query('SELECT id FROM locations WHERE LOWER(location_name) = LOWER(?)', [key]);
  if (existing) { cache.location.set(key, existing.id); return existing.id; }
  const code = `LIVE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [result] = await pool.query(
    'INSERT INTO locations (location_code, location_name, is_active) VALUES (?, ?, TRUE)',
    [code, key]
  );
  console.log(`  + created location "${key}"`);
  cache.location.set(key, result.insertId);
  return result.insertId;
}

async function ensureJobType(liveJob) {
  if (!liveJob) return null;
  const name = clean(liveJob.DisplayName_Job);
  if (!name) return null;
  if (cache.jobType.has(name)) return cache.jobType.get(name);
  const [[existing]] = await pool.query('SELECT id FROM job_types WHERE LOWER(display_name) = LOWER(?)', [name]);
  if (existing) { cache.jobType.set(name, existing.id); return existing.id; }
  const code = `LIVE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [result] = await pool.query(
    'INSERT INTO job_types (item_code, display_name, sales_description, purchase_description, is_active) VALUES (?, ?, ?, ?, TRUE)',
    [code, name, liveJob.SalesDescription_Job || null, liveJob.PurchaseDescription_Job || null]
  );
  console.log(`  + created job type "${name}"`);
  cache.jobType.set(name, result.insertId);
  return result.insertId;
}

async function ensureTax(code) {
  const key = clean(code);
  if (!key) return null;
  if (cache.tax.has(key)) return cache.tax.get(key);
  const [[exact]] = await pool.query('SELECT id FROM taxes WHERE code = ?', [key]);
  if (exact) { cache.tax.set(key, exact.id); return exact.id; }
  // Live tax codes look like "VAT_PH:VATIN-12" -- the trailing number is the rate.
  // Match against a local tax with that same rate rather than leaving the FK null when
  // it's clearly the same tax under a different code string (confirmed: this clone's
  // only seeded tax is VAT12 @ 12%, matching every live VAT_PH:VATIN-12 code seen).
  const rateMatch = key.match(/(\d+(\.\d+)?)\s*$/);
  if (rateMatch) {
    const [[byRate]] = await pool.query('SELECT id FROM taxes WHERE rate = ?', [Number(rateMatch[1])]);
    if (byRate) { cache.tax.set(key, byRate.id); return byRate.id; }
  }
  cache.tax.set(key, null); // don't fabricate a tax rate we don't actually know
  return null;
}

async function ensureInventoryItem(liveInvty) {
  if (!liveInvty) return null;
  const code = clean(liveInvty.UserPK_Invty);
  if (!code) return null;
  if (cache.inventory.has(code)) return cache.inventory.get(code);
  const isLengthBased = !!liveInvty.IsLength_Invty;
  const isWidthBased = !!liveInvty.IsWidth_Invty;
  const [[existing]] = await pool.query('SELECT id FROM inventories WHERE item_code = ?', [code]);
  if (existing) {
    await pool.query('UPDATE inventories SET is_length_based = ?, is_width_based = ? WHERE id = ?', [isLengthBased, isWidthBased, existing.id]);
    cache.inventory.set(code, existing.id);
    return existing.id;
  }
  const unitId = await ensureUnit(liveInvty.BaseUnit_Invty || liveInvty.UnitTitle_Invty || liveInvty.SalesUnit_Invty);
  const [result] = await pool.query(
    `INSERT INTO inventories (item_code, display_name, sales_description, base_unit_id, item_type, is_active, average_cost, material_cost, selling_price, is_length_based, is_width_based)
     VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?)`,
    [
      code, liveInvty.DisplayName_Invty || code, liveInvty.SalesDescription_Invty || null, unitId,
      liveInvty.Module_Invty || 'INVENTORY',
      nullableNum(liveInvty.MaxAveCost_Invty), nullableNum(liveInvty.MaterialCost_Invty), nullableNum(liveInvty.SellingPrice_Invty),
      isLengthBased, isWidthBased,
    ]
  );
  console.log(`  + created inventory item "${code}"`);
  cache.inventory.set(code, result.insertId);
  return result.insertId;
}

// Mirrors client/src/utils/costing.js's computeAutoPricing `total` field exactly (see
// the identical helper + full explanation in liveEstimateSync.js).
const LENGTH_UNIT_TO_FEET = { FT: 1, LFT: 1, IN: 1 / 12, LINCH: 1 / 12, MM: 0.00328084, CM: 0.0328084, MTR: 3.28084, M: 3.28084, LMTR: 3.28084, YD: 3 };
function computeLineTotal(l) {
  const inv = l.transactionledgerinvty_invty;
  const qty = num(l.Qty_LdgrInvty);
  const length = nullableNum(l.Length_LdgrInvty);
  const width = nullableNum(l.Width_LdgrInvty);
  const isAreaBased = !!inv?.IsLength_Invty && !!inv?.IsWidth_Invty && length > 0 && width > 0;
  if (!isAreaBased) return qty;
  const lengthFactor = LENGTH_UNIT_TO_FEET[l.UnitOfMeasure_LdgrInvty] ?? 1;
  const areaSqft = (length * lengthFactor) * (width * lengthFactor);
  return Number((areaSqft * qty).toFixed(4));
}

async function processIdByCode(code) {
  const key = clean(code);
  if (!key) return null;
  const [[row]] = await pool.query('SELECT id FROM processes WHERE process_code = ?', [key]);
  return row ? row.id : null;
}

// ---- main import ----

async function importOneEstimate(page, stub) {
  const [[already]] = await pool.query('SELECT id FROM estimates WHERE estimate_no = ?', [stub.est_upk]);
  if (already) { console.log(`SKIP ${stub.est_upk} (already imported)`); return 'skipped'; }

  const resp = await apiCall(page, 'get_transaction', {
    where: { Module_TransH: 'ESTIMATES', SysPK_TransH: stub.est_pk },
    include: [
      ['transaction_transactionledgerjobs', ['transactionledgerjob_transactionledgerinvtys', 'transactionledgerinvty_process', 'transactionledgerinvty_invty'], 'transactionledgerjob_location', 'transactionledgerjob_job', 'transactionledgerjob_shippingaddress', 'transactionledgerjob_transactionnstdjo'],
      'transaction_customer', 'transaction_contactperson', 'transaction_department', 'transaction_shippingaddress', 'transaction_location', 'transaction_employee',
      'transaction_transactionsl', 'transaction_transactionto', 'transaction_transactionjo', 'transaction_transactionnewest',
    ],
    order: [[{}, 'ID_LdgrJob', 'ASC'], [{}, 'ID_LdgrInvty', 'ASC']],
  });
  const t = resp?.data?.[0];
  if (!t) { console.log(`  ! no detail returned for ${stub.est_upk}, skipping. Raw response:`, JSON.stringify(resp).slice(0, 500)); return 'error'; }

  const customerId = await ensureCustomer(t.transaction_customer);
  const contactId = await ensureCustomerContact(t.transaction_contactperson, customerId);
  const salesRepId = await ensureEmployee(t.transaction_employee?.Name_Empl);
  const preparedById = await ensureEmployee(t.PreparedBy_TransH);
  const approvedById = t.ApprovedBy_TransH ? await ensureEmployee(t.ApprovedBy_TransH) : null;
  const salesDivisionId = await ensureSalesDivision(t.transaction_department?.Name_Dept);
  const officeLocationId = await ensureLocation(t.transaction_location?.Name_Loc);

  const status = mapStatus(t.Status_TransH);

  const [headerResult] = await pool.query(
    `INSERT INTO estimates
       (estimate_no, date_created, customer_id, contact_person_id, contact_email, contact_title, contact_phone,
        sales_rep_id, sales_division_id, office_location_id, contract_description, memo, has_multiple_shipping,
        production_lead_time, price_validity, order_confirmation_type,
        print_warranty, print_warranty_term, structure_warranty, structure_warranty_term,
        electrical_warranty, electrical_warranty_term, prepared_by_id, approved_by_id,
        credit_term, credit_limit, bill_to_contact_number, status,
        subtotal, discount_total, net_of_tax, tax_total, total_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stub.est_upk, t.DateCreated_TransH, customerId, contactId,
      t.transaction_contactperson?.Email_ContactP || null, t.transaction_contactperson?.Title_ContactP || null, t.transaction_contactperson?.ContactNo_ContactP || null,
      salesRepId, salesDivisionId, officeLocationId, t.ContractDescription_TransH || null, t.Memo_TransH || null, !!t.IsMultipleShipping_TransH,
      t.Leadtime_TransH || null, t.PriceValidity_TransH || null, t.OrderConfirmation_TransH || null,
      !!t.IsPrintWarranty_TransH, t.PrintWarranty_TransH || null, !!t.IsStructionWarranty_TransH, t.StructureWarranty_TransH || null,
      !!t.IsElectricalWarranty_TransH, t.ElectricalWarranty_TransH || null, preparedById, approvedById,
      t.Term_TransH || null, nullableNum(t.transaction_customer?.CreditLimit_Cust), t.BillToContactNo_TransH || null, status,
      num(t.SubTotal_TransH), num(t.DiscountAmount_TransH), num(t.SubTotalVatEx_TransH), num(t.TaxAmount_TransH), num(t.TotalAmount_TransH),
    ]
  );
  const estimateId = headerResult.insertId;

  const jobs = t.transaction_transactionledgerjobs || [];
  let totalGpAmount = 0;
  for (let jIdx = 0; jIdx < jobs.length; jIdx++) {
    const jo = jobs[jIdx];
    const jobTypeId = await ensureJobType(jo.transactionledgerjob_job);
    const jobLocationId = await ensureLocation(jo.transactionledgerjob_location?.Name_Loc);
    const joTaxCodeId = await ensureTax(jo.TaxCode_LdgrJob);
    const joNetOfTax = num(jo.VatExAmount_LdgrJob);
    const joGpRate = num(jo.GPRate_LdgrJob);
    const joGpAmount = Number((joNetOfTax * joGpRate / 100).toFixed(2));
    totalGpAmount += joGpAmount;

    const [joResult] = await pool.query(
      `INSERT INTO estimate_job_orders
         (estimate_id, line_no, job_type_id, job_location_id, description, quantity, units, price_per_unit, subtotal,
          disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, gross_amount, length, width, height, uom,
          remarks, memo, delivery_date, gp_rate, gp_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        estimateId, jIdx + 1, jobTypeId, jobLocationId, jo.Description_LdgrJob || null, num(jo.Qty_LdgrJob), jo.UnitOfMeasure_LdgrJob || null,
        num(jo.Price_LdgrJob), num(jo.SubTotal_LdgrJob), num(jo.DiscountPercent_LdgrJob), num(jo.DiscountAmount_LdgrJob),
        joNetOfTax, joTaxCodeId, num(jo.TaxAmount_LdgrJob), num(jo.GrossAmount_LdgrJob),
        nullableNum(jo.Length_LdgrJob), nullableNum(jo.Width_LdgrJob), nullableNum(jo.Height_LdgrJob), jo.UnitOfMeasure_LdgrJob || null,
        null, jo.Memo_LdgrJob || null, jo.DeliveryDate_LdgrJob || null, joGpRate, joGpAmount,
      ]
    );
    const joId = joResult.insertId;

    const lines = jo.transactionledgerjob_transactionledgerinvtys || [];
    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const l = lines[lIdx];
      const processId = await processIdByCode(l.transactionledgerinvty_process?.UserPK_Proc);
      const itemId = await ensureInventoryItem(l.transactionledgerinvty_invty);
      const lineTaxCodeId = await ensureTax(l.TaxCode_LdgrInvty);
      const discProcessPrice = num(l.DiscProcessPrice_LdgrInvty);
      const discMaterialPrice = num(l.DiscMaterialPrice_LdgrInvty);
      const netOfTax = Number((discProcessPrice + discMaterialPrice).toFixed(2));
      const taxAmount = num(l.TaxAmount_LdgrInvty);
      const grossAmount = num(l.TotalAmountOut_LdgrInvty) || Number((netOfTax + taxAmount).toFixed(2));

      await pool.query(
        `INSERT INTO estimate_job_order_processes
           (estimate_job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id,
            length, width, uom, qty, total, unit, process_price, process_disc_percent, process_disc_amount,
            disc_process_price, material_price, material_disc_percent, material_disc_amount, disc_material_price,
            net_of_tax, tax_code_id, tax_amount, gross_amount, remarks, gp_rate, process_cost, material_cost,
            total_cost, total_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          joId, lIdx + 1, processId, nullableNum(l.ProcessQty_LdgrInvty), l.transactionledgerinvty_process?.UOM_Proc || null,
          l.Category_LdgrInvty || null, l.Parts_LdgrInvty || null, itemId,
          nullableNum(l.Length_LdgrInvty), nullableNum(l.Width_LdgrInvty), l.UnitOfMeasure_LdgrInvty || null,
          num(l.Qty_LdgrInvty), computeLineTotal(l), l.Unit_LdgrInvty || null,
          num(l.ProcessPrice_LdgrInvty), num(l.ProcessDiscountPercent_LdgrInvty), num(l.ProcessDiscountAmount_LdgrInvty),
          discProcessPrice, num(l.MaterialPrice_LdgrInvty), num(l.MaterialDiscountPercent_LdgrInvty), num(l.MaterialDiscountAmount_LdgrInvty),
          discMaterialPrice, netOfTax, lineTaxCodeId, taxAmount, grossAmount, l.SalesRemarks_LdgrInvty || null,
          num(l.GPRate_LdgrInvty), num(l.ProcessCost_LdgrInvty), num(l.MaterialCost_LdgrInvty),
          Number((num(l.ProcessCost_LdgrInvty) + num(l.MaterialCost_LdgrInvty)).toFixed(2)), grossAmount,
        ]
      );
    }
  }

  const netOfTaxTotal = num(t.SubTotalVatEx_TransH);
  const estGpRate = netOfTaxTotal > 0 ? Number((totalGpAmount / netOfTaxTotal * 100).toFixed(2)) : 0;
  await pool.query('UPDATE estimates SET est_gp_rate = ?, est_gp_amount = ? WHERE id = ?', [estGpRate, Number(totalGpAmount.toFixed(2)), estimateId]);

  console.log(`  + imported ${stub.est_upk} (${jobs.length} job order(s))`);
  return 'imported';
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const inputs = await page.$$('input');
  await inputs[0].fill(USERNAME);
  await inputs[1].fill(PASSWORD);
  await page.click('button:has-text("Sign In")');
  // Redirect off /login can take several seconds depending on live-site load --
  // poll instead of a fixed sleep so a slow-but-successful login isn't misread as a failure.
  for (let i = 0; i < 15 && page.url().includes('login'); i++) {
    await page.waitForTimeout(1000);
  }
  if (page.url().includes('login')) { console.error('Login failed.'); process.exit(1); }

  const stubs = [];
  for (const status of TARGET_STATUSES) {
    let offset = 0;
    for (;;) {
      const resp = await apiCall(page, 'get_hierarchy_estimates', {
        prepared_by: null, sales_rep: null, location: null, status, searchKey: '',
        filterdate: { filter: 'period from', date1: { hide: false, date: DATE_RANGE.date1 }, date2: { hide: false, date: DATE_RANGE.date2 } },
        limit: 200, offset,
      });
      const batch = resp?.data?.[0] || [];
      if (!batch.length) break;
      stubs.push(...batch);
      offset += 200;
      if (batch.length < 200) break;
    }
  }
  let targets = stubs.filter((s) => TARGET_SALES_REPS.includes(s.Name_Empl));
  if (process.env.IMPORT_LIMIT) targets = targets.slice(0, Number(process.env.IMPORT_LIMIT));
  console.log(`Found ${targets.length} target estimates to import.\n`);

  let imported = 0, skipped = 0, errored = 0;
  for (let i = 0; i < targets.length; i++) {
    console.log(`[${i + 1}/${targets.length}] ${targets[i].est_upk} (${targets[i].Name_Empl})`);
    try {
      const outcome = await importOneEstimate(page, targets[i]);
      if (outcome === 'imported') imported++;
      else if (outcome === 'skipped') skipped++;
      else errored++;
    } catch (err) {
      console.error(`  ! FAILED ${targets[i].est_upk}:`, err.message);
      errored++;
    }
  }

  console.log(`\nDone. Imported ${imported}, skipped ${skipped} (already present), errored ${errored}.`);
  await browser.close();
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
