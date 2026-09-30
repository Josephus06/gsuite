// Every customer from the source (get_customers), onto the "Setup Your Customer" fields
// (add-customer-form-fields.js). 2026-09-30, cut-over night.
//
//   - MATCHED customers (by customer_code = UserPK_Cust when both are set, else by name, case- and
//     space-insensitive -- how import-sales.js resolved them) only have EMPTY fields filled in:
//     anything already set in T1S, or edited by staff, is left alone.
//   - UNMATCHED source customers are inserted (names upper-cased, lib/customerName.js).
// Source fields: Name_Cust, Company_Cust, UserPK_Cust, Address_Cust, ContactNo_Cust,
// Birthdate_Cust (1970-01-01 is the source's "none"), Gender_Cust, Type_Cust, TIN_Cust,
// BusinessStyle_Cust (text -> business_styles by name), CreditLimit_Cust, CreditTerm_Cust
// (text -> payment_terms by name), IsChargeToLocation_Cust, IsChargeTo_Cust,
// IsAllow90PercentCommission_Cust, BillToName/Address/ContactNo_Cust.
//
//   node src/db/import-customers-full.js [--save=raw.json | --raw=raw.json]   preview (default)
//   node src/db/import-customers-full.js --apply ...                          write
// Droplet and office replicate: run on ONE box (the droplet). Railway: its own run.
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const { upperCustomerName } = require('../lib/customerName');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const clean = (v) => { const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); return s || null; };
const key = (v) => (clean(v) || '').toUpperCase();

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
          body: JSON.stringify({ limit: 500, offset, order: [['ID_Cust', 'ASC']] }) });
        j = await r.json(); break;
      } catch (e) { if (a >= 3) throw e; await new Promise((res) => setTimeout(res, 3000)); }
    }
    const rows = Array.isArray(j.data) ? j.data : [];
    all.push(...rows);
    if (offset % 5000 === 0) console.log(`  pulled ${all.length}`);
    if (rows.length < 500) break;
  }
  return all;
}

