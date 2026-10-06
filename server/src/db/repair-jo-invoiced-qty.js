// A Job Order's Invoiced quantity (job_orders.quantity_invoiced) set from the invoice lines that
// actually bill it (asked 2026-10-06: JO-64627-1-1 read Invoiced 0 beside INV-81106's 72,000).
// The migration left the counter at 0 on most migrated JOs -- 88,651 lag their invoice lines --
// and the Sales Order / Job Order screens, and the "what is left to bill" offered by Create SI,
// read it.
//
//   invoiced = SUM(sales_invoice_lines.quantity) over the JO's non-cancelled invoices
//
// Only ever RAISES the counter, to that sum. Left alone, and listed: a JO whose invoice lines add
// up to MORE than its own quantity -- a unit mismatch or a real over-billing, which wants a look,
// not a number copied over it. JOs raised in T1S (since 2026-10-01) are counted apart in the
// report: those should never lag, so any there point at a live bug rather than migration debt.
//
// Dry run unless --apply; --apply writes a rollback file of the old values.
// Production: the droplet only (replication carries it to the office).
//
//   node src/db/repair-jo-invoiced-qty.js [--only=JO-64627-1-1] [--apply]
//   node src/db/repair-jo-invoiced-qty.js --rollback=rollback/jo-invoiced-rollback-<stamp>.json
const fs = require('fs');
const path = require('path');
const pool = require('../db');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const ROLLBACK = arg('rollback');
const ONLY = arg('only');
const GO_LIVE = '2026-10-01';

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN, nothing written'}`);
  if (ROLLBACK) {
    const rb = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (let i = 0; i < rb.length; i += 1000) {
      const chunk = rb.slice(i, i + 1000);
      await pool.query(
        `UPDATE job_orders SET quantity_invoiced = CASE id ${chunk.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE id IN (?)`,
        [...chunk.flatMap((r) => [r.id, r.quantity_invoiced]), chunk.map((r) => r.id)],
      );
    }
    console.log(`Rolled back ${rb.length} job order(s).`);
    return;
  }

  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.quantity, jo.quantity_invoiced, jo.created_at, x.inv_qty
       FROM job_orders jo
       JOIN (SELECT sil.job_order_id, SUM(sil.quantity) AS inv_qty
               FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.sales_invoice_id
              WHERE si.status <> 'cancelled' AND sil.job_order_id IS NOT NULL
              GROUP BY sil.job_order_id) x ON x.job_order_id = jo.id
      WHERE x.inv_qty > jo.quantity_invoiced + 0.0001${ONLY ? ' AND jo.job_order_no = ?' : ''}
      ORDER BY jo.id`,
    ONLY ? [ONLY] : [],
  );

  const plan = []; const over = [];
  for (const r of rows) {
    if (Number(r.quantity) > 0 && Number(r.inv_qty) > Number(r.quantity) + 0.0001) { over.push(r); continue; }
    plan.push(r);
  }
  const t1s = plan.filter((r) => String(r.created_at).slice(0, 10) >= GO_LIVE);
  console.log(`JOs whose Invoiced lags their invoice lines: ${rows.length}`);
  console.log(`  to set from the invoice lines: ${plan.length} (raised in T1S since ${GO_LIVE}: ${t1s.length})`);
  console.log(`  left alone, invoiced past the JO's own quantity: ${over.length}`);
  for (const r of plan.slice(0, 10)) console.log(`    ${r.job_order_no}: ${Number(r.quantity_invoiced)} -> ${Number(r.inv_qty)} (qty ${Number(r.quantity)})`);
  for (const r of t1s.slice(0, 15)) console.log(`    T1S-era ${r.job_order_no}: ${Number(r.quantity_invoiced)} -> ${Number(r.inv_qty)}`);
  for (const r of over.slice(0, 15)) console.log(`    OVER ${r.job_order_no}: invoiced ${Number(r.inv_qty)} against qty ${Number(r.quantity)}`);
  if (!APPLY) return;

  const outDir = path.join(__dirname, '..', '..', 'rollback'); fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `jo-invoiced-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  // The rollback is written BEFORE anything changes, so an interrupted run can still be undone.
  fs.writeFileSync(file, JSON.stringify(plan.map((r) => ({ id: r.id, quantity_invoiced: Number(r.quantity_invoiced) }))));
  let done = 0;
  for (let i = 0; i < plan.length; i += 1000) {
    const chunk = plan.slice(i, i + 1000);
    // Raise only: a JO invoiced further since this was read keeps the higher figure.
    const [res] = await pool.query(
      `UPDATE job_orders SET quantity_invoiced = GREATEST(quantity_invoiced, CASE id ${chunk.map(() => 'WHEN ? THEN ?').join(' ')} END)
        WHERE id IN (?)`,
      [...chunk.flatMap((r) => [r.id, Number(r.inv_qty)]), chunk.map((r) => r.id)],
    );
    done += res.affectedRows;
  }
  console.log(`Set ${done} job order(s). Rollback: ${file}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
