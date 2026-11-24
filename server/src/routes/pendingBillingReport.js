const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { hasSoAttachmentKind } = require('../lib/soAttachmentKind');

const router = express.Router();

// pending_billing_marks.sent_date (2026-11-13, add-pending-billing-sent-date.js): the date the PAR &
// Pics hard copy was sent, asked when wt PAR&Pics is ticked by hand. Checked once; until the column
// is added the tick works as before, without the date.
let sentDateCol = null;
async function hasSentDate() {
  if (sentDateCol === null) {
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pending_billing_marks' AND COLUMN_NAME = 'sent_date'`);
    sentDateCol = !!c.n;
  }
  return sentDateCol;
}

// Sales > Pending Billing: Job Orders that went through Assembly Build, Quality Inspection AND Item
// Delivery but are not yet (fully) on a Delivery Ticket or an Invoice -- delivered and waiting for
// the bill (2026-10-28). To Bill = the quantity delivered less what DTs and invoices already cover.
//
// Not production_stage: the status sync moves EVERY JO of an order to 'completed' once the source
// calls the order Pending Billing, which it does as soon as one JO is done -- SO-49071's
// JO-49071-11-11 (installation, no build, QI or delivery at the source) listed its full amount. "Invoiced" is counted from the
// invoice LINES that name the JO (not cancelled), NOT job_orders.quantity_invoiced -- that counter
// was never filled in for migrated JOs (117k fully-billed JOs read 0 there).
//
// Non-standard JOs (NSJO: internal, sample, RMA work), rework (RWIP) and QC replacements (RFQC) are
// left out: they are not billed to a customer (see loadRows). Price per unit is the SO line's, so
// Unbilled Amount = uninvoiced qty x that line's gross per unit.
const ROUTE = '/reports/pending-billing';