async function main() {
  const src = arg('raw') ? JSON.parse(fs.readFileSync(arg('raw'), 'utf8')) : await pullSource();
  if (arg('save')) fs.writeFileSync(arg('save'), JSON.stringify(src));
  const uniq = new Map(); for (const s of src) uniq.set(s.SysPK_Cust, s);
  const rows = [...uniq.values()].filter((s) => clean(s.Name_Cust));
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLY' : 'PREVIEW'}. Source customers: ${rows.length} (of ${src.length} rows pulled).`);

  const [cust] = await pool.query(`SELECT id, customer_code, name, company_name, address, contact_no, birthdate, gender, customer_type, tin,
      business_style_id, credit_limit, payment_term_id, is_charge_to_location, is_charge_to, include_90_commission,
      bill_to_name, bill_to_address, bill_to_contact_no FROM customers`);
  const byCode = new Map(); const byName = new Map();
  for (const c of cust) { if (clean(c.customer_code)) byCode.set(key(c.customer_code), c); if (!byName.has(key(c.name))) byName.set(key(c.name), c); }
  const [styles] = await pool.query('SELECT id, name FROM business_styles');
  const styleId = new Map(styles.map((s) => [key(s.name), s.id]));
  const [terms] = await pool.query('SELECT id, term_name FROM payment_terms');
  const termId = new Map(terms.map((t) => [key(t.term_name), t.id]));

  // Trimmed to the column sizes (name/company 200, tin 30, contact nos 100): a few source values
  // run longer and would fail the whole insert.
  const cut = (v, n) => (v == null ? v : String(v).slice(0, n));
  const toFields = (s) => {
    const bd = clean(s.Birthdate_Cust) ? String(s.Birthdate_Cust).slice(0, 10) : null;
    const type = key(s.Type_Cust);
    return {
      company_name: cut(upperCustomerName(clean(s.Company_Cust)), 200),
      address: clean(s.Address_Cust), contact_no: cut(clean(s.ContactNo_Cust), 100),
      birthdate: bd && bd !== '1970-01-01' && bd > '1900-01-01' ? bd : null,
      gender: ['MALE', 'FEMALE'].includes(key(s.Gender_Cust)) ? (key(s.Gender_Cust) === 'MALE' ? 'Male' : 'Female') : null,
      customer_type: type === 'COMPANY' ? 'Company' : type === 'INDIVIDUAL' ? 'Individual' : null,
      tin: cut(clean(s.TIN_Cust), 30),
      business_style_id: styleId.get(key(s.BusinessStyle_Cust)) || null,
      credit_limit: Number(s.CreditLimit_Cust) > 0 ? Number(s.CreditLimit_Cust) : null,
      payment_term_id: termId.get(key(s.CreditTerm_Cust)) || null,
      is_charge_to_location: Number(s.IsChargeToLocation_Cust) ? 1 : 0,
      is_charge_to: Number(s.IsChargeTo_Cust) ? 1 : 0,
      include_90_commission: Number(s.IsAllow90PercentCommission_Cust) ? 1 : 0,
      bill_to_name: cut(clean(s.BillToName_Cust), 200), bill_to_address: clean(s.BillToAddress_Cust), bill_to_contact_no: cut(clean(s.BillToContactNo_Cust), 100),
    };
  };
  const isEmpty = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && v === 0);

  const updates = []; const inserts = []; const fieldCounts = {};
  const seenNew = new Set();
  for (const s of rows) {
    const code = clean(s.UserPK_Cust);
    const match = (code && byCode.get(key(code))) || byName.get(key(s.Name_Cust));
    const f = toFields(s);
    if (match) {
      const set = {};
      for (const [k, v] of Object.entries(f)) {
        if (v === null || v === 0) continue;
        if (isEmpty(match[k])) { set[k] = v; match[k] = v; fieldCounts[k] = (fieldCounts[k] || 0) + 1; }
      }
      if (code && !clean(match.customer_code) && !byCode.has(key(code))) { set.customer_code = code.slice(0, 30); match.customer_code = code; byCode.set(key(code), match); fieldCounts.customer_code = (fieldCounts.customer_code || 0) + 1; }
      if (Object.keys(set).length) updates.push([match.id, set]);
    } else {
      const k = key(s.Name_Cust);
      if (seenNew.has(k)) continue; // same name twice in the source: one customer
      seenNew.add(k);
      const c = { name: cut(upperCustomerName(clean(s.Name_Cust)), 200),customer_code: code && !byCode.has(key(code)) ? code.slice(0, 30) : null, ...f, is_active: 1 };
      if (c.customer_code) byCode.set(key(c.customer_code), c);
      inserts.push(c);
    }
  }
  console.log(`Matched customers getting empty fields filled: ${updates.length}`);
  console.log('  fields filled:', Object.entries(fieldCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  console.log(`New customers to add: ${inserts.length}${inserts.length ? ` (e.g. ${inserts.slice(0, 5).map((c) => c.name).join('; ')})` : ''}`);

  if (!APPLY) { console.log('\nPreview only. Re-run with --apply to write.'); await pool.end(); return; }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [id, set] of updates) {
      await conn.query(`UPDATE customers SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`, [...Object.values(set), id]);
    }
    const cols = Object.keys(inserts[0] || {});
    for (let i = 0; i < inserts.length; i += 500) {
      const chunk = inserts.slice(i, i + 500);
      await conn.query(`INSERT INTO customers (${cols.join(', ')}) VALUES ?`, [chunk.map((c) => cols.map((k) => c[k] ?? (['is_charge_to_location', 'is_charge_to', 'include_90_commission'].includes(k) ? 0 : (k === 'credit_limit' ? 0 : null))))]);
    }
    await conn.commit();
    console.log(`\nCommitted: ${updates.length} updated, ${inserts.length} added.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
}

main().catch(async (e) => { console.error('FAILED:', e.message); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
