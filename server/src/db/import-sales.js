// One-off import: pulls a date range of sales for Michelle Riveral, Arjie Bayagna, Jocel
// Ann Berina and Catherine Langajed from the live GraphicStar system into this clone --
// the core Estimate -> Sales Order -> Job Order -> Invoice spine, so the Commission report
// shows their real numbers.
//
// READ-ONLY against live (login + get_* only). The live model is one denormalised ledger:
// a "LedgerJob" line carries FK pointers to the same line's estimate, sales order AND job
// order, plus its net/GP/job-type. This explodes each SO's ledger lines into the clone's
// normalised tables.
//
// Missing customers / job types / sales divisions are created locally (per the chosen
// policy). Re-running replaces a sales order matched by its number, so it re-syncs rather
// than duplicating.
//
//   node src/db/import-sales.js --from=2026-01-01 --to=2026-06-30 --dry-run
//   node src/db/import-sales.js --from=2026-01-01 --to=2026-06-30
//   node src/db/import-sales.js --preset=all --from=2021-01-01 --to=2021-12-31   (whole year, every rep)
// Defaults to July 2026 if --from/--to are omitted.
//
// VOID / CANCELLED sales orders and invoices are never migrated -- they are skipped outright
// rather than imported with a 'cancelled' status.
const pool = require('../db');
require('dotenv').config();
const { fetchWindow, isVoidOrCancelled } = require('./lib/liveWindow');

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const REFRESH = process.argv.includes('--refresh'); // ignore the on-disk live-window cache
// Recovery mode: leave already-imported sales orders completely alone and only add invoices
// they are missing. Needed because the normal path replaces the order wholesale, which a
// foreign key blocks once the order has production records (assembly builds reference its job
// order processes). Those orders would otherwise never pick up an invoice cut after their
// original import.
const INVOICES_ONLY = process.argv.includes('--invoices-only');
// A handful of historic orders reference a customer that has since been deleted on live, so
// Name_Cust comes back null and the order can't satisfy the NOT NULL customer_id. With this
// flag they are imported against a clearly-labelled placeholder instead of being dropped --
// the name makes the source defect obvious wherever the order surfaces in reports.
const PLACEHOLDER_CUSTOMER = process.argv.includes('--placeholder-customer');
const PLACEHOLDER_CUSTOMER_NAME = '(Unknown - live customer record deleted)';
function argVal(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
}
// Inclusive date window (YYYY-MM-DD). SO/JO/invoice bucketing is by the SO date.
const FROM = argVal('from', '2026-07-01');
const TO = argVal('to', '2026-07-31');
// Optional: restrict to a specific set of SO numbers (comma-separated). When set, only those
// SOs are (re)built -- used to re-sync individual orders that drifted from live post-migration.
const ONLY = new Set(argVal('only', '').split(',').map((s) => s.trim()).filter(Boolean));
const day = (v) => (v || '').toString().slice(0, 10);
// Live rep name -> we match the local employee by the same name. Reps are matched by
// normalized name (whitespace-collapsed, lowercased) so live-side double spaces / casing
// don't matter. Presets are hardcoded here (UTF-8) to avoid command-line encoding issues
// with names like "Cañete". Pick with --preset=sales1|sales3 (default sales1).
const REP_PRESETS = {
  sales1: ['Michelle Riveral', 'Arjie Bayagna', 'Jocel Ann Berina', 'Catherine Jane Langajed'],
  sales3: ['JOJI ANN NICOLE FUENTES', 'Margie Lyn C. Cañete', 'Jerome Magale', 'Paul Adam T. Oporto', 'Vanessa Krystal Jean Garcia'],
  // Sales-2 team (Arlene heads it; some of her orders sit under Sales-4). Filter is by rep, not
  // department, so each SO still resolves to whatever department live records for it.
  sales2: ['Nina Ann Solano', 'Glenn Valencia', 'Arlene Arimbay', 'Jessa Mae Lagat', 'Katherine Benigay'],
  // Sales-4 division reps. Amelyn also has 2 SOs booked under "Sales-5" -- they're still hers,
  // so rep-name filtering legitimately picks them up.
  sales4: ['Amelyn A. Pen', 'Lindy Casires', 'Claire Real', 'Jerusha Gwyneth Del Mar'],
  // Marketing division. Deliberately excludes Jocel Ann Berina (a Sales-1 rep with one stray
  // Marketing SO) -- filtering by her name would wrongly drag in all her Sales-1 orders.
  marketing: ['Jocelyn Ybañez', 'Ronel Parreño'],
  // The two branch stores. Their reps overlap (Dexter/Roselyn/etc. sell in both), and filtering is
  // by rep, so this one preset captures both Branch - Ayala and Branch-SM_Cebu; each SO still lands
  // in whichever branch department live records for it.
  branches: ['ROSELYN P. TUNDAG', 'EUNICE EDAÑO GEYROZAGA', 'Cindy Marie Deniay_AYALA', 'Cindy Marie Deniay_SM', 'Dexter Bantilan', 'Alessa Pacinio', 'Precious Artista'],
};
// --preset=all imports EVERY rep's orders in the window (whole-company migration of a year)
// instead of one division's. Reps with no local employee are created on the fly, so nothing
// is silently dropped.
const PRESET = argVal('preset', 'sales1');
const ALL_REPS = PRESET === 'all';
const REPS = ALL_REPS ? [] : (REP_PRESETS[PRESET] || REP_PRESETS.sales1);
const repNorm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const REP_NORM_SET = new Set(REPS.map(repNorm));
// Invoices for a window's orders are often cut after the window closes (a December order
// billed in January). Index invoices out to this date so those orders don't look unbilled.
const INVOICE_TO = argVal('invoice-to', (() => {
  const d = new Date(`${TO}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 6); return d.toISOString().slice(0, 10);
})());

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
// Live dimension fields can be "-" (not applicable); only a real number goes into a
// DECIMAL column, everything else becomes NULL.
function decOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Live SO Status_TransH -> local sales_orders.status enum.
function soStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('CANCEL')) return 'cancelled';
  if (s.includes('BILLED') || s.includes('PAID')) return 'billed';
  if (s.includes('PENDING BILLING') && s.includes('PARTIAL')) return 'pending_billing_partially_delivered';
  if (s.includes('PENDING BILLING')) return 'pending_billing';
  if (s.includes('PARTIALLY DELIVERED')) return 'partially_delivered';
  if (s.includes('PENDING DELIVERY')) return 'pending_delivery';
  if (s.includes('IN-PROCESS') || s.includes('IN PROCESS')) return 'jo_in_process';
  return 'pending_for_jo';
}
// The JO's production_stage is derived from its SO's overall status (the live per-JO stage
// isn't listable cheaply), so the imported JOs land in a sensible Production tab. Cancelled
// -> null so they're excluded from the Production stage list.
function joStageFromSo(localStatus) {
  return {
    pending_for_jo: 'pending_for_scheduling',
    jo_in_process: 'in_process',
    pending_delivery: 'completed',
    partially_delivered: 'partially_completed',
    pending_billing: 'completed',
    pending_billing_partially_delivered: 'partially_completed',
    billed: 'invoiced',
    cancelled: null,
  }[localStatus] || 'pending_for_scheduling';
}
function clean(s) { return (s || '').toString().trim().replace(/\s+/g, ' '); }
// Trim to a column length (live memos/refs can exceed local VARCHAR limits).
function trunc(s, n) { const c = clean(s); return c ? c.slice(0, n) : null; }

// ---- live API ----
async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const body = await r.json();
  if (!body?.data?.token) throw new Error(`Login failed: ${body?.message}`);
  return body.data.token;
}
async function apiOnce(token, ep, payload, ms = 90000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal,
    });
    // Clear the abort timer only after the body is read: headers can arrive and then the
    // stream stall, and clearing on headers alone leaves that read with no timeout at all.
    const j = await r.json(); clearTimeout(t); return j;
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
// The live server intermittently times out; retry with backoff before giving up.
async function api(token, ep, payload, ms = 90000) {
  let last;
  for (let a = 0; a < 4; a += 1) {
    try { return await apiOnce(token, ep, payload, ms); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); }
  }
  throw last;
}
const listRows = (res) => (Array.isArray(res.data?.[0]) ? res.data[0] : (res.data || []));

// ---- local FK resolvers (cached; create-on-miss per the chosen policy) ----
const cache = { customers: new Map(), jobTypes: new Map(), divisions: new Map(), reps: new Map() };
const stats = { customersCreated: 0, jobTypesCreated: 0, divisionsCreated: 0, repsCreated: 0, placeholderCustomerUsed: 0, jobTypesMissingGp: [] };

async function resolveCustomer(name) {
  let key = clean(name).toLowerCase();
  if (!key && PLACEHOLDER_CUSTOMER) {
    name = PLACEHOLDER_CUSTOMER_NAME;
    key = name.toLowerCase();
    stats.placeholderCustomerUsed += 1;
  }
  if (!key) return null;
  if (cache.customers.has(key)) return cache.customers.get(key);
  const [[row]] = await pool.query('SELECT id FROM customers WHERE LOWER(name) = ? LIMIT 1', [key]);
  let id = row ? row.id : null;
  if (!id && !DRY_RUN) {
    const [r] = await pool.query('INSERT INTO customers (name, is_active) VALUES (?, 1)', [clean(name)]);
    id = r.insertId;
  }
  if (!row) stats.customersCreated += 1;
  cache.customers.set(key, id);
  return id;
}
async function resolveJobType(displayName) {
  const key = clean(displayName).toLowerCase();
  if (!key) return null;
  if (cache.jobTypes.has(key)) return cache.jobTypes.get(key);
  const [[row]] = await pool.query('SELECT id FROM job_types WHERE LOWER(display_name) = ? LIMIT 1', [key]);
  let id = row ? row.id : null;
  if (!id) {
    stats.jobTypesCreated += 1;
    stats.jobTypesMissingGp.push(clean(displayName));
    if (!DRY_RUN) {
      // No live GP rate to seed; default 0 so it imports, and report it -- a job type with
      // no passing GP simply never counts a line as passing until it's set.
      const [r] = await pool.query('INSERT INTO job_types (display_name, gp_rate_head, gp_rate_branch, is_active) VALUES (?, 0, 0, 1)', [clean(displayName)]);
      id = r.insertId;
    }
  }
  cache.jobTypes.set(key, id);
  return id;
}
async function resolveDivision(name) {
  // Match ignoring spaces AND dashes so live "Sales-3" finds the app's seeded "Sales - 3"
  // (otherwise we'd create a duplicate division and mis-attribute the department).
  const key = clean(name).toLowerCase().replace(/[\s-]/g, '');
  if (!key) return null;
  if (cache.divisions.has(key)) return cache.divisions.get(key);
  const [[row]] = await pool.query(
    "SELECT id FROM sales_divisions WHERE REPLACE(REPLACE(LOWER(name),' ',''),'-','') = ? LIMIT 1", [key]);
  let id = row ? row.id : null;
  if (!id && !DRY_RUN) {
    const [r] = await pool.query('INSERT INTO sales_divisions (name, is_active) VALUES (?, 1)', [clean(name)]);
    id = r.insertId;
  }
  if (!row) stats.divisionsCreated += 1;
  cache.divisions.set(key, id);
  return id;
}
// The org "department" (for invoices / the Department Income Statement) lives in the
// `departments` table, distinct from sales_divisions -- match the division name to it,
// ignoring spaces/dashes (live "Sales-3" -> departments "Sales - 3").
async function resolveDepartment(name) {
  const key = clean(name).toLowerCase().replace(/[\s-]/g, '');
  if (!key) return null;
  if (!cache.departments) cache.departments = new Map();
  if (cache.departments.has(key)) return cache.departments.get(key);
  const [[row]] = await pool.query(
    "SELECT id FROM departments WHERE REPLACE(REPLACE(LOWER(name),' ',''),'-','') = ? LIMIT 1", [key]);
  const id = row ? row.id : null;
  cache.departments.set(key, id);
  return id;
}
async function resolveRep(name, createIfMissing = false) {
  const key = clean(name).toLowerCase();
  if (!key) return null;
  if (cache.reps.has(key)) return cache.reps.get(key);
  const [[row]] = await pool.query(
    "SELECT id FROM employees WHERE LOWER(CONCAT(first_name,' ',last_name)) = ? LIMIT 1", [key]
  );
  let id = row ? row.id : null;
  // Historic years contain reps who have since left and are gone from the live employee
  // directory, so import-all-employees.js can't supply them. Create a minimal inactive
  // record rather than dropping their sales orders.
  if (!id && createIfMissing && !DRY_RUN) {
    const full = clean(name);
    const parts = full.split(' ').filter(Boolean);
    // employee_code is UNIQUE -- take the next free HIST-#### rather than a timestamp, which
    // two reps resolved in the same millisecond would collide on.
    const [[mx]] = await pool.query(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(employee_code,6) AS UNSIGNED)),0)+1 AS n FROM employees WHERE employee_code LIKE 'HIST-%'");
    const [r] = await pool.query(
      'INSERT INTO employees (employee_code, first_name, last_name, is_active) VALUES (?,?,?,0)',
      [`HIST-${String(mx.n).padStart(4, '0')}`, parts[0] || full, parts.slice(1).join(' ') || '-']
    );
    id = r.insertId;
    stats.repsCreated += 1;
  }
  cache.reps.set(key, id);
  return id;
}

// The sales order's contact person -> customer_contacts (create-on-miss for that customer).
async function resolveContact(customerId, name, title, email, phone) {
  const nm = clean(name);
  if (!customerId || !nm) return null;
  const [[row]] = await pool.query(
    'SELECT id FROM customer_contacts WHERE customer_id = ? AND LOWER(contact_name) = LOWER(?) LIMIT 1', [customerId, nm]);
  if (row) return row.id;
  const [r] = await pool.query(
    'INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone) VALUES (?,?,?,?,?)',
    [customerId, trunc(nm, 255), trunc(title, 100), trunc(email, 255), trunc(phone, 100)]);
  return r.insertId;
}

// Live invoice status -> local sales_invoices.status.
function invoiceStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  if (s.includes('PAID')) return 'paid_in_full';
  return 'saved';
}

// Wipe a previously-imported SO and its children so a re-run re-syncs cleanly. The
// estimate is left in place -- it's reused by number (one estimate can back several SOs).
async function deleteExistingSalesOrder(conn, salesOrderNo) {
  const [[so]] = await conn.query('SELECT id FROM sales_orders WHERE sales_order_no = ?', [salesOrderNo]);
  if (!so) return;
  const [invs] = await conn.query('SELECT id FROM sales_invoices WHERE sales_order_id = ?', [so.id]);
  if (invs.length) {
    await conn.query('DELETE FROM sales_invoice_lines WHERE sales_invoice_id IN (?)', [invs.map((i) => i.id)]);
    await conn.query('DELETE FROM sales_invoices WHERE sales_order_id = ?', [so.id]);
  }
  // Clear the JOs' process/material lines first (job_order_processes FKs job_orders).
  const [jos] = await conn.query('SELECT id FROM job_orders WHERE sales_order_id = ?', [so.id]);
  if (jos.length) await conn.query('DELETE FROM job_order_processes WHERE job_order_id IN (?)', [jos.map((j) => j.id)]);
  // sales_order_lines.job_order_id and job_orders.sales_order_line_id reference each other
  // -- break the cycle by nulling the line's JO pointer before deleting either side.
  await conn.query('UPDATE sales_order_lines SET job_order_id = NULL WHERE sales_order_id = ?', [so.id]);
  await conn.query('DELETE FROM job_orders WHERE sales_order_id = ?', [so.id]);
  await conn.query('DELETE FROM sales_order_lines WHERE sales_order_id = ?', [so.id]);
  await conn.query('DELETE FROM sales_orders WHERE id = ?', [so.id]);
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- fetch + resolve + report only, nothing written.\n' : 'APPLYING to local.\n');

  const token = await login();
  const [[vat]] = await pool.query("SELECT id, code FROM taxes WHERE code = 'VAT12' LIMIT 1");
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE 'Head Office%' LIMIT 1");

  // Confirm the preset's reps exist locally; index their ids by normalized name. With
  // --preset=all the rep is resolved per sales order instead (created on miss).
  const repIdByNorm = new Map();
  for (const name of REPS) {
    const id = await resolveRep(name);
    repIdByNorm.set(repNorm(name), id);
    if (!id) console.warn(`!! Local employee not found for "${name}" -- their SOs will be skipped.`);
  }

  // 1) Collect the window's sales orders. fetchWindow binary-searches to the window instead of
  // paging from offset 0 (2021 starts around offset 70,000) and caches the raw rows on disk.
  const soRows = await fetchWindow(token, {
    endpoint: 'get_sales_orders', from: FROM, to: TO, keyField: 'so_upk',
    extra: { viewAll: true }, refresh: REFRESH, onProgress: (m) => console.log(m),
  });
  let voidSkipped = 0;
  const salesOrders = [];
  const seenSoNo = new Set();
  for (const so of soRows) {
    // --only narrows to specific orders; pass a --from/--to that covers their dates.
    if (ONLY.size && !ONLY.has(so.so_upk)) continue;
    // Never migrate voided / cancelled orders.
    if (isVoidOrCancelled(so.Status_TransH)) { voidSkipped += 1; continue; }
    if (!ALL_REPS && !REP_NORM_SET.has(repNorm(so.Name_Empl))) continue;
    // One local record per document number, even if live hands us the row twice.
    if (seenSoNo.has(so.so_upk)) continue;
    seenSoNo.add(so.so_upk);
    salesOrders.push(so);
  }
  console.log(ONLY.size
    ? `Found ${salesOrders.length}/${ONLY.size} requested SO(s) for re-sync.`
    : `Found ${salesOrders.length} sales order(s) in ${FROM}..${TO} for ${ALL_REPS ? 'ALL reps' : `preset ${PRESET}`} ` +
      `(${voidSkipped} void/cancelled skipped).`);

  // 2) Index invoices by SO number, out to INVOICE_TO so orders billed after the window still
  // get their invoice. On the invoice LIST the SO reference lives in sl_pk (e.g. "SO-70399")
  // and the invoice number in invc_pk -- the list uses different field names than the detail.
  const invRows = await fetchWindow(token, {
    endpoint: 'get_invoices', from: FROM, to: INVOICE_TO, keyField: 'invc_pk',
    refresh: REFRESH, onProgress: (m) => console.log(m),
  });
  const invoicesBySo = new Map();
  let voidInvoices = 0;
  for (const iv of invRows) {
    if (isVoidOrCancelled(iv.Status_TransH)) { voidInvoices += 1; continue; }
    const soNo = iv.sl_pk;
    if (!soNo) continue;
    if (!invoicesBySo.has(soNo)) invoicesBySo.set(soNo, []);
    invoicesBySo.get(soNo).push(iv);
  }
  console.log(`Indexed invoices (${FROM}..${INVOICE_TO}) for ${invoicesBySo.size} sales order(s); ${voidInvoices} void/cancelled skipped.\n`);

  let doneSo = 0, doneLines = 0, doneJos = 0, doneInvoices = 0, skipped = 0;
  const startedAt = Date.now();
  let seen = 0;

  // ---- recovery mode: add only the invoices an already-imported order is missing ----
  if (INVOICES_ONLY) {
    let added = 0, touched = 0, noLocal = 0;
    for (const so of salesOrders) {
      const wanted = invoicesBySo.get(so.so_upk) || [];
      if (!wanted.length) continue;
      const [[local]] = await pool.query(
        `SELECT so.id, so.sales_rep_id, so.office_location_id,
                (SELECT d.id FROM sales_divisions sd
                   JOIN departments d ON REPLACE(REPLACE(LOWER(d.name),' ',''),'-','') = REPLACE(REPLACE(LOWER(sd.name),' ',''),'-','')
                  WHERE sd.id = so.sales_division_id LIMIT 1) AS department_id
           FROM sales_orders so WHERE so.sales_order_no = ?`, [so.so_upk]);
      if (!local) { noLocal += 1; continue; }
      for (const ivHead of wanted) {
        const [[dup]] = await pool.query('SELECT id FROM sales_invoices WHERE invoice_no = ?', [ivHead.invc_pk]);
        if (dup) continue;
        const inv = await api(token, 'get_invoice', { pk: ivHead.SysPK_TransH });
        const h = inv.data?.[0] || ivHead;
        if (isVoidOrCancelled(h.Status_TransH)) continue;
        if (DRY_RUN) { added += 1; continue; }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [invRes] = await conn.query(
            `INSERT INTO sales_invoices (invoice_no, sales_order_id, date_created, date_due, term,
               bs_si_no, po_no, memo, department_id, subtotal,
               net_of_tax, tax_amount, gross_amount, amount_due, status, sales_rep_id, office_location_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ivHead.invc_pk, local.id, h.DateCreated_TransH || so.DateCreated_TransH, h.DateDue_TransH || null,
              clean(h.Term_TransH), trunc(h.ReferrenceNO_TransH, 60), trunc(h.PONo_TransH, 60), trunc(h.Memo_TransH, 500),
              local.department_id, num(h.SubTotalVatEx_TransH), num(h.SubTotalVatEx_TransH), num(h.TaxAmount_TransH),
              num(h.TotalAmount_TransH), num(h.AmountDue_TransH), invoiceStatus(h.Status_TransH),
              local.sales_rep_id, local.office_location_id]);
          for (const il of (inv.data?.[1] || [])) {
            await conn.query(
              `INSERT INTO sales_invoice_lines (sales_invoice_id, job_order_id, description, quantity, units,
                 price_per_unit, subtotal, net_of_tax, tax_code, tax_amount, gross_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [invRes.insertId, null, clean(il.DisplayDescription_LdgrInvty), num(il.Qty_LdgrInvty),
                il.UnitOfMeasure_LdgrInvty || null, num(il.Price_LdgrInvty), num(il.SubTotalAmountOut_LdgrInvty),
                num(il.SubTotalAmountOut_LdgrInvty), il.TaxCode_LdgrInvty || null, num(il.TaxAmount_LdgrInvty),
                num(il.TotalAmountOut_LdgrInvty)]);
          }
          await conn.commit();
          added += 1;
        } catch (e) { await conn.rollback(); console.warn(`!! ${ivHead.invc_pk} failed: ${e.message}`); }
        finally { conn.release(); }
      }
      touched += 1;
    }
    console.log(`\n--invoices-only: ${added} invoice(s) ${DRY_RUN ? 'would be' : ''} added across ${touched} existing order(s); ` +
      `${noLocal} order(s) not present locally.`);
    await pool.end();
    return;
  }

  for (const so of salesOrders) {
    // Whole-year runs process thousands of orders one at a time -- report progress and an ETA
    // so a long run is monitorable instead of silent until the end.
    seen += 1;
    if (seen % 100 === 0) {
      const mins = (Date.now() - startedAt) / 60000;
      const eta = mins / seen * (salesOrders.length - seen);
      console.log(`  ...${seen}/${salesOrders.length} SOs | ${doneSo} imported, ${doneJos} JOs, ${doneInvoices} invoices, ` +
        `${skipped} skipped | ${mins.toFixed(1)}m elapsed, ~${eta.toFixed(0)}m left`);
    }
    const repId = ALL_REPS
      ? await resolveRep(so.Name_Empl, true)
      : repIdByNorm.get(repNorm(so.Name_Empl));
    // In a dry run the missing employee isn't actually created, so don't count the order as
    // skipped -- the real run would create the rep and import it.
    if (!repId && !(DRY_RUN && ALL_REPS)) { skipped += 1; continue; }
    try {
      // Detail: ledger lines + the SO's job orders (SysPK -> JO number).
      const est = await api(token, 'get_estimate', { pk: so.so_pk });
      const lines = est.data?.[1] || [];
      const joList = listRows(await api(token, 'get_job_orders_for_cert', { soPK: so.so_pk }));
      const joByPk = new Map(joList.map((j) => [j.SysPK_TransH, j]));

      const customerId = await resolveCustomer(so.Name_Cust);
      const divisionId = await resolveDivision(so.Name_Dept);
      const departmentId = await resolveDepartment(so.Name_Dept);
      const contract = clean(so.ContractDescription_TransH) || so.so_upk;
      const soDate = so.DateCreated_TransH;
      // The contact person is on the job-order header (not the estimate header); pull it from
      // the SO's first JO if there is one.
      let contactSrc = est.data?.[0] || {};
      if (joList.length) {
        const jo0 = await api(token, 'get_job_order', { pk: joList[0].SysPK_TransH });
        contactSrc = (Array.isArray(jo0.data) ? jo0.data[0] : null) || contactSrc;
      }
      const contactPersonId = await resolveContact(customerId, contactSrc.Name_ContactP, contactSrc.Title_ContactP, contactSrc.Email_ContactP, contactSrc.ContactNo_ContactP);
      const estHeader = contactSrc;

      // Pre-resolve job types (also drives dry-run "to create" counts).
      for (const l of lines) await resolveJobType(l.transactionledgerjob_job?.DisplayName_Job);

      if (DRY_RUN) {
        doneSo += 1; doneLines += lines.length;
        doneJos += lines.filter((l) => l.SysFK_TransHJO_LdgrJob).length;
        doneInvoices += (invoicesBySo.get(so.so_upk) || []).length;
        continue;
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await deleteExistingSalesOrder(conn, so.so_upk);

        // Estimate: reuse by number if it already exists (one estimate can back several
        // SOs), else create. 'approved' is the closest valid status -- these were all
        // approved and converted to a Sales Order (estimates.status enum has no 'converted').
        const estNo = so.sl_upk || `EST-${so.so_upk}`;
        let estimateId;
        const [[existingEst]] = await conn.query('SELECT id FROM estimates WHERE estimate_no = ?', [estNo]);
        if (existingEst) {
          estimateId = existingEst.id;
        } else {
          const [estRes] = await conn.query(
            `INSERT INTO estimates (estimate_no, date_created, customer_id, contract_description, production_lead_time,
               sales_rep_id, sales_division_id, office_location_id, status, subtotal, net_of_tax, tax_total, total_amount)
             VALUES (?, ?, ?, ?, '', ?, ?, ?, 'approved', ?, ?, ?, ?)`,
            [estNo, soDate, customerId, contract, repId, divisionId,
              headOffice ? headOffice.id : null, num(so.SubTotalVatEx_TransH), num(so.SubTotalVatEx_TransH),
              num(so.TaxAmount_TransH), num(so.TotalAmount_TransH)]
          );
          estimateId = estRes.insertId;
        }

        const localSoStatus = soStatus(so.Status_TransH);
        const stage = joStageFromSo(localSoStatus);
        const [soRes] = await conn.query(
          `INSERT INTO sales_orders (sales_order_no, estimate_id, date_created, customer_id, contract_description,
             contact_person_id, contact_email, contact_title, contact_phone, ref_no,
             sales_rep_id, sales_division_id, office_location_id, status, subtotal, net_of_tax, tax_total, total_amount, est_gp_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [so.so_upk, estimateId, soDate, customerId, contract,
            contactPersonId, trunc(estHeader.Email_ContactP, 255), trunc(estHeader.Title_ContactP, 100), trunc(estHeader.ContactNo_ContactP, 100), trunc(so.ReferrenceNO_TransH, 100),
            repId, divisionId, headOffice ? headOffice.id : null,
            localSoStatus, num(so.SubTotalVatEx_TransH), num(so.SubTotalVatEx_TransH), num(so.TaxAmount_TransH),
            num(so.TotalAmount_TransH), num(so.gpRate)]
        );
        const salesOrderId = soRes.insertId;

        // Lines + Job Orders. Map ledger line -> SO line -> (optional) JO.
        const lineIdByPk = new Map();   // ledger line PK -> local SO line id
        const joIdByJobType = new Map(); // for invoice-line matching
        let lineNo = 0;
        for (const l of lines) {
          // Skip cancelled line-items -- live's order value (SubTotalVatEx) excludes them, so
          // including them would inflate weighted sales. (These carry Reason "Customer Cancels...".)
          if (l.IsCancelled_LdgrJob) continue;
          lineNo += 1;
          const jobTypeId = await resolveJobType(l.transactionledgerjob_job?.DisplayName_Job);
          const [lineRes] = await conn.query(
            `INSERT INTO sales_order_lines
               (sales_order_id, line_no, job_type_id, description, quantity, units, uom, price_per_unit,
                subtotal, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, gross_amount,
                gp_rate, length, width, height)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [salesOrderId, lineNo, jobTypeId, clean(l.Description_LdgrJob), num(l.Qty_LdgrJob),
              l.UnitOfMeasure_LdgrJob || null, l.Unit_LdgrJob || null, num(l.Price_LdgrJob),
              num(l.SubTotal_LdgrJob), num(l.DiscountPercent_LdgrJob), num(l.DiscountAmount_LdgrJob),
              num(l.VatExAmount_LdgrJob), vat ? vat.id : null, num(l.TaxAmount_LdgrJob), num(l.GrossAmount_LdgrJob),
              num(l.GPRate_LdgrJob), decOrNull(l.Length_LdgrJob), decOrNull(l.Width_LdgrJob), decOrNull(l.Height_LdgrJob)]
          );
          lineIdByPk.set(l.SysPK_LdgrJob, lineRes.insertId);

          if (l.SysFK_TransHJO_LdgrJob) {
            const liveJo = joByPk.get(l.SysFK_TransHJO_LdgrJob);
            const joNo = liveJo?.UserPK_TransH || `JO-${so.so_upk}-${lineNo}`;
            const [joRes] = await conn.query(
              `INSERT INTO job_orders (job_order_no, sales_order_line_id, sales_order_id, job_type_id, sales_rep_id,
                 quantity, units, description, status, production_stage)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Released', ?)`,
              [joNo, lineRes.insertId, salesOrderId, jobTypeId, repId, num(l.Qty_LdgrJob),
                l.UnitOfMeasure_LdgrJob || null, clean(l.Description_LdgrJob), stage]
            );
            await conn.query('UPDATE sales_order_lines SET job_order_id = ? WHERE id = ?', [joRes.insertId, lineRes.insertId]);
            if (jobTypeId && !joIdByJobType.has(jobTypeId)) joIdByJobType.set(jobTypeId, joRes.insertId);
            doneJos += 1;
          }
          doneLines += 1;
        }

        // Invoices for this SO.
        for (const ivHead of invoicesBySo.get(so.so_upk) || []) {
          // One local invoice per number. deleteExistingSalesOrder only clears invoices tied to
          // THIS order, so an invoice already imported against another parent (e.g. by the
          // delivery-ticket importer, which links converted DTs) must not be inserted again.
          const [[dupInv]] = await conn.query('SELECT id FROM sales_invoices WHERE invoice_no = ?', [ivHead.invc_pk]);
          if (dupInv) continue;
          const inv = await api(token, 'get_invoice', { pk: ivHead.SysPK_TransH });
          const h = inv.data?.[0] || ivHead;
          const invLines = inv.data?.[1] || [];
          if (isVoidOrCancelled(h.Status_TransH)) continue;
          const [invRes] = await conn.query(
            `INSERT INTO sales_invoices (invoice_no, sales_order_id, date_created, date_due, term,
               bs_si_no, po_no, memo, department_id, subtotal,
               net_of_tax, tax_amount, gross_amount, amount_due, status, sales_rep_id, office_location_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ivHead.invc_pk, salesOrderId, h.DateCreated_TransH || soDate, h.DateDue_TransH || null, clean(h.Term_TransH),
              trunc(h.ReferrenceNO_TransH, 60), trunc(h.PONo_TransH, 60), trunc(h.Memo_TransH, 500), departmentId, num(h.SubTotalVatEx_TransH),
              num(h.SubTotalVatEx_TransH), num(h.TaxAmount_TransH), num(h.TotalAmount_TransH),
              num(h.AmountDue_TransH), invoiceStatus(h.Status_TransH), repId, headOffice ? headOffice.id : null]
          );
          const invoiceId = invRes.insertId;
          for (const il of invLines) {
            // Best-effort link the invoice line to one of the SO's job orders by job type.
            const jt = await resolveJobType(il.DisplayName_Job);
            const joId = jt ? joIdByJobType.get(jt) || null : null;
            await conn.query(
              `INSERT INTO sales_invoice_lines (sales_invoice_id, job_order_id, description, quantity, units,
                 price_per_unit, subtotal, net_of_tax, tax_code, tax_amount, gross_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [invoiceId, joId, clean(il.DisplayDescription_LdgrInvty), num(il.Qty_LdgrInvty), il.UnitOfMeasure_LdgrInvty || null,
                num(il.Price_LdgrInvty), num(il.SubTotalAmountOut_LdgrInvty), num(il.SubTotalAmountOut_LdgrInvty),
                il.TaxCode_LdgrInvty || null, num(il.TaxAmount_LdgrInvty), num(il.TotalAmountOut_LdgrInvty)]
            );
          }
          doneInvoices += 1;
        }

        await conn.commit();
        doneSo += 1;
      } catch (err) {
        await conn.rollback();
        console.warn(`!! ${so.so_upk} failed: ${err.message}`);
        skipped += 1;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.warn(`!! ${so.so_upk} detail fetch failed: ${err.message}`);
      skipped += 1;
    }
  }

  console.log(`\n${DRY_RUN ? 'WOULD IMPORT' : 'Imported'}: ${doneSo} sales order(s), ${doneLines} line(s), ${doneJos} job order(s), ${doneInvoices} invoice(s).`);
  if (skipped) console.log(`Skipped ${skipped} sales order(s).`);
  console.log(`Refs -> customers ${DRY_RUN ? 'to create' : 'created'}: ${stats.customersCreated}, ` +
    `job types: ${stats.jobTypesCreated}, sales divisions: ${stats.divisionsCreated}, employees: ${stats.repsCreated}.`);
  if (stats.jobTypesMissingGp.length) {
    console.log(`\n!! ${stats.jobTypesMissingGp.length} job type(s) had no local match and get gp_rate_head=0 ` +
      '(their lines never count as passing GP until set):');
    console.log('   ' + [...new Set(stats.jobTypesMissingGp)].join(', '));
  }
  if (DRY_RUN) console.log('\nDRY RUN -- nothing written. Re-run without --dry-run to import.');
  await pool.end();
}

main().catch((err) => { console.error('\nImport failed:', err.message); process.exit(1); });
