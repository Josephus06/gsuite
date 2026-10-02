// Link opening AR items (opening_ar_items) that carry no T1S customer to one.
//
// The cut-over load matched the source's customer names exactly, and 51 names differ from ours
// only by spacing ("SHERATON CEBU MACTAN  RESORT" with two spaces). Unlinked, AR Aging grouped all
// 68 of their items under ONE customer (customer_id NULL), so the total matched the source while
// those 51 customers each showed nothing. Matched here on the name with whitespace and case
// normalised; a name T1S does not hold at all becomes a new customer (as import-credit-memos.js
// does), since the customer IS the party owing the money.
//
//   node src/db/link-opening-ar-customers.js --dry-run
//   node src/db/link-opening-ar-customers.js
require('dotenv').config();
const pool = require('../db');
const { upperCustomerName } = require('../lib/customerName');

const DRY = process.argv.includes('--dry-run');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [items] = await pool.query('SELECT id, as_of, customer_name, balance FROM opening_ar_items WHERE customer_id IS NULL');
  const [custs] = await pool.query('SELECT id, name FROM customers');
  const byName = new Map();
  for (const c of custs) { const k = norm(c.name); if (!byName.has(k)) byName.set(k, c.id); }
  const names = [...new Set(items.map((i) => norm(i.customer_name)))];
  const toCreate = names.filter((n) => n && !byName.has(n));
  console.log(`${items.length} unlinked item(s) on ${names.length} name(s): ${names.length - toCreate.length} match an existing customer, ${toCreate.length} to create`);
  toCreate.forEach((n) => console.log(`   new customer: ${n}`));
  if (DRY) { await pool.end(); return; }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const n of toCreate) {
      const raw = items.find((i) => norm(i.customer_name) === n).customer_name;
      const [r] = await conn.query('INSERT INTO customers (name, is_active) VALUES (?, 1)', [upperCustomerName(String(raw).replace(/\s+/g, ' ').trim().slice(0, 255))]);
      byName.set(n, r.insertId);
    }
    let linked = 0;
    for (const i of items) {
      const id = byName.get(norm(i.customer_name));
      if (!id) continue;
      await conn.query('UPDATE opening_ar_items SET customer_id = ? WHERE id = ?', [id, i.id]);
      linked += 1;
    }
    await conn.commit();
    console.log(`Linked ${linked} item(s); created ${toCreate.length} customer(s).`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
