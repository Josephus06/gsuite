// Customer > Billing and Collection rows from the source (asked 2026-10-21): get_customers with
// include ["customer_billings"] -- what the source's customer screen loads for its Billing and
// Collection tab. Source fields -> customer_billing_contacts (db/add-customer-billing-collection.js):
//   ContactPerson_OD   contact_person        Type_OD            billing_collection (Billing / Collection)
//   ContactNumber_OD   contact_number        BillingReq_OD      billing_requirements
//   EmailAdd_OD        email                 ReleasingSched_OD  releasing_schedule
//   Address_OD         address               ReleasingLoc_OD    releasing_location
//   PaymentMethod_OD   payment_method        OtherInfo_OD       other_info
//
// Customers matched as import-customers-full.js does: by customer_code = UserPK_Cust, else by a name
// only one T1S customer has. A customer that already has Billing and Collection rows in T1S is left
// alone (entered or edited here since), so re-running adds nothing twice.
//
//   node src/db/import-customer-billing-collection.js            preview
//   node src/db/import-customer-billing-collection.js --apply    write
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const clean = (v) => { const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); return s || null; };
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
const nk = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function pullSource() {
  const login = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const token = (await login.json())?.data?.token;
  if (!token) throw new Error('Source login failed.');
  const all = [];
  for (let offset = 0; ; offset += 500) {
    let j;
    for (let a = 0; ; a += 1) {
      try {
        const r = await fetch(`${SITE}/api/get_customers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ limit: 500, offset, order: [['ID_Cust', 'ASC']], include: ['customer_billings'] }) });
        j = await r.json(); break;
      } catch (e) { if (a >= 3) throw e; await new Promise((res) => setTimeout(res, 3000)); }
    }
    const rows = Array.isArray(j.data) ? j.data : [];
    all.push(...rows);
    if (rows.length < 500) break;
  }
  return all;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply to write)'}\n`);
  const src = await pullSource();
  const withRows = src.filter((s) => Array.isArray(s.customer_billings) && s.customer_billings.length);
  console.log(`Source: ${src.length} customers, ${withRows.length} with Billing and Collection rows (${withRows.reduce((n, s) => n + s.customer_billings.length, 0)} rows).`);

  const [cust] = await pool.query('SELECT id, customer_code, name FROM customers');
  const byCode = new Map(cust.filter((c) => c.customer_code).map((c) => [String(c.customer_code).trim().toUpperCase(), c]));
  const byName = new Map();
  for (const c of cust) { const k = nk(c.name); byName.set(k, byName.has(k) ? null : c); } // null = more than one
  const [have] = await pool.query('SELECT DISTINCT customer_id FROM customer_billing_contacts');
  const hasRows = new Set(have.map((h) => Number(h.customer_id)));

  const out = { customers: 0, rows: 0, alreadyHave: 0, unmatched: [] };
  for (const s of withRows) {
    const c = (clean(s.UserPK_Cust) && byCode.get(clean(s.UserPK_Cust).toUpperCase())) || byName.get(nk(s.Name_Cust)) || null;
    if (!c) { out.unmatched.push(clean(s.Name_Cust) || clean(s.UserPK_Cust)); continue; }
    if (hasRows.has(Number(c.id))) { out.alreadyHave += 1; continue; }
    const rows = s.customer_billings.map((b) => [
      cut(clean(b.ContactPerson_OD), 255), cut(clean(b.ContactNumber_OD), 255), cut(clean(b.EmailAdd_OD), 255), cut(clean(b.Address_OD), 500),
      cut(clean(b.Type_OD), 30), cut(clean(b.BillingReq_OD), 1000), cut(clean(b.ReleasingSched_OD), 255), cut(clean(b.ReleasingLoc_OD), 255),
      cut(clean(b.PaymentMethod_OD), 255), cut(clean(b.OtherInfo_OD), 1000),
    ]).filter((v) => v.some((x) => x != null));
    if (!rows.length) continue;
    out.customers += 1; out.rows += rows.length;
    if (out.customers <= 5) console.log(`  ${c.name}: ${rows.length} row(s) -- e.g. ${rows[0].filter(Boolean).slice(0, 4).join(' | ')}`);
    if (!APPLY) continue;
    for (const v of rows) {
      await pool.query(
        `INSERT INTO customer_billing_contacts (customer_id, contact_person, contact_number, email, address, billing_collection,
           billing_requirements, releasing_schedule, releasing_location, payment_method, other_info)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [c.id, ...v]);
    }
  }
  console.log(`\n${APPLY ? 'Imported' : 'Would import'} ${out.rows} row(s) for ${out.customers} customer(s).`);
  if (out.alreadyHave) console.log(`Skipped ${out.alreadyHave} customer(s) that already have Billing and Collection rows in T1S.`);
  if (out.unmatched.length) console.log(`Not in T1S (${out.unmatched.length}): ${out.unmatched.slice(0, 20).join('; ')}${out.unmatched.length > 20 ? ' ...' : ''}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
