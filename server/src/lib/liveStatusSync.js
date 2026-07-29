// Admin-triggered "refresh from source": for each already-migrated transaction, re-pull its
// CURRENT live status + money fields and UPDATE the local row in place. This is how a record
// that was migrated as (say) "Pending Billing" catches up after live moves it to "Billed" /
// "Paid" -- it does NOT create or delete anything, only overwrites status + totals on rows that
// still exist upstream. New records and new child docs are out of scope (use the importers).
//
// Each module's live LIST endpoint already carries status + totals in bulk (verified against
// live), so one paged scan per module resolves everything -- no per-record detail fetch. The
// scan is date-bounded to the oldest local record so it stops at the migrated window instead of
// walking the entire multi-year ledger.
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const day = (v) => (v || '').toString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null ? null : String(s).slice(0, n));

// ---- live status -> local enum (kept identical to the one-off importers) ----
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
function joStageFromSo(localStatus) {
  return {
    pending_for_jo: 'pending_for_scheduling', jo_in_process: 'in_process', pending_delivery: 'completed',
    partially_delivered: 'partially_completed', pending_billing: 'completed',
    pending_billing_partially_delivered: 'partially_completed', billed: 'invoiced', cancelled: null,
  }[localStatus] || 'pending_for_scheduling';
}
function invoiceStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  if (s.includes('PAID')) return 'paid_in_full';
  return 'saved';
}
function dtStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'void';
  if (s.includes('CONVERT')) return 'converted';
  return 'open';
}
// Estimate approval workflow. Returns null for a status we don't recognize, so an unknown live
// value leaves the local status untouched rather than wrongly regressing it.
const ESTIMATE_STATUS = {
  pending: 'pending_supervisor_approval', 'approved by supervisor': 'pending_customer_approval',
  approved: 'approved', cancelled: 'cancelled', disapproved: 'disapproved',
};
function estimateStatus(live) { return ESTIMATE_STATUS[String(live || '').trim().toLowerCase()] || null; }

