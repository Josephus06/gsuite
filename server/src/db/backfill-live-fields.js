// Backfill fields the base sales import never captured, from live:
//   sales_orders: contact person (-> customer_contacts) + contact email/title/phone, ref_no
//   sales_invoices: bs_si_no (live ReferrenceNO_TransH), memo, po_no
// Idempotent: only fills rows still missing the value. Resumable (re-run continues).
//
//   node src/db/backfill-live-fields.js --dry-run
//   node src/db/backfill-live-fields.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 5;
const clean = (s) => (s == null ? null : s.toString().trim().replace(/\s+/g, ' ') || null);
const trunc = (s, n) => { const c = clean(s); return c == null ? null : c.slice(0, n); };
const day = (v) => (v || '').toString().slice(0, 10);

async function login() { const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) }); return (await r.json())?.data?.token; }
async function apiOnce(token, ep, p, ms = 60000) { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms); try { const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(p), signal: ctl.signal }); clearTimeout(t); return await r.json(); } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); } }
async function api(token, ep, p, ms) { let last; for (let a = 0; a < 4; a += 1) { try { return await apiOnce(token, ep, p, ms); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); } } throw last; }
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mapWithConcurrency(items, limit, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } })); }

async function resolveContact(customerId, name, title, email, phone) {
  const nm = clean(name); if (!customerId || !nm) return null;
  const [[row]] = await pool.query('SELECT id FROM customer_contacts WHERE customer_id = ? AND LOWER(contact_name) = LOWER(?) LIMIT 1', [customerId, nm]);
  if (row) return row.id;
  const [r] = await pool.query('INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone) VALUES (?,?,?,?,?)', [customerId, trunc(nm, 255), trunc(title, 100), trunc(email, 255), trunc(phone, 100)]);
  return r.insertId;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING.\n');
  const token = await login();

  // ---------- Invoices: bs_si_no / memo / po_no from the invoice list ----------
  const [invRows] = await pool.query("SELECT id, invoice_no FROM sales_invoices WHERE bs_si_no IS NULL OR bs_si_no = ''");
  const invByNo = new Map(invRows.map((i) => [i.invoice_no, i.id]));
  console.log(`Invoices needing bs_si_no: ${invByNo.size}`);
  let invSet = 0;
  if (invByNo.size) {
    for (let off = 0; off < 60000; off += 200) {
      let list = [];
      for (let a = 0; a < 5 && !list.length; a += 1) { list = listRows(await api(token, 'get_invoices', { searchKey: '', limit: 200, offset: off })); if (!list.length) await sleep(1500 * (a + 1)); }
      if (!list.length) break;
      for (const iv of list) {
        const id = invByNo.get(iv.invc_pk);
        if (!id) continue;
        const ref = trunc(iv.ReferrenceNO_TransH, 60); const memo = trunc(iv.Memo_TransH, 500); const po = trunc(iv.PONo_TransH || iv.invc_po, 60);
        if (!ref && !memo && !po) continue;
        if (!DRY_RUN) await pool.query('UPDATE sales_invoices SET bs_si_no = COALESCE(NULLIF(bs_si_no,\'\'), ?), memo = COALESCE(memo, ?), po_no = COALESCE(po_no, ?) WHERE id = ?', [ref, memo, po, id]);
        invSet += 1; invByNo.delete(iv.invc_pk);
      }
      if (off % 4000 === 0) process.stdout.write(`  invoices paged ${off}, matched ${invSet}\n`);
      if (!invByNo.size) break;
    }
  }
  console.log(`Invoices updated: ${invSet}\n`);

  // ---------- Sales orders: contact + ref_no from estimate detail ----------
  const [soRows] = await pool.query(
    "SELECT id, sales_order_no, customer_id FROM sales_orders WHERE contact_person_id IS NULL OR ref_no IS NULL");
  const soByNo = new Map(soRows.map((s) => [s.sales_order_no, s]));
  console.log(`Sales orders needing contact/ref: ${soByNo.size}`);

  // map so number -> {pk, ref}. ref_no comes from the list row (contact comes from the JO).
  const soPk = new Map();
  for (let off = 0; off < 80000; off += 200) {
    let list = [];
    for (let a = 0; a < 5 && !list.length; a += 1) { list = listRows(await api(token, 'get_sales_orders', { searchKey: '', viewAll: true, limit: 200, offset: off })); if (!list.length) await sleep(1500 * (a + 1)); }
    if (!list.length) break;
    for (const so of list) { if (soByNo.has(so.so_upk) && !soPk.has(so.so_upk)) soPk.set(so.so_upk, { pk: so.so_pk, ref: trunc(so.ReferrenceNO_TransH, 100) }); }
    if (soPk.size >= soByNo.size) break;
    if (list.length < 200) break;
    if (off % 4000 === 0) process.stdout.write(`  SO PK paged ${off}, resolved ${soPk.size}/${soByNo.size}\n`);
  }
  console.log(`Resolved live PK for ${soPk.size}/${soByNo.size} SO(s).`);

  const entries = [...soPk.entries()];
  let soSet = 0, done = 0, fail = 0;
  await mapWithConcurrency(entries, CONCURRENCY, async ([soNo, meta]) => {
    const local = soByNo.get(soNo);
    try {
      // The contact person lives on the job-order header, not the estimate header.
      const cert = listRows(await api(token, 'get_job_orders_for_cert', { soPK: meta.pk }));
      let h = null;
      if (cert.length) { const jo = await api(token, 'get_job_order', { pk: cert[0].SysPK_TransH }); h = Array.isArray(jo.data) ? jo.data[0] : null; }
      const name = h && h.Name_ContactP;
      if (!DRY_RUN) {
        const contactId = name ? await resolveContact(local.customer_id, name, h.Title_ContactP, h.Email_ContactP, h.ContactNo_ContactP) : null;
        await pool.query(
          `UPDATE sales_orders SET contact_person_id = COALESCE(contact_person_id, ?),
             contact_email = COALESCE(contact_email, ?), contact_title = COALESCE(contact_title, ?),
             contact_phone = COALESCE(contact_phone, ?), ref_no = COALESCE(ref_no, ?)
           WHERE id = ?`,
          [contactId, trunc(h && h.Email_ContactP, 255), trunc(h && h.Title_ContactP, 100), trunc(h && h.ContactNo_ContactP, 100), meta.ref, local.id]);
        if (contactId) soSet += 1;
      } else if (name) soSet += 1;
    } catch (e) { fail += 1; }
    done += 1;
    if (done % 200 === 0) console.log(`  ...${done}/${entries.length} SOs, contacts set ${soSet}, fail ${fail}`);
  });

  console.log(`\nDone. Invoices: ${invSet} | SOs with contact: ${soSet} (${fail} fetch failures).`);
  if (DRY_RUN) console.log('DRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
