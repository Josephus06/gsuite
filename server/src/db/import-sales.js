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
// Defaults to July 2026 if --from/--to are omitted.
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
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
// Live rep name -> we match the local employee by the same name.
const REPS = ['Michelle Riveral', 'Arjie Bayagna', 'Jocel Ann Berina', 'Catherine Jane  Langajed'];

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
async function api(token, ep, payload, ms = 90000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal,
    });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
const listRows = (res) => (Array.isArray(res.data?.[0]) ? res.data[0] : (res.data || []));

// ---- local FK resolvers (cached; create-on-miss per the chosen policy) ----
const cache = { customers: new Map(), jobTypes: new Map(), divisions: new Map(), reps: new Map() };
const stats = { customersCreated: 0, jobTypesCreated: 0, divisionsCreated: 0, jobTypesMissingGp: [] };

async function resolveCustomer(name) {
  const key = clean(name).toLowerCase();
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
  const key = clean(name).toLowerCase();
  if (!key) return null;
  if (cache.divisions.has(key)) return cache.divisions.get(key);
  const [[row]] = await pool.query('SELECT id FROM sales_divisions WHERE LOWER(name) = ? LIMIT 1', [key]);
  let id = row ? row.id : null;
  if (!id && !DRY_RUN) {
    const [r] = await pool.query('INSERT INTO sales_divisions (name, is_active) VALUES (?, 1)', [clean(name)]);
    id = r.insertId;
  }
  if (!row) stats.divisionsCreated += 1;
  cache.divisions.set(key, id);
  return id;
}
async function resolveRep(name) {
  const key = clean(name).toLowerCase();
  if (cache.reps.has(key)) return cache.reps.get(key);
  const [[row]] = await pool.query(
    "SELECT id FROM employees WHERE LOWER(CONCAT(first_name,' ',last_name)) = ? LIMIT 1", [key]
  );
  const id = row ? row.id : null;
  cache.reps.set(key, id);
  return id;
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

  // Confirm the 4 reps exist locally.
  const repIds = {};
  for (const name of REPS) {
    const id = await resolveRep(name);
    repIds[name] = id;
    if (!id) console.warn(`!! Local employee not found for "${name}" -- their SOs will be skipped.`);
  }

  // 1) Collect the 4 reps' July SOs (paginate newest-first until past July).
  // The list is newest-first; scan back until we've passed the window's start. The cap is
  // a safety backstop -- the early-stop below is what normally ends it (a wide window like
  // 6 months means scanning many pages of all-rep orders to collect just the 4 reps').
  const salesOrders = [];
  let offset = 0;
  while (offset < 40000) {
    const list = listRows(await api(token, 'get_sales_orders', { searchKey: '', viewAll: true, limit: 200, offset }));
    if (!list.length) break;
    for (const so of list) {
      const d = day(so.DateCreated_TransH);
      if (!REPS.includes(so.Name_Empl)) continue;
      // With --only, take just the listed SOs (any date in the scan); otherwise the date window.
      if (ONLY.size ? ONLY.has(so.so_upk) : (d >= FROM && d <= TO)) salesOrders.push(so);
    }
    if (list.every((so) => day(so.DateCreated_TransH) < FROM)) break;
    offset += 200;
  }
  console.log(ONLY.size
    ? `Found ${salesOrders.length}/${ONLY.size} requested SO(s) for re-sync.`
    : `Found ${salesOrders.length} sales order(s) for the 4 reps in ${FROM}..${TO}.`);

  // 2) Index invoices by SO number. An invoice for a window SO may be billed any time from
  // the window start onward, so index everything dated >= FROM (extra invoices are just
  // ignored when their SO isn't in the import set).
  const invoicesBySo = new Map();
  offset = 0;
  while (offset < 40000) {
    const list = listRows(await api(token, 'get_invoices', { searchKey: '', limit: 200, offset }));
    if (!list.length) break;
    for (const iv of list) {
      if (day(iv.DateCreated_TransH) < FROM) continue;
      // On the invoice LIST the SO reference lives in sl_pk (e.g. "SO-70399") and the
      // invoice number in invc_pk -- the list uses different field names than the detail.
      const soNo = iv.sl_pk;
      if (!soNo) continue;
      if (!invoicesBySo.has(soNo)) invoicesBySo.set(soNo, []);
      invoicesBySo.get(soNo).push(iv);
    }
    if (list.every((iv) => day(iv.DateCreated_TransH) < FROM)) break;
    offset += 200;
  }
  console.log(`Indexed invoices for ${invoicesBySo.size} sales order(s).\n`);

  let doneSo = 0, doneLines = 0, doneJos = 0, doneInvoices = 0, skipped = 0;

  for (const so of salesOrders) {
    const repId = repIds[so.Name_Empl];
    if (!repId) { skipped += 1; continue; }
    try {
      // Detail: ledger lines + the SO's job orders (SysPK -> JO number).
      const est = await api(token, 'get_estimate', { pk: so.so_pk });
      const lines = est.data?.[1] || [];
      const joList = listRows(await api(token, 'get_job_orders_for_cert', { soPK: so.so_pk }));
      const joByPk = new Map(joList.map((j) => [j.SysPK_TransH, j]));

      const customerId = await resolveCustomer(so.Name_Cust);
      const divisionId = await resolveDivision(so.Name_Dept);
      const contract = clean(so.ContractDescription_TransH) || so.so_upk;
      const soDate = so.DateCreated_TransH;

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
             sales_rep_id, sales_division_id, office_location_id, status, subtotal, net_of_tax, tax_total, total_amount, est_gp_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [so.so_upk, estimateId, soDate, customerId, contract, repId, divisionId, headOffice ? headOffice.id : null,
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
          const inv = await api(token, 'get_invoice', { pk: ivHead.SysPK_TransH });
          const h = inv.data?.[0] || ivHead;
          const invLines = inv.data?.[1] || [];
          const [invRes] = await conn.query(
            `INSERT INTO sales_invoices (invoice_no, sales_order_id, date_created, date_due, term,
               net_of_tax, tax_amount, gross_amount, amount_due, status, sales_rep_id, office_location_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ivHead.invc_pk, salesOrderId, h.DateCreated_TransH || soDate, h.DateDue_TransH || null, clean(h.Term_TransH),
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
    `job types: ${stats.jobTypesCreated}, sales divisions: ${stats.divisionsCreated}.`);
  if (stats.jobTypesMissingGp.length) {
    console.log(`\n!! ${stats.jobTypesMissingGp.length} job type(s) had no local match and get gp_rate_head=0 ` +
      '(their lines never count as passing GP until set):');
    console.log('   ' + [...new Set(stats.jobTypesMissingGp)].join(', '));
  }
  if (DRY_RUN) console.log('\nDRY RUN -- nothing written. Re-run without --dry-run to import.');
  await pool.end();
}

main().catch((err) => { console.error('\nImport failed:', err.message); process.exit(1); });