// ---- live API ----
async function login() {
  const username = process.env.LIVE_SITE_USERNAME;
  const password = process.env.LIVE_SITE_PASSWORD;
  if (!username || !password) throw new Error('LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD are not configured on this server.');
  const res = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Live site login failed: ${body?.message || res.status}`);
  return body.data.token;
}
async function apiOnce(token, ep, payload, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function api(token, ep, payload, ms = 90000) {
  let last; for (let a = 0; a < 4; a += 1) { try { return await apiOnce(token, ep, payload, ms); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); } }
  throw last;
}
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));

// Page a live list newest-first, stopping once a whole page predates the oldest local record
// (the lists are date-descending, same assumption the importers rely on).
async function fetchLiveMap(token, ep, payload, liveKey, minDay) {
  const map = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let offset = 0; offset < 60000; offset += 200) {
    let list = [];
    for (let a = 0; a < 4; a += 1) { list = listRows(await api(token, ep, { ...payload, searchKey: '', limit: 200, offset })); if (list.length) break; await sleep(1500 * (a + 1)); }
    if (!list.length) break;
    for (const row of list) { const k = row[liveKey]; if (k != null) map.set(String(k), row); }
    if (minDay && list.every((r) => day(r.DateCreated_TransH) < minDay)) break;
  }
  return map;
}

// ---- module descriptors ----
// totals: live row -> { localColumn: money }. status: live Status_TransH -> local value (or null
// to leave status alone). after: optional hook run once per changed row (e.g. cascade JO stage).
const MODULES = {
  sales_orders: {
    label: 'Sales Orders', table: 'sales_orders', keyCol: 'sales_order_no', statusCol: 'status',
    endpoint: 'get_sales_orders', payload: { viewAll: true }, liveKey: 'so_upk',
    status: (r) => soStatus(r.Status_TransH),
    totals: (r) => ({ subtotal: money(r.SubTotalVatEx_TransH), net_of_tax: money(r.SubTotalVatEx_TransH), tax_total: money(r.TaxAmount_TransH), total_amount: money(r.TotalAmount_TransH) }),
    after: async (conn, localId, newStatus) => {
      const stage = joStageFromSo(newStatus);
      await conn.query('UPDATE job_orders SET production_stage = ? WHERE sales_order_id = ?', [stage, localId]);
    },
  },
  sales_invoices: {
    label: 'Invoices', table: 'sales_invoices', keyCol: 'invoice_no', statusCol: 'status',
    endpoint: 'get_invoices', payload: {}, liveKey: 'invc_pk',
    status: (r) => invoiceStatus(r.Status_TransH),
    totals: (r) => ({ subtotal: money(r.SubTotalVatEx_TransH), net_of_tax: money(r.SubTotalVatEx_TransH), tax_amount: money(r.TaxAmount_TransH), gross_amount: money(r.TotalAmount_TransH), amount_due: money(r.AmountDue_TransH) }),
  },
  delivery_tickets: {
    label: 'Delivery Tickets', table: 'delivery_tickets', keyCol: 'dt_no', statusCol: 'status',
    endpoint: 'get_delivery_tickets', payload: {}, liveKey: 'dt_pk',
    status: (r) => dtStatus(r.Status_TransH),
    totals: (r) => {
      const gross = money(r.TotalAmount_TransH); const open = dtStatus(r.Status_TransH) === 'open';
      return { subtotal: money(r.SubTotalVatEx_TransH), net_of_tax: money(r.SubTotalVatEx_TransH), tax_amount: money(r.TaxAmount_TransH), gross_amount: gross, amount_due: open ? gross : 0 };
    },
  },
  purchase_orders: {
    label: 'Purchase Orders', table: 'purchase_orders', keyCol: 'po_no', statusCol: 'status',
    endpoint: 'get_purchase_orders', payload: { viewAll: true }, liveKey: 'UserPK_TransH',
    // The PO header status is stored verbatim from live (no local enum). Receipt/bill status are
    // derived from the related receiving/bill docs, so they're intentionally not touched here.
    status: (r) => trunc(r.Status_TransH, 60),
    totals: (r) => ({ subtotal: money(r.SubTotal_TransH), net_of_tax: money(r.SubTotal_TransH), tax_amount: money(r.TaxAmount_TransH), total_amount: money(r.TotalAmount_TransH) }),
  },
  estimates: {
    label: 'Estimates', table: 'estimates', keyCol: 'estimate_no', statusCol: 'status',
    endpoint: 'get_transactions', payload: { where: { Module_TransH: 'ESTIMATES' } }, liveKey: 'UserPK_TransH',
    status: (r) => estimateStatus(r.Status_TransH),
    totals: (r) => ({ subtotal: money(r.SubTotalVatEx_TransH), net_of_tax: money(r.SubTotalVatEx_TransH), tax_total: money(r.TaxAmount_TransH), total_amount: money(r.TotalAmount_TransH) }),
  },
};

const SYNCABLE = Object.keys(MODULES);

async function syncModule(token, key) {
  const cfg = MODULES[key];
  if (!cfg) throw new Error(`Unknown module "${key}"`);
  const totalCols = Object.keys(cfg.totals({}));
  const [[{ minDate }]] = await pool.query(`SELECT MIN(date_created) AS minDate FROM \`${cfg.table}\``);
  const [locals] = await pool.query(
    `SELECT id, \`${cfg.keyCol}\` AS k, \`${cfg.statusCol}\` AS status, ${totalCols.map((c) => `\`${c}\``).join(', ')} FROM \`${cfg.table}\``
  );
  if (!locals.length) return { module: key, label: cfg.label, checked: 0, updated: 0, statusChanged: 0, unchanged: 0, notInLive: 0, changes: [] };

  const liveMap = await fetchLiveMap(token, cfg.endpoint, cfg.payload, cfg.liveKey, day(minDate));

  let updated = 0; let statusChanged = 0; let unchanged = 0; let notInLive = 0;
  const changes = [];
  const conn = await pool.getConnection();
  try {
    for (const row of locals) {
      const live = liveMap.get(String(row.k));
      if (!live) { notInLive += 1; continue; }
      const newStatus = cfg.status(live);
      const newTotals = cfg.totals(live);

      const sets = []; const vals = [];
      const statusWillChange = newStatus != null && String(newStatus) !== String(row.status);
      if (statusWillChange) { sets.push(`\`${cfg.statusCol}\` = ?`); vals.push(newStatus); }
      for (const c of totalCols) { if (money(row[c]) !== newTotals[c]) { sets.push(`\`${c}\` = ?`); vals.push(newTotals[c]); } }

      if (!sets.length) { unchanged += 1; continue; }
      await conn.query(`UPDATE \`${cfg.table}\` SET ${sets.join(', ')} WHERE id = ?`, [...vals, row.id]);
      updated += 1;
      if (statusWillChange) {
        statusChanged += 1;
        if (changes.length < 100) changes.push({ no: row.k, from: row.status, to: newStatus });
        if (cfg.after) await cfg.after(conn, row.id, newStatus);
      }
    }
  } finally { conn.release(); }

  return { module: key, label: cfg.label, checked: locals.length, updated, statusChanged, unchanged, notInLive, changes };
}

async function syncStatuses({ modules } = {}) {
  const keys = (Array.isArray(modules) && modules.length ? modules : SYNCABLE).filter((k) => MODULES[k]);
  if (!keys.length) throw new Error('No valid module(s) requested.');
  const token = await login();
  const results = [];
  for (const k of keys) results.push(await syncModule(token, k)); // sequential: the live API throttles on parallel scans
  const totals = results.reduce((a, r) => ({ checked: a.checked + r.checked, updated: a.updated + r.updated, statusChanged: a.statusChanged + r.statusChanged }), { checked: 0, updated: 0, statusChanged: 0 });
  return { totals, results };
}

module.exports = { syncStatuses, SYNCABLE, MODULES };