// How much of each JO has been invoiced, worked out per SALES ORDER (2026-10-09). The migration hung
// a multi-JO order's invoice lines on one of its JOs -- INV-80490 billed JO-69846-2-2's 50
// certificates but names JO-69846-1-2 -- so counting only the lines that name a JO listed ~30,000
// JOs whose order was already fully billed. Now:
//   1. a line that names a JO counts for it, up to that JO's quantity;
//   2. what is left -- a line naming no JO, or more than its JO's quantity -- goes to the order's
//      other JOs: first to one whose outstanding quantity is exactly that amount, then in JO order.
// Every live JO on the order takes its share, completed or not, so billing a JO still in production
// is not handed to a completed sibling.
//
// A line that names one JO but carries ANOTHER JO's description word for word counts for that other
// JO (2026-10-28): INV-19162 "LEAR NOTEBOOK" was migrated onto JO-14012-5-8 (LEAR BROCHURE), so the
// notebook JO-14012-6-8 read unbilled though the source shows it invoiced. A line naming no JO goes
// first to the one JO on the order whose description it matches.
//
// An OPEN Delivery Ticket bills too (2026-10-09): DT-6339 billed SO-71070's nine completed JOs and they
// still read pending. Only open ones -- a converted DT's billing is already on its invoice, and a
// void one bills nothing. Their lines name no JO, so they are shared out the same way.
// A CONVERTED one that became no invoice bills too (2026-10-28: SO-55784, a 0.00 sponsorship billed on
// DT-4248 and converted without an invoice); db/backfill-converted-dt-lines.js brings in its lines.
const descKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function invoicedByJobOrder(jos) {
  const joIds = jos.map((j) => j.id);
  const soIds = [...new Set(jos.map((j) => j.sales_order_id).filter(Boolean))];
  const [[siblings], [lines]] = await Promise.all([
    pool.query(
      `SELECT id, sales_order_id, quantity, description FROM job_orders
        WHERE sales_order_id IN (?) AND (status IS NULL OR status <> 'Cancelled')`, [soIds.concat(0)]),
    pool.query(
      `SELECT l.job_order_id, l.quantity, l.description, si.invoice_no, si.sales_order_id
         FROM sales_invoice_lines l JOIN sales_invoices si ON si.id = l.sales_invoice_id
        WHERE si.status <> 'cancelled' AND (l.job_order_id IN (?) OR si.sales_order_id IN (?))
       UNION ALL
       SELECT l.job_order_id, l.quantity, l.description, d.dt_no, d.sales_order_id
         FROM delivery_ticket_lines l JOIN delivery_tickets d ON d.id = l.delivery_ticket_id
        WHERE (d.status = 'open'
               -- A converted ticket that became no invoice (a 0.00 sponsorship, 2026-10-28) bills by itself.
               OR (d.status = 'converted' AND NOT EXISTS (
                    SELECT 1 FROM sales_invoices x WHERE x.delivery_ticket_id = d.id AND x.status <> 'cancelled')))
          AND (l.job_order_id IN (?) OR d.sales_order_id IN (?))`,
      [joIds, soIds.concat(0), joIds, soIds.concat(0)]),
  ]);
  const jo = new Map();
  for (const j of [...siblings, ...jos]) {
    if (!jo.has(Number(j.id))) jo.set(Number(j.id), { so: j.sales_order_id ? Number(j.sales_order_id) : null, qty: Number(j.quantity || 0), desc: descKey(j.description), got: 0, invoices: new Set() });
  }
  // so id -> description -> the one JO with it (null when two JOs share it).
  const byDesc = new Map();
  for (const [id, j] of jo) {
    if (!j.so || !j.desc) continue;
    if (!byDesc.has(j.so)) byDesc.set(j.so, new Map());
    const m = byDesc.get(j.so);
    m.set(j.desc, m.has(j.desc) ? null : id);
  }
  const jobOfLine = (l) => {
    const named = l.job_order_id ? jo.get(Number(l.job_order_id)) : null;
    const key = descKey(l.description);
    if (named && (!key || named.desc === key)) return named;
    const so = named?.so || (l.sales_order_id ? Number(l.sales_order_id) : null);
    const match = key && so ? byDesc.get(so)?.get(key) : null;
    return match ? jo.get(match) : named;
  };
  const pool_ = new Map(); // so id -> [{ qty, invoice_no }]
  const toPool = (so, qty, invoiceNo) => {
    if (!so || qty <= 0.0001) return;
    if (!pool_.has(so)) pool_.set(so, []);
    pool_.get(so).push({ qty, invoice_no: invoiceNo });
  };
  for (const l of lines) {
    const q = Number(l.quantity || 0);
    const j = jobOfLine(l);
    if (!j) { toPool(l.sales_order_id ? Number(l.sales_order_id) : null, q, l.invoice_no); continue; }
    const take = Math.min(q, Math.max(j.qty - j.got, 0));
    if (take > 0) { j.got += take; j.invoices.add(l.invoice_no); }
    toPool(j.so || (l.sales_order_id ? Number(l.sales_order_id) : null), q - take, l.invoice_no);
  }
  const bySo = new Map();
  for (const [id, j] of jo) { if (j.so) { if (!bySo.has(j.so)) bySo.set(j.so, []); bySo.get(j.so).push([id, j]); } }
  for (const [so, chunks] of pool_) {
    const mine = (bySo.get(so) || []).sort((a, b) => a[0] - b[0]);
    for (const c of chunks) {
      const exact = mine.find(([, j]) => Math.abs(j.qty - j.got - c.qty) < 0.0001);
      for (const [, j] of exact ? [exact] : mine) {
        if (c.qty <= 0.0001) break;
        const take = Math.min(c.qty, Math.max(j.qty - j.got, 0));
        if (take <= 0) continue;
        j.got += take; c.qty -= take; j.invoices.add(c.invoice_no);
      }
    }
  }
  return new Map(joIds.map((id) => {
    const j = jo.get(Number(id));
    return [Number(id), { qty: j.got, invoice_nos: j.invoices.size ? [...j.invoices].sort().join(', ') : null }];
  }));
}

