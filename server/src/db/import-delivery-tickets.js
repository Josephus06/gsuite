// Migrates Delivery Tickets (DT-####) from the live GraphicStar system. A Delivery Ticket
// is an "internal invoice": issued when goods are delivered, it BILLS the sales order even
// though no Sales Invoice exists yet. When the client actually pays, the DT is CONVERTED to
// a real Sales Invoice (INV-####). So an SO can sit at status 'billed' backed only by a DT --
// which is why those SOs have no sales_invoice row. This fills that gap.
//
// Live shape (reverse-engineered):
//   get_delivery_tickets {searchKey,limit,offset}  -> header list; sl_pk = SO#, dt_pk = DT#,
//       Status_TransH OPEN|CONVERTED|VOID, SubTotalVatEx/TaxAmount/TotalAmount, Name_Empl(rep).
//   get_invoice {pk: DT.SysPK_TransH}              -> data[1] = the DT's LdgrInvty lines.
//       (OPEN tickets only -- once CONVERTED the pk resolves to the invoice, so no DT lines.)
//
// GL: glImpact.js already posts *open* delivery_tickets (Dr 12101 AR-Unbilled / Cr 30100 / Cr
// 21100); converted ones are represented by their invoice, so we don't double-count.
//
// Scoped to a rep preset + date window, matched to already-imported SOs. Idempotent by dt_no.
//   node src/db/import-delivery-tickets.js --preset=sales2 --from=2026-01-01 --to=2026-07-31 --dry-run
//   node src/db/import-delivery-tickets.js --preset=sales2 --from=2026-01-01 --to=2026-07-31
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-07-31');

