// Puts a customer payment's CUSTOMER and PAYMENT METHOD back to the source's, for the differences
// compare-customer-payment-details.js found (asked 2026-10-03). Reads that script's --out files.
//
//   customer        the T1S customer whose name is exactly the source's (case and spacing aside).
//                   No such customer, or more than one, and the payment is left alone and named.
//   payment_method  the T1S payment method of that name ("Maya"), only where T1S has none or another.
//
// Nothing else is touched -- receipt type and status differences are left for accounting. Before
// the books start (2026-10-01) a PAY-* payment posts nothing and applies to no invoice, so these
// corrections move no balance. Dry run unless --apply; --apply writes a rollback file of old values.
// Production: the droplet only (replication carries it to the office).
//
//   node src/db/repair-customer-payment-details.js /root/cp-details-2021.json /root/cp-details-2022.json ... [--apply]
//   node src/db/repair-customer-payment-details.js --rollback=rollback/cp-details-rollback-<stamp>.json
const fs = require('fs');
const path = require('path');
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=')[1];
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const txt = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN, nothing written'}`);
  if (ROLLBACK) {
    const rb = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of rb) await pool.query('UPDATE customer_payments SET customer_id = ?, payment_method_id = ? WHERE id = ?', [r.customer_id, r.payment_method_id, r.id]);
    console.log(`Rolled back ${rb.length} payment(s).`);
    return;
  }
  const diffs = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const [custs] = await pool.query('SELECT id, name FROM customers');
  const custByName = new Map();
  for (const c of custs) { const k = txt(c.name); custByName.set(k, custByName.has(k) ? 'many' : c.id); }
  const [methods] = await pool.query('SELECT id, name FROM payment_methods');
  const methodByName = new Map(methods.map((m) => [txt(m.name), m.id]));

  const plan = []; const skipped = [];
  for (const d of diffs) {
    const set = {};
    for (const f of d.diffs) {
      if (f.field === 'customer') {
        const id = custByName.get(f.source);
        if (!id || id === 'many') { skipped.push(`${d.no}: customer "${f.source}" ${id === 'many' ? 'is on more than one T1S customer' : 'is not a T1S customer'}`); continue; }
        set.customer_id = id;
      }
      if (f.field === 'payment_method' && f.source) {
        const id = methodByName.get(f.source);
        if (!id) { skipped.push(`${d.no}: payment method "${f.source}" is not in T1S`); continue; }
        set.payment_method_id = id;
      }
    }
    if (Object.keys(set).length) plan.push({ no: d.no, set, was: d.diffs.filter((f) => f.field === 'customer' || f.field === 'payment_method') });
  }
  console.log(`Payments with a difference: ${diffs.length}; to correct: ${plan.length} (customer ${plan.filter((p) => p.set.customer_id).length}, payment method ${plan.filter((p) => p.set.payment_method_id).length}); skipped ${skipped.length}`);
  for (const p of plan.slice(0, 15)) console.log(`  ${p.no}: ${p.was.map((f) => `${f.field} "${f.t1s}" -> "${f.source}"`).join('; ')}`);
  for (const s of skipped) console.log(`  SKIP ${s}`);
  if (!APPLY) return;

  const rollback = [];
  const outDir = path.join(__dirname, '..', '..', 'rollback'); fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `cp-details-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of plan) {
      const [[row]] = await conn.query('SELECT id, customer_id, payment_method_id FROM customer_payments WHERE customer_payment_no = ? FOR UPDATE', [p.no]);
      if (!row) continue;
      rollback.push(row);
      await conn.query('UPDATE customer_payments SET ? WHERE id = ?', [p.set, row.id]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  fs.writeFileSync(file, JSON.stringify(rollback));
  console.log(`Corrected ${rollback.length} payment(s). Rollback: ${file}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