// Batched rather than one big query with per-row subqueries (that took ~30 s): pick the completed
// JOs first -- a few thousand at most -- then read their invoices, QIs, deliveries and order lines
// in one keyed query each (indexes added by register-pending-billing-page.js).
// allReps: the whole company, whoever is asking -- the General Manager's dashboard card.
async function loadRows(req, { allReps = false } = {}) {
  const { search, sales_rep_id: rep, customer_id: customerId, from, to, location_id: locationId } = req.query;
  const where = ['COALESCE(jo.quantity_built, 0) > 0', 'COALESCE(jo.quantity_inspected, 0) > 0', 'COALESCE(jo.quantity_delivered, 0) > 0',
    // The source already calls it billed (its order went Billed): old migrated orders whose invoices
    // never came over with JO lines would otherwise flood the list (1,301 locally, 2026-10-28).
    "(jo.production_stage IS NULL OR jo.production_stage <> 'invoiced')", "(jo.status IS NULL OR jo.status <> 'Cancelled')"];
  const params = [];
  // Never billed to a customer, so never listed (2026-10-12; the Include checkbox is gone):
  //   NSJO   a Non-Standard SO's JO -- RMA, internal (INT), sample (SAM)
  //   RWIP   rework in process     \  on an ordinary SO line, so the NSSO test alone let them
  //   RFQC   failed-QC replacement /   through (RFQC-2 on SO-603 at the top of the list)
  where.push('jo.nsso_id IS NULL', "jo.job_order_no NOT LIKE 'NSJO-%'", "jo.job_order_no NOT LIKE 'RWIP-%'", "jo.job_order_no NOT LIKE 'RFQC-%'");
  const scope = allReps ? null : await getSalesRepEmployeeScope(req.user.id, ROUTE);
  if (scope) { where.push('COALESCE(so.sales_rep_id, ns.sales_rep_id, jo.sales_rep_id) IN (?)'); params.push(scope.length ? scope : [0]); }
  if (rep) { where.push('COALESCE(so.sales_rep_id, ns.sales_rep_id, jo.sales_rep_id) = ?'); params.push(rep); }
  if (customerId) { where.push('COALESCE(so.customer_id, ns.customer_id) = ?'); params.push(customerId); }
  // Office Location (2026-10-09): the SO's (or NSSO's) office -- the page starts on Head Office.
  if (locationId) { where.push('COALESCE(so.office_location_id, ns.office_location_id) = ?'); params.push(locationId); }
  if (search) {
    where.push('(jo.job_order_no LIKE ? OR so.sales_order_no LIKE ? OR ns.nsso_no LIKE ? OR c.name LIKE ? OR jo.description LIKE ?)');
    const q = `%${String(search).trim()}%`; params.push(q, q, q, q, q);
  }
  // One Job Order (the Email button, 2026-11-24).
  if (Number(req.query.job_order_id) > 0) { where.push('jo.id = ?'); params.push(Number(req.query.job_order_id)); }
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced,
            COALESCE(so.sales_rep_id, ns.sales_rep_id, jo.sales_rep_id) AS sales_rep_id,
            jo.production_stage, jo.delivery_date, jo.units, jo.nsso_id, jo.sales_order_line_id, jo.nsso_line_id,
            so.id AS sales_order_id, so.sales_order_no, so.date_created AS so_date, ns.nsso_no, ns.type AS nsso_type,
            COALESCE(so.customer_id, ns.customer_id) AS customer_id, c.name AS customer_name,
            CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name, sd.name AS department_name,
            LEAST(jo.quantity, jo.quantity_delivered) AS completed_qty
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(so.customer_id, ns.customer_id)
       LEFT JOIN employees sr ON sr.id = COALESCE(so.sales_rep_id, ns.sales_rep_id, jo.sales_rep_id)
       LEFT JOIN sales_divisions sd ON sd.id = COALESCE(so.sales_division_id, ns.sales_division_id)
      WHERE ${where.join(' AND ')}`, params);
  if (!jos.length) return [];
  const ids = jos.map((j) => j.id);
  const byJo = (rows) => new Map(rows.map((r) => [Number(r.job_order_id), r]));
  // wt PO / wt PAR&Pics (2026-11-04): the SO has a file typed PO, the JO one typed PAR & Pics -- or a
  // user with can_update here ticked the box by hand (pending_billing_marks; PO marks are per SO).
  const soIds = [...new Set(jos.map((j) => j.sales_order_id).filter(Boolean))].concat(0);
  const withKind = await hasSoAttachmentKind();
  const sentCol = withKind && await hasSentDate();
  const [invM, [qis], [dels], [solRows], [nslRows], [poRows], [parRows], [picRows], [markRows]] = await Promise.all([
    invoicedByJobOrder(jos),
    pool.query(`SELECT job_order_id, MAX(date_created) d FROM quality_inspections
                 WHERE job_order_id IN (?) AND (status IS NULL OR status <> 'cancelled') GROUP BY job_order_id`, [ids]),
    pool.query(`SELECT dl.job_order_id, MAX(d.date_created) d FROM item_delivery_lines dl JOIN item_deliveries d ON d.id = dl.item_delivery_id
                 WHERE dl.job_order_id IN (?) AND (d.status IS NULL OR d.status <> 'cancelled') GROUP BY dl.job_order_id`, [ids]),
    pool.query('SELECT id, sales_order_id, line_no, job_order_id, quantity, gross_amount FROM sales_order_lines WHERE sales_order_id IN (?)',
      [[...new Set(jos.map((j) => j.sales_order_id).filter(Boolean))].concat(0)]),
    pool.query('SELECT id, quantity, gross_amount FROM non_standard_sales_order_lines WHERE id IN (?)',
      [[...new Set(jos.map((j) => j.nsso_line_id).filter(Boolean))].concat(0)]),
    // A file typed PO -- or, attached before files had a type (kind NULL), one whose NAME reads as a PO
    // (asked 2026-11-10: SO-195971's "PO 4500007724.pdf" left wt PO unticked).
    withKind ? pool.query(
      `SELECT DISTINCT sales_order_id FROM sales_order_attachments
        WHERE sales_order_id IN (?) AND (kind = 'PO' OR (kind IS NULL AND (
          LOWER(file_name) REGEXP '(^|[^a-z])(po|p[.]o[.]?)([^a-z]|$)' OR LOWER(file_name) LIKE '%purchase order%')))`, [soIds]) : [[]],
    // wt PAR and wt PICS are separate columns (asked 2026-11-24). 'PAR' / 'Picture' since 2026-11-09
    // (Production Attachment's types); an older 'PAR & Pics' file ticks both.
    pool.query("SELECT DISTINCT job_order_id FROM job_order_attachments WHERE kind IN ('PAR', 'PAR & Pics') AND job_order_id IN (?)", [ids]),
    pool.query("SELECT DISTINCT job_order_id FROM job_order_attachments WHERE kind IN ('Picture', 'Pictures', 'PAR & Pics') AND job_order_id IN (?)", [ids]),
    withKind ? pool.query(
      `SELECT m.target, m.target_id, m.marked_at, ${sentCol ? "DATE_FORMAT(m.sent_date, '%Y-%m-%d')" : 'NULL'} AS sent_date, u.display_name AS marked_by FROM pending_billing_marks m
         LEFT JOIN users u ON u.id = m.marked_by_user_id
        WHERE (m.target IN ('par', 'pics', 'email') AND m.target_id IN (?)) OR (m.target = 'po' AND m.target_id IN (?))`, [ids, soIds]) : [[]],
  ]);
  const marks = new Map(markRows.map((m) => [`${m.target}|${m.target_id}`, m]));
  const markOf = (target, id) => { const m = marks.get(`${target}|${Number(id)}`); return m ? { by: m.marked_by, at: m.marked_at, sent: m.sent_date || null } : null; };
  const withPo = new Set(poRows.map((r) => Number(r.sales_order_id)));
  const withPar = new Set(parRows.map((r) => Number(r.job_order_id)));
  const withPics = new Set(picRows.map((r) => Number(r.job_order_id)));
  const qiM = byJo(qis); const delM = byJo(dels);
  const solById = new Map(solRows.map((l) => [Number(l.id), l]));
  const solByJo = new Map(solRows.filter((l) => l.job_order_id).map((l) => [Number(l.job_order_id), l]));
  const solBySoLine = new Map(solRows.map((l) => [`${l.sales_order_id}|${l.line_no}`, l]));
  const nslById = new Map(nslRows.map((l) => [Number(l.id), l]));
  const perUnit = (l) => (l && Number(l.quantity) ? Number(l.gross_amount || 0) / Number(l.quantity) : 0);
  const today = new Date(new Date().toLocaleDateString('en-CA'));
  const out = [];
  for (const j of jos) {
    // The SO line: the JO's own link, else the line that names the JO, else the line number in
    // the JO number (JO-<so>-<line>-<n>) -- every completed sales JO resolves one of these ways.
    const lineNo = Number(String(j.job_order_no || '').split('-')[2]);
    const sol = solById.get(Number(j.sales_order_line_id)) || solByJo.get(Number(j.id)) || solBySoLine.get(`${j.sales_order_id}|${lineNo}`);
    const unit = j.nsso_id ? perUnit(nslById.get(Number(j.nsso_line_id))) : perUnit(sol);
    const i = invM.get(Number(j.id));
    // Or the JO's own Invoiced counter, when higher (2026-10-28): the source calls JO-23809-4-5 invoiced
    // 24 of 24 -- DT-2341 delivered 24 and was converted -- though INV-40262's line says 20.
    // db/sync-jo-invoiced-from-source.js copies the source's figure there.
    const invoiced = Math.max(Number(i?.qty || 0), Number(j.quantity_invoiced || 0));
    const uninvoiced = Number(j.completed_qty || 0) - invoiced;
    // A remainder under 0.05 of a piece is decimal noise in the invoice quantities, not something to
    // bill (2026-10-28, JO-6906-1-1: To Bill 0.01 of 168, Invoiced 168).
    if (uninvoiced < 0.05) continue;
    const completed = qiM.get(Number(j.id))?.d || null;
    const done = completed || j.so_date;
    const doneDay = done ? String(done instanceof Date ? done.toISOString() : done).slice(0, 10) : null;
    if (from && (!doneDay || doneDay < from)) continue;
    if (to && (!doneDay || doneDay > to)) continue;
    out.push({
      ...j, unit_gross: unit, // *_file: an attachment ticks it (and it cannot be unticked); *_mark: ticked by hand.
      par_file: withPar.has(Number(j.id)), par_mark: markOf('par', j.id),
      pics_file: withPics.has(Number(j.id)), pics_mark: markOf('pics', j.id),
      po_file: withPo.has(Number(j.sales_order_id)), po_mark: j.sales_order_id ? markOf('po', j.sales_order_id) : null,
      with_par: withPar.has(Number(j.id)) || !!markOf('par', j.id),
      with_pics: withPics.has(Number(j.id)) || !!markOf('pics', j.id),
      // The last reminder emailed to the sales rep (POST /email): who sent it and when.
      email_mark: markOf('email', j.id),
      with_po: withPo.has(Number(j.sales_order_id)) || !!(j.sales_order_id && markOf('po', j.sales_order_id)), invoiced_qty: invoiced, invoice_nos: i?.invoice_nos || null,
      completed_date: completed, last_delivery_date: delM.get(Number(j.id))?.d || null,
      uninvoiced_qty: Number(uninvoiced.toFixed(4)),
      unbilled_amount: Number((uninvoiced * unit).toFixed(2)),
      days_pending: doneDay ? Math.max(0, Math.floor((today - new Date(doneDay)) / 86400000)) : null,
    });
  }
  out.sort((a, b) => String(a.completed_date || a.so_date || '').localeCompare(String(b.completed_date || b.so_date || '')) || String(a.job_order_no).localeCompare(String(b.job_order_no)));
  return out;
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await loadRows(req);
    const totals = rows.reduce((t, r) => ({
      jobs: t.jobs + 1, qty: t.qty + r.uninvoiced_qty, amount: t.amount + r.unbilled_amount,
      over30: t.over30 + (r.days_pending > 30 ? r.unbilled_amount : 0),
    }), { jobs: 0, qty: 0, amount: 0, over30: 0 });
    totals.amount = Number(totals.amount.toFixed(2)); totals.over30 = Number(totals.over30.toFixed(2));
    res.json({ rows, totals });
  } catch (err) {
    next(err);
  }
});

// Tick or untick wt PAR (target 'par', a JO id), wt PICS ('pics', a JO id) or wt PO ('po', a sales order id) by hand:
// can_update on Pending Billing (asked 2026-11-04). A box an attachment ticks stays ticked regardless.
router.put('/mark', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  try {
    const { target, id, checked } = req.body || {};
    if (!['par', 'pics', 'po'].includes(target) || !Number(id)) return res.status(400).json({ error: 'target (par, pics or po) and id are required.' });
    const perJo = target === 'par' || target === 'pics';
    if (!(await hasSoAttachmentKind())) return res.status(409).json({ error: 'Run node src/db/add-so-attachment-kind.js on the server first.' });
    // Ticking wt PAR or wt PICS needs the date it was sent (2026-11-13; each its own since 2026-11-24); not later than today.
    const sentCol = await hasSentDate();
    const sent = String(req.body?.sent_date || '').slice(0, 10);
    if (perJo && checked && sentCol) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sent)) return res.status(400).json({ error: `Enter the date the ${target === 'par' ? 'PAR' : 'pictures'} were sent.` });
      const [[{ today }]] = await pool.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
      if (sent > today) return res.status(400).json({ error: 'The date sent cannot be later than today.' });
    }
    const [[exists]] = await pool.query(perJo ? 'SELECT id FROM job_orders WHERE id = ?' : 'SELECT id FROM sales_orders WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    if (checked && perJo && sentCol) {
      // Ticking again (or changing the date) keeps the latest date and who set it.
      await pool.query(
        `INSERT INTO pending_billing_marks (target, target_id, marked_by_user_id, marked_at, sent_date) VALUES (?, ?, ?, NOW(), ?)
         ON DUPLICATE KEY UPDATE sent_date = VALUES(sent_date), marked_by_user_id = VALUES(marked_by_user_id), marked_at = NOW()`,
        [target, id, req.user.id, sent]);
    } else if (checked) {
      await pool.query(
        'INSERT INTO pending_billing_marks (target, target_id, marked_by_user_id, marked_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE target_id = target_id',
        [target, id, req.user.id]);
    } else {
      await pool.query('DELETE FROM pending_billing_marks WHERE target = ? AND target_id = ?', [target, id]);
    }
    const [[m]] = await pool.query(
      `SELECT m.marked_at, ${sentCol ? "DATE_FORMAT(m.sent_date, '%Y-%m-%d')" : 'NULL'} AS sent_date, u.display_name AS marked_by FROM pending_billing_marks m LEFT JOIN users u ON u.id = m.marked_by_user_id
        WHERE m.target = ? AND m.target_id = ?`, [target, id]);
    res.json({ mark: m ? { by: m.marked_by, at: m.marked_at, sent: m.sent_date || null } : null });
  } catch (err) {
    next(err);
  }
});

// ---- Email the sales rep about one Job Order (asked 2026-11-24) ----
//
// To the email on the sales rep's user account (Users & Permissions -- the address they log in with),
// else the one on their employee record. Built from the row exactly as this report shows it (loadRows,
// one JO), so the email and the screen cannot disagree; a JO the sender cannot see here (sales-rep
// scope) cannot be emailed either. Replies go to the sender. The last one sent is kept per JO in
// pending_billing_marks (target 'email': who, when) and shown under the button; the same JO cannot be
// emailed again within 10 minutes, so a double click is not two emails.
const EMAIL_COOLDOWN_MIN = 10;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const peso = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');

async function emailTarget(req, joId) {
  const [row] = await loadRows({ ...req, query: { job_order_id: joId } });
  if (!row) return { error: 'This Job Order is not on your Pending Billing list.', status: 404 };
  if (!row.sales_rep_id) return { row, error: 'This Job Order has no sales rep.', status: 409 };
  const [[rep]] = await pool.query(
    `SELECT TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS name, e.email AS employee_email,
            (SELECT u.email FROM users u WHERE u.employee_id = e.id AND u.is_active = 1 AND u.email LIKE '%@%' ORDER BY u.id LIMIT 1) AS user_email
       FROM employees e WHERE e.id = ?`, [row.sales_rep_id]);
  const email = String(rep?.user_email || rep?.employee_email || '').trim();
  if (!email || !email.includes('@')) {
    return { row, error: `${rep?.name || 'The sales rep'} has no email address -- add it on their user account (Users & Permissions).`, status: 409 };
  }
  return { row, to: { name: rep.name, email } };
}

router.get('/email-preview', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const t = await emailTarget(req, Number(req.query.job_order_id));
    if (t.error) return res.status(t.status).json({ error: t.error });
    res.json({ to: t.to, last: t.row.email_mark || null });
  } catch (err) { next(err); }
});

router.post('/email', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const joId = Number(req.body?.job_order_id);
    if (!joId) return res.status(400).json({ error: 'job_order_id is required.' });
    const t = await emailTarget(req, joId);
    if (t.error) return res.status(t.status).json({ error: t.error });
    const r = t.row;
    // Compared in the database, on its own clock: marked_at comes back as text in the database's time
    // zone, so comparing it with the app's clock in JS was off by hours.
    const [[recent]] = await pool.query(
      `SELECT 1 AS x FROM pending_billing_marks WHERE target = 'email' AND target_id = ? AND marked_at > NOW() - INTERVAL ${EMAIL_COOLDOWN_MIN} MINUTE`, [r.id]);
    if (recent) {
      return res.status(429).json({ error: `${r.job_order_no} was just emailed${r.email_mark?.by ? ` by ${r.email_mark.by}` : ''}. Wait ${EMAIL_COOLDOWN_MIN} minutes before sending again.` });
    }
    const mailer = require('../lib/mailer');
    const [[me]] = await pool.query('SELECT display_name, email FROM users WHERE id = ?', [req.user.id]);
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    const missing = [!r.with_par && 'PAR', !r.with_pics && 'Pictures', !r.with_po && r.sales_order_id && 'PO'].filter(Boolean);
    const order = r.sales_order_no || r.nsso_no || '';
    const base = String(process.env.CLIENT_URL || 'https://gsuite.graphicstar.ph').replace(/\/$/, '');
    const link = `${base}/job-orders/${r.id}`;
    const lines = [
      ['Job Order', r.job_order_no], ['Sales Order', order], ['Customer', r.customer_name], ['Description', r.description],
      ['Completed', day(r.completed_date || r.so_date)], ['Days pending', r.days_pending],
      ['Qty to bill', `${Number(r.uninvoiced_qty).toLocaleString('en-US')} of ${Number(r.quantity).toLocaleString('en-US')}`],
      ['Unbilled amount', `PHP ${peso(r.unbilled_amount)}`],
      ['Still missing', missing.length ? missing.join(', ') : 'Nothing -- PAR, pictures and PO are in'],
    ];
    const subject = `Pending billing: ${r.job_order_no} -- ${r.customer_name || ''} (${r.days_pending ?? '?'} days)`;
    const text = `Hi ${t.to.name || ''},\n\n${r.job_order_no} is delivered but not yet billed. Please follow up so it can be invoiced.\n\n`
      + lines.map(([k, v]) => `${k}: ${v ?? ''}`).join('\n')
      + (note ? `\n\nNote from ${me?.display_name || 'Billing'}:\n${note}` : '')
      + `\n\nOpen it in T1S: ${link}\n\n-- Sent from T1S Pending Billing by ${me?.display_name || ''}`;
    const html = `<p>Hi ${esc(t.to.name)},</p>
<p><strong>${esc(r.job_order_no)}</strong> is delivered but not yet billed. Please follow up so it can be invoiced.</p>
<table cellpadding="6" style="border-collapse:collapse;font:14px Arial,sans-serif">
${lines.map(([k, v]) => `<tr><td style="color:#555;border-bottom:1px solid #eee">${esc(k)}</td><td style="border-bottom:1px solid #eee"><strong>${esc(v)}</strong></td></tr>`).join('\n')}
</table>
${note ? `<p style="margin-top:14px"><em>Note from ${esc(me?.display_name || 'Billing')}:</em><br>${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
<p><a href="${esc(link)}">Open ${esc(r.job_order_no)} in T1S</a></p>
<p style="color:#888;font-size:12px">Sent from T1S Pending Billing by ${esc(me?.display_name || '')}.</p>`;

    const sent = await mailer.send({
      to: t.to.email, subject, text, html,
      replyTo: me?.email && String(me.email).includes('@') ? me.email : undefined,
      fromName: me?.display_name ? `${me.display_name} via T1S` : undefined,
    });
    if (!sent || sent.ok === false) return res.status(502).json({ error: sent?.error || 'The email could not be sent.' });

    await pool.query(
      `INSERT INTO pending_billing_marks (target, target_id, marked_by_user_id, marked_at) VALUES ('email', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE marked_by_user_id = VALUES(marked_by_user_id), marked_at = NOW()`, [r.id, req.user.id]);
    const [[m]] = await pool.query(
      `SELECT m.marked_at, u.display_name AS marked_by FROM pending_billing_marks m LEFT JOIN users u ON u.id = m.marked_by_user_id
        WHERE m.target = 'email' AND m.target_id = ?`, [r.id]);
    res.json({ ok: true, to: t.to, mark: m ? { by: m.marked_by, at: m.marked_at } : null });
  } catch (err) { next(err); }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await loadRows(req);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pending Billing');
    ws.columns = [
      { header: 'Job Order', key: 'job_order_no', width: 20 },
      { header: 'SO / NSSO', key: 'order', width: 16 },
      { header: 'Customer', key: 'customer_name', width: 36 },
      { header: 'Sales Rep', key: 'sales_rep_name', width: 24 },
      { header: 'Department', key: 'department_name', width: 18 },
      { header: 'Description', key: 'description', width: 44 },
      { header: 'Completed', key: 'completed_date', width: 12 },
      { header: 'wt PAR', key: 'par', width: 8 },
      { header: 'PAR Sent', key: 'par_sent', width: 11 },
      { header: 'wt PICS', key: 'pics', width: 8 },
      { header: 'PICS Sent', key: 'pics_sent', width: 11 },
      { header: 'wt PO', key: 'po', width: 8 },
      { header: 'Days Pending', key: 'days_pending', width: 10 },
      { header: 'Qty', key: 'quantity', width: 9 },
      { header: 'Completed Qty', key: 'completed_qty', width: 11 },
      { header: 'Delivered Qty', key: 'quantity_delivered', width: 11 },
      { header: 'Invoiced Qty', key: 'invoiced_qty', width: 11 },
      { header: 'To Bill Qty', key: 'uninvoiced_qty', width: 11 },
      { header: 'Unit Price (Gross)', key: 'unit_gross', width: 14 },
      { header: 'Unbilled Amount', key: 'unbilled_amount', width: 15 },
      { header: 'Invoices so far', key: 'invoice_nos', width: 24 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({ ...r, order: r.sales_order_no || r.nsso_no || '', completed_date: r.completed_date ? String(r.completed_date).slice(0, 10) : '',
        par: r.with_par ? 'Yes' : '', par_sent: r.par_mark?.sent || '',
        pics: r.with_pics ? 'Yes' : '', pics_sent: r.pics_mark?.sent || '', po: r.with_po ? 'Yes' : '',
        unit_gross: Number(Number(r.unit_gross || 0).toFixed(2)) });
    }
    const total = ws.addRow({ job_order_no: 'Total', uninvoiced_qty: rows.reduce((s, r) => s + r.uninvoiced_qty, 0), unbilled_amount: rows.reduce((s, r) => s + r.unbilled_amount, 0) });
    total.font = { bold: true };
    for (const k of ['unit_gross', 'unbilled_amount']) ws.getColumn(k).numFmt = '#,##0.00';
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pending-billing-${new Date().toLocaleDateString('en-CA')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// The dashboard's Pending Billing card (2026-10-09): the same JOs and amount as this report with no
// filters, so the two can never disagree. It used to run its own query, which counted only invoice
// lines naming the JO and read P56M over 20,717 JOs whose orders were already billed. Held for five
// minutes -- the report takes a few seconds and every GM dashboard load asks for it.
let summaryCache = { at: 0, value: null };
async function pendingBillingSummary() {
  if (summaryCache.value && Date.now() - summaryCache.at < 5 * 60 * 1000) return summaryCache.value;
  const rows = await loadRows({ user: { id: 0 }, query: {} }, { allReps: true });
  const value = { count: rows.length, amount: Number(rows.reduce((t, r) => t + r.unbilled_amount, 0).toFixed(2)) };
  summaryCache = { at: Date.now(), value };
  return value;
}

module.exports = router;
module.exports.pendingBillingSummary = pendingBillingSummary;
module.exports.loadRows = loadRows; // db/check-jo-invoices.js --pending
