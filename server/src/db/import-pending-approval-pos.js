// One-off script: imports every Purchase Order currently in "Pending Approval" status
// (the first-tier approval queue, distinct from "Pending Approval (GM)") from the live
// GraphicStar site. Reverse-engineered from the real site's own PO list/detail calls
// (a dedicated get_purchase_orders list endpoint, and get_transactions for detail --
// NOT the same get_transaction singular endpoint the Estimates import uses).
//
// Preserves the live PO-###### number verbatim (matching the Estimates import's own
// EST-###### preservation), so records are identifiable side-by-side against the live
// system. Resumable: skips any PO whose po_no already exists locally.
//
// Not part of the running app -- run manually:
//   node src/db/import-pending-approval-pos.js
const pool = require('../db');
const { login, apiCall } = require('../lib/liveEstimateSync');
require('dotenv').config();

function clean(s) { return (s || '').trim().replace(/\s+/g, ' '); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function nullableNum(v) { if (v === null || v === undefined || v === 'null') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

const cache = { supplier: new Map(), term: new Map(), location: new Map(), department: new Map(), inventory: new Map(), unit: new Map(), tax: new Map() };

async function ensureUnit(code) {
  const key = clean(code) || 'EACH';
  if (cache.unit.has(key)) return cache.unit.get(key);
  const [[existing]] = await pool.query('SELECT id FROM units_of_measure WHERE code = ?', [key]);
  if (existing) { cache.unit.set(key, existing.id); return existing.id; }
  const [result] = await pool.query('INSERT INTO units_of_measure (code, title) VALUES (?, ?)', [key, key]);
  cache.unit.set(key, result.insertId);
  return result.insertId;
}

async function ensureSupplier(liveAccnt) {
  if (!liveAccnt) return null;
  const name = clean(liveAccnt.Name_Accnt || liveAccnt.Company_Accnt);
  if (!name) return null;
  if (cache.supplier.has(name)) return cache.supplier.get(name);
  const [[existing]] = await pool.query('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)', [name]);
  if (existing) { cache.supplier.set(name, existing.id); return existing.id; }
  const termId = await ensureTerm(liveAccnt.CreditTerm_Accnt);
  const code = `LIVE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [result] = await pool.query(
    'INSERT INTO suppliers (supplier_code, name, company_name, tin, payment_term_id, is_active) VALUES (?, ?, ?, ?, ?, TRUE)',
    [code, name, liveAccnt.Company_Accnt || null, liveAccnt.TIN_Accnt || null, termId]
  );
  console.log(`  + created supplier "${name}"`);
  cache.supplier.set(name, result.insertId);
  return result.insertId;
}

// "COD" and "N DAYS" are the two real formats seen on the live site (Term_TransH on the
// PO header, CreditTerm_Accnt on the supplier) -- matched against payment_terms by
// no_of_days when the text isn't an exact term_name match, since that's the only
// reliably-comparable number both sides agree on.
async function ensureTerm(termText) {
  const key = clean(termText);
  if (!key) return null;
  if (cache.term.has(key)) return cache.term.get(key);
  const [[exact]] = await pool.query('SELECT id FROM payment_terms WHERE term_name = ?', [key]);
  if (exact) { cache.term.set(key, exact.id); return exact.id; }
  const isCod = /^COD$/i.test(key);
  const dayMatch = key.match(/(\d+)\s*DAYS?/i);
  const days = isCod ? 0 : (dayMatch ? Number(dayMatch[1]) : null);
  if (days !== null) {
    const [[byDays]] = await pool.query('SELECT id FROM payment_terms WHERE no_of_days = ?', [days]);
    if (byDays) { cache.term.set(key, byDays.id); return byDays.id; }
  }
  const [result] = await pool.query('INSERT INTO payment_terms (term_name, no_of_days, is_active) VALUES (?, ?, TRUE)', [key, days ?? 0]);
  console.log(`  + created payment term "${key}"`);
  cache.term.set(key, result.insertId);
  return result.insertId;
}

async function ensureLocation(name) {
  const key = clean(name);
  if (!key) return null;
  if (cache.location.has(key)) return cache.location.get(key);
  const [[existing]] = await pool.query('SELECT id FROM locations WHERE LOWER(location_name) = LOWER(?)', [key]);
  if (existing) { cache.location.set(key, existing.id); return existing.id; }
  const code = `LIVE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [result] = await pool.query('INSERT INTO locations (location_code, location_name, is_active) VALUES (?, ?, TRUE)', [code, key]);
  console.log(`  + created location "${key}"`);
  cache.location.set(key, result.insertId);
  return result.insertId;
}

async function ensureDepartment(name) {
  const key = clean(name);
  if (!key) return null;
  if (cache.department.has(key)) return cache.department.get(key);
  const [[existing]] = await pool.query('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)', [key]);
  if (existing) { cache.department.set(key, existing.id); return existing.id; }
  const [result] = await pool.query('INSERT INTO departments (name, is_active) VALUES (?, TRUE)', [key]);
  console.log(`  + created department "${key}"`);
  cache.department.set(key, result.insertId);
  return result.insertId;
}

async function ensureTax(code) {
  const key = clean(code);
  if (!key) return null;
  if (cache.tax.has(key)) return cache.tax.get(key);
  const [[exact]] = await pool.query('SELECT id FROM taxes WHERE code = ?', [key]);
  if (exact) { cache.tax.set(key, exact.id); return exact.id; }
  const rateMatch = key.match(/(\d+(\.\d+)?)\s*$/);
  if (rateMatch) {
    const [[byRate]] = await pool.query('SELECT id FROM taxes WHERE rate = ?', [Number(rateMatch[1])]);
    if (byRate) { cache.tax.set(key, byRate.id); return byRate.id; }
  }
  cache.tax.set(key, null);
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

async function importOnePO(token, stub) {
  const [[already]] = await pool.query('SELECT id FROM purchase_orders WHERE po_no = ?', [stub.UserPK_TransH]);
  if (already) { console.log(`SKIP ${stub.UserPK_TransH} (already imported)`); return 'skipped'; }

  const resp = await apiCall(token, 'get_transactions', {
    where: { SysPK_TransH: stub.SysPK_TransH },
    include: [
      [{ table: 'transaction_transactionledgerinvtys', where: { Module_LdgrInvty: { $ne: 'COST' } } },
        'transactionledgerinvty_invty', 'transactionledgerinvty_department', 'transactionledgerinvty_location'],
      'transaction_account',
    ],
  });
  const t = resp?.data?.[0];
  if (!t) { console.log(`  ! no detail returned for ${stub.UserPK_TransH}, skipping.`); return 'error'; }

  const supplierId = await ensureSupplier(t.transaction_account);
  if (!supplierId) { console.log(`  ! no resolvable supplier for ${stub.UserPK_TransH}, skipping.`); return 'error'; }
  const termId = await ensureTerm(t.Term_TransH);

  const [headerResult] = await pool.query(
    `INSERT INTO purchase_orders
       (po_no, type, date_created, need_by_date, supplier_id, term_id, ref_no, memo,
        subtotal, discount_amount, net_of_tax, tax_amount, total_amount, status, receipt_status, bill_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', 'not_received', 'not_billed')`,
    [
      t.UserPK_TransH, t.Type_TransH || 'PO1', t.DateCreated_TransH, t.DeliveryDate_TransH || null,
      supplierId, termId, t.ReferrenceNO_TransH || null, t.Memo_TransH || null,
      num(t.SubTotal_TransH), num(t.DiscountAmount_TransH), num(t.SubTotalVatEx_TransH), num(t.TaxAmount_TransH), num(t.TotalAmount_TransH),
    ]
  );
  const poId = headerResult.insertId;

  const lines = t.transaction_transactionledgerinvtys || [];
  for (const l of lines) {
    const itemId = await ensureInventoryItem(l.transactionledgerinvty_invty);
    if (!itemId) { console.log(`  ! skipping a line on ${stub.UserPK_TransH} with no resolvable item.`); continue; }
    const locationId = await ensureLocation(l.transactionledgerinvty_location?.Name_Loc);
    const departmentId = await ensureDepartment(l.transactionledgerinvty_department?.Name_Dept);
    const taxCodeId = await ensureTax(l.TaxCode_LdgrInvty);

    await pool.query(
      `INSERT INTO purchase_order_lines
         (purchase_order_id, item_id, purchase_description, location_id, department_id, qty, purchase_unit, unit_title,
          rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        poId, itemId, l.DisplayDescription_LdgrInvty || l.transactionledgerinvty_invty?.DisplayName_Invty || null,
        locationId, departmentId, num(l.POQty_LdgrInvty), l.UnitOfMeasure_LdgrInvty || null, l.Unit_LdgrInvty || null,
        num(l.Rate_LdgrInvty), num(l.DiscountPercent_LdgrInvty), num(l.DiscountAmount_LdgrInvty),
        num(l.SubTotalAmountIn_LdgrInvty), taxCodeId, num(l.TaxAmount_LdgrInvty), num(l.Total_LdgrInvty),
      ]
    );
  }

  console.log(`  + imported ${stub.UserPK_TransH} (${lines.length} line(s))`);
  return 'imported';
}

async function main() {
  const token = await login();

  const stubs = [];
  let offset = 0;
  for (;;) {
    const resp = await apiCall(token, 'get_purchase_orders', {
      empl_pk: null, status: 'Pending Approval', substatuts: null,
      filterdate: { filter: 'as of', date1: { hide: false, date: 'Dec 31, 2026' }, date2: { hide: true, date: 'Dec 31, 2026' } },
      accnt_pk: null, searchKey: '', limit: 200, offset, viewAll: 1,
    });
    const batch = resp?.data?.[0] || [];
    if (!batch.length) break;
    stubs.push(...batch);
    offset += 200;
    if (batch.length < 200) break;
  }
  console.log(`Found ${stubs.length} Purchase Order(s) in "Pending Approval" status.\n`);

  let imported = 0, skipped = 0, errored = 0;
  for (let i = 0; i < stubs.length; i++) {
    console.log(`[${i + 1}/${stubs.length}] ${stubs[i].UserPK_TransH} (${stubs[i].Name_Accnt})`);
    try {
      const outcome = await importOnePO(token, stubs[i]);
      if (outcome === 'imported') imported++;
      else if (outcome === 'skipped') skipped++;
      else errored++;
    } catch (err) {
      console.error(`  ! FAILED ${stubs[i].UserPK_TransH}:`, err.message);
      errored++;
    }
  }

  console.log(`\nDone. Imported ${imported}, skipped ${skipped} (already present), errored ${errored}.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
