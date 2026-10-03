// Fill in the Sales Division (sales group) on estimates saved without one, and on the Sales
// Orders made from them. Since go-live (2026-10-01) the estimate form let it be left blank, and an
// approved estimate's Sales Order copies the blank, so those orders showed as "(no group)" on the
// dashboard's sales breakdown (SO-192821, Arjie).
//
// Each one takes its sales rep's usual group: the division on most of the rep's Sales Orders this
// year. A rep with no history, or no clear majority (under 90%), is reported and left alone.
// Idempotent. Droplet and office replicate: run on ONE of them.
//
//   node src/db/backfill-estimate-sales-division.js --since=2026-09-01 --dry-run
//   node src/db/backfill-estimate-sales-division.js --since=2026-09-01
require('dotenv').config();
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const since = (process.argv.find((a) => a.startsWith('--since=')) || '--since=2026-09-01').split('=')[1];

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}, estimates since ${since}`);
  const [ests] = await pool.query(
    `SELECT e.id, e.estimate_no, e.sales_rep_id, e.sales_order_id, CONCAT(sr.first_name, ' ', sr.last_name) AS rep
       FROM estimates e LEFT JOIN employees sr ON sr.id = e.sales_rep_id
      WHERE e.sales_division_id IS NULL AND e.date_created >= ? ORDER BY e.id`, [since]);

  // The rep's usual group. A rep's duplicate employee record (same name typed twice) borrows the
  // other record's history.
  const usual = new Map();
  async function usualFor(repId, repName) {
    if (usual.has(repId)) return usual.get(repId);
    const norm = String(repName || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const [same] = await pool.query(
      "SELECT id FROM employees WHERE LOWER(TRIM(REGEXP_REPLACE(CONCAT(first_name, ' ', last_name), '[[:space:]]+', ' '))) = ?", [norm]);
    const ids = [...new Set([repId, ...same.map((r) => r.id)].filter(Boolean))];
    const [rows] = await pool.query(
      `SELECT so.sales_division_id AS id, sd.name, COUNT(*) AS n FROM sales_orders so JOIN sales_divisions sd ON sd.id = so.sales_division_id
        WHERE so.sales_rep_id IN (?) AND so.date_created >= '2026-01-01' GROUP BY so.sales_division_id, sd.name ORDER BY n DESC`, [ids]);
    const total = rows.reduce((t, r) => t + Number(r.n), 0);
    const pick = rows.length && Number(rows[0].n) / total >= 0.9 ? { id: rows[0].id, name: rows[0].name, share: `${rows[0].n} of ${total}` } : null;
    usual.set(repId, pick);
    return pick;
  }

  let fixed = 0;
  for (const e of ests) {
    const g = e.sales_rep_id ? await usualFor(e.sales_rep_id, e.rep) : null;
    if (!g) { console.log(`  ${e.estimate_no} (${e.rep || 'no rep'}): no clear group -- left blank`); continue; }
    const [[so]] = e.sales_order_id
      ? await pool.query('SELECT id, sales_order_no, sales_division_id FROM sales_orders WHERE id = ?', [e.sales_order_id]) : [[null]];
    console.log(`  ${e.estimate_no} (${e.rep}) -> ${g.name} [${g.share}]${so ? `; ${so.sales_order_no}${so.sales_division_id ? ' already has a group' : ' too'}` : ''}`);
    if (DRY) continue;
    await pool.query('UPDATE estimates SET sales_division_id = ? WHERE id = ? AND sales_division_id IS NULL', [g.id, e.id]);
    if (so && !so.sales_division_id) await pool.query('UPDATE sales_orders SET sales_division_id = ? WHERE id = ? AND sales_division_id IS NULL', [g.id, so.id]);
    fixed += 1;
  }
  console.log(`${DRY ? 'Would fill' : 'Filled'} ${DRY ? ests.length : fixed} of ${ests.length} estimate(s).`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