const REP_PRESETS = {
  sales1: ['Michelle Riveral', 'Arjie Bayagna', 'Jocel Ann Berina', 'Catherine Jane Langajed'],
  sales3: ['JOJI ANN NICOLE FUENTES', 'Margie Lyn C. Cañete', 'Jerome Magale', 'Paul Adam T. Oporto', 'Vanessa Krystal Jean Garcia'],
  sales2: ['Nina Ann Solano', 'Glenn Valencia', 'Arlene Arimbay', 'Jessa Mae Lagat', 'Katherine Benigay'],
  sales4: ['Amelyn A. Pen', 'Lindy Casires', 'Claire Real', 'Jerusha Gwyneth Del Mar'],
  marketing: ['Jocelyn Ybañez', 'Ronel Parreño'],
  branches: ['ROSELYN P. TUNDAG', 'EUNICE EDAÑO GEYROZAGA', 'Cindy Marie Deniay_AYALA', 'Cindy Marie Deniay_SM', 'Dexter Bantilan', 'Alessa Pacinio', 'Precious Artista'],
};
const REPS = REP_PRESETS[argVal('preset', 'sales2')] || REP_PRESETS.sales2;
const repNorm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
const REP_NORM_SET = new Set(REPS.map(repNorm));

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (v) => (v == null ? null : String(v).trim());
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const day = (v) => (v || '').toString().slice(0, 10);
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function api(token, ep, payload, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function apiRetry(token, ep, payload, attempts = 4) {
  let last; for (let a = 0; a < attempts; a += 1) {
    try { return await api(token, ep, payload, 60000 + a * 20000); }
    catch (e) { last = e; await sleep(1200 * (a + 1)); }
  }
  throw last;
}

function dtStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'void';
  if (s.includes('CONVERT')) return 'converted';
  return 'open';
}
function invoiceStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  if (s.includes('PAID')) return 'paid_in_full';
  return 'saved';
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Preset: ${argVal('preset', 'sales2')} | window ${FROM}..${TO}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing written.\n' : 'APPLYING.\n');

  // Local SOs for the preset reps -> their id + attribution fields, keyed by SO number.
  const [sos] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.sales_rep_id, so.office_location_id,
            (SELECT dept.id FROM sales_divisions sd
               JOIN departments dept ON REPLACE(REPLACE(LOWER(dept.name),' ',''),'-','') = REPLACE(REPLACE(LOWER(sd.name),' ',''),'-','')
              WHERE sd.id = so.sales_division_id LIMIT 1) AS department_id
       FROM sales_orders so
       JOIN employees e ON e.id = so.sales_rep_id
      WHERE LOWER(CONCAT(e.first_name, ' ', e.last_name)) IN (?)`,
    [REPS.map((r) => r.toLowerCase())]);
  const soByNo = new Map(sos.map((s) => [s.sales_order_no, s]));
  console.log(`Local SOs for these reps: ${soByNo.size}`);

  // Resolve local item ids for DT lines (best-effort by item code / description).
  const [invs] = await pool.query('SELECT id, item_code, display_name, sales_description FROM inventories');
  const invByKey = new Map();
  for (const it of invs) { for (const k of [it.item_code, it.display_name, it.sales_description]) { const key = repNorm(k); if (key && !invByKey.has(key)) invByKey.set(key, it.id); } }

  const token = await login();

  // Page delivery tickets newest-first; keep those whose SO we imported and whose rep is in
  // the preset, within the window.
  const tickets = [];
  const seenDt = new Set();
  for (let offset = 0; offset < 60000; offset += 200) {
    let list;
    try { list = listRows(await apiRetry(token, 'get_delivery_tickets', { searchKey: '', limit: 200, offset })); }
    catch (e) { console.warn(`  page ${offset} failed: ${e.message}`); break; }
    if (!list.length) break;
    for (const dt of list) {
      const d = day(dt.DateCreated_TransH);
      if (d < FROM || d > TO) continue;
      // Scope is the SO set (already rep+window filtered when it was imported). The DT's own
      // Name_Empl can differ from the order's sales rep, so don't filter on it -- that would
      // drop legitimate tickets for these SOs.
      if (!soByNo.has(dt.sl_pk)) continue;
      if (seenDt.has(dt.dt_pk)) continue;
      seenDt.add(dt.dt_pk);
      tickets.push(dt);
    }
    if (list.every((dt) => day(dt.DateCreated_TransH) < FROM)) break;
  }
  console.log(`Matched ${tickets.length} delivery ticket(s) for the preset reps in window.`);

  if (DRY_RUN) {
    const byStatus = {};
    for (const dt of tickets) { const s = dtStatus(dt.Status_TransH); byStatus[s] = (byStatus[s] || 0) + 1; }
    console.log('By status:', JSON.stringify(byStatus));
    console.log('\nDRY RUN -- nothing written.');
    await pool.end();
    return;
  }

  let created = 0, replaced = 0, linesInserted = 0, linked = 0, openNoLines = 0, invoicesImported = 0, convNoInvoice = 0;
  for (const dt of tickets) {
    const so = soByNo.get(dt.sl_pk);
    const status = dtStatus(dt.Status_TransH);
    const gross = num(dt.TotalAmount_TransH);
    const netExVat = num(dt.SubTotalVatEx_TransH);
    const tax = num(dt.TaxAmount_TransH);
    // Lines: only OPEN tickets still resolve their LdgrInvty detail via get_invoice; a
    // converted ticket's pk now points at the invoice, so it returns no ticket lines.
    let detailLines = [];
    if (status === 'open') {
      try { const det = await apiRetry(token, 'get_invoice', { pk: dt.SysPK_TransH }); detailLines = Array.isArray(det?.data?.[1]) ? det.data[1] : []; }
      catch (e) { /* leave lines empty; header still records the billing */ }
      if (!detailLines.length) openNoLines += 1;
    }

    // For a converted ticket, locate the Sales Invoice it became -- the invoice's sl_pk is
    // this DT's number (not the SO number). Fetch its header + lines so we can import it.
    let convertedInvoice = null;
    if (status === 'converted') {
      try {
        const cand = listRows(await apiRetry(token, 'get_invoices', { searchKey: dt.dt_pk, limit: 20, offset: 0 }))
          .find((iv) => iv.sl_pk === dt.dt_pk);
        if (cand) {
          const det = await apiRetry(token, 'get_invoice', { pk: cand.SysPK_TransH });
          convertedInvoice = { no: cand.invc_pk, header: (det?.data?.[0] || cand), lines: Array.isArray(det?.data?.[1]) ? det.data[1] : [] };
        }
      } catch (e) { /* fall through: DT header still records the billing */ }
      if (!convertedInvoice) convNoInvoice += 1;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[existing]] = await conn.query('SELECT id FROM delivery_tickets WHERE dt_no = ?', [dt.dt_pk]);
      if (existing) {
        await conn.query('DELETE FROM delivery_ticket_lines WHERE delivery_ticket_id = ?', [existing.id]);
        await conn.query('DELETE FROM delivery_tickets WHERE id = ?', [existing.id]);
        replaced += 1;
      } else created += 1;

      const [dtRes] = await conn.query(
        `INSERT INTO delivery_tickets
           (dt_no, sales_order_id, date_created, date_due, term, po_no, sales_rep_id, office_location_id,
            department_id, memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, amount_due, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [dt.dt_pk, so.id, day(dt.DateCreated_TransH) || FROM, day(dt.DateDue_TransH) || null, trunc(dt.Term_TransH, 60),
         trunc(dt.PONo_TransH, 60), so.sales_rep_id, so.office_location_id, so.department_id, trunc(dt.Memo_TransH, 500),
         netExVat, 0, netExVat, tax, gross, status === 'open' ? gross : 0, status]);
      const dtId = dtRes.insertId;

      let ln = 0;
      for (const l of detailLines) {
        ln += 1;
        const itemId = invByKey.get(repNorm(l.UserPK_Invty)) ?? invByKey.get(repNorm(l.DisplayDescription_LdgrInvty)) ?? null;
        await conn.query(
          `INSERT INTO delivery_ticket_lines
             (delivery_ticket_id, line_no, item_id, item_name, description, quantity, units, price_per_unit,
              subtotal, disc_percent, disc_amount, net_of_tax, tax_code, tax_amount, gross_amount)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [dtId, ln, itemId, trunc(l.UserPK_Invty, 255), trunc(l.DisplayDescription_LdgrInvty, 500),
           num(l.Qty_LdgrInvty), trunc(l.UnitOfMeasure_LdgrInvty, 30), num(l.Price_LdgrInvty),
           num(l.SubTotalAmountOut_LdgrInvty), num(l.DiscountPercent_LdgrInvty), num(l.DiscountAmount_LdgrInvty),
           num(l.Total_LdgrInvty), trunc(l.TaxCode_LdgrInvty, 30), num(l.TaxAmount_LdgrInvty), num(l.TotalAmountOut_LdgrInvty)]);
        linesInserted += 1;
      }

      // A converted ticket became a Sales Invoice on payment. Crucially, that invoice's SO
      // reference (sl_pk) is the DT number, not the SO number -- so import-sales.js (which
      // matches invoices by SO number) never imported it, leaving these billed SOs with no
      // invoice and no revenue GL. Fetch it here by the DT number and import it, linked to
      // both the SO and this ticket.
      if (status === 'converted' && convertedInvoice) {
        const ih = convertedInvoice.header;
        const [[existsInv]] = await conn.query('SELECT id FROM sales_invoices WHERE invoice_no = ?', [convertedInvoice.no]);
        if (existsInv) {
          await conn.query('UPDATE sales_invoices SET delivery_ticket_id = ?, sales_order_id = ? WHERE id = ?', [dtId, so.id, existsInv.id]);
          linked += 1;
        } else {
          const [ivRes] = await conn.query(
            `INSERT INTO sales_invoices (invoice_no, sales_order_id, delivery_ticket_id, date_created, date_due, term,
               bs_si_no, po_no, memo, department_id, subtotal, net_of_tax, tax_amount, gross_amount, amount_due,
               status, sales_rep_id, office_location_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [convertedInvoice.no, so.id, dtId, day(ih.DateCreated_TransH) || day(dt.DateCreated_TransH), day(ih.DateDue_TransH) || null,
             trunc(ih.Term_TransH, 60), trunc(ih.ReferrenceNO_TransH, 60), trunc(ih.PONo_TransH, 60), trunc(ih.Memo_TransH, 500),
             so.department_id, num(ih.SubTotalVatEx_TransH), num(ih.SubTotalVatEx_TransH), num(ih.TaxAmount_TransH),
             num(ih.TotalAmount_TransH), num(ih.AmountDue_TransH), invoiceStatus(ih.Status_TransH), so.sales_rep_id, so.office_location_id]);
          const invId = ivRes.insertId;
          let iln = 0;
          for (const il of convertedInvoice.lines) {
            iln += 1;
            await conn.query(
              `INSERT INTO sales_invoice_lines (sales_invoice_id, job_order_id, description, quantity, units,
                 price_per_unit, subtotal, net_of_tax, tax_code, tax_amount, gross_amount)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
              [invId, null, trunc(il.DisplayDescription_LdgrInvty, 500), num(il.Qty_LdgrInvty), trunc(il.UnitOfMeasure_LdgrInvty, 30),
               num(il.Price_LdgrInvty), num(il.SubTotalAmountOut_LdgrInvty), num(il.SubTotalAmountOut_LdgrInvty),
               trunc(il.TaxCode_LdgrInvty, 30), num(il.TaxAmount_LdgrInvty), num(il.TotalAmountOut_LdgrInvty)]);
          }
          invoicesImported += 1;
        }
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); console.error(`  [error] ${dt.dt_pk}: ${e.message}`); }
    finally { conn.release(); }
  }

  console.log(`\nDone. Delivery tickets: ${created} new, ${replaced} replaced; ${linesInserted} line(s) inserted.`);
  console.log(`Converted-DT invoices imported: ${invoicesImported}, linked to existing: ${linked}, no invoice found: ${convNoInvoice}.`);
  console.log(`Open tickets with no resolvable lines: ${openNoLines}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
