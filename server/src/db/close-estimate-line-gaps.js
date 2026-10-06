// Renumber estimate item lines (and each line's process lines) 1..n wherever an earlier delete left a
// gap -- 1, 2, 3, 4, 5, 7, 8 on an estimate whose line 6 was deleted before deleting started closing
// the gap itself (2026-10-06). Order is kept; only the numbers change.
//
// Estimates already turned into a Sales Order are left alone: the order copied their line numbers,
// and renumbering one side would leave the estimate and its order calling the same line different
// numbers. Name them with --include-converted to do them anyway.
//
//   node src/db/close-estimate-line-gaps.js                 # preview, every estimate
//   node src/db/close-estimate-line-gaps.js EST-123456      # preview one
//   node src/db/close-estimate-line-gaps.js --apply
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const INCLUDE_CONVERTED = process.argv.includes('--include-converted');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

async function gappedParents(table, parentCol, extraWhere, params) {
  const [rows] = await pool.query(
    `SELECT x.${parentCol} AS parent_id, COUNT(*) AS n, MAX(x.line_no) AS top, COUNT(DISTINCT x.line_no) AS distinct_nos
       FROM ${table} x ${extraWhere}
      GROUP BY x.${parentCol}
     HAVING MAX(x.line_no) <> COUNT(*) OR COUNT(DISTINCT x.line_no) <> COUNT(*) OR MIN(x.line_no) <> 1`, params);
  // A number used twice is not a gap: it is a line imported twice (1,1,2,2 ...), and renumbering
  // would turn a doubled estimate into a long one. Those are listed, never touched.
  return { gaps: rows.filter((r) => Number(r.distinct_nos) === Number(r.n)), dupes: rows.filter((r) => Number(r.distinct_nos) !== Number(r.n)) };
}

async function renumber(table, parentCol, parentId) {
  const [rows] = await pool.query(`SELECT id, line_no FROM ${table} WHERE ${parentCol} = ? ORDER BY line_no, id`, [parentId]);
  const changes = rows.map((r, i) => ({ id: r.id, from: r.line_no, to: i + 1 })).filter((c) => Number(c.from) !== c.to);
  if (APPLY) for (const c of changes) await pool.query(`UPDATE ${table} SET line_no = ? WHERE id = ?`, [c.to, c.id]);
  return { before: rows.map((r) => r.line_no).join(','), changed: changes.length };
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const scope = [];
  const params = [];
  if (ONE) { scope.push('e.estimate_no = ?'); params.push(ONE); }
  if (!INCLUDE_CONVERTED) scope.push('e.sales_order_id IS NULL');
  const estWhere = scope.length ? `AND ${scope.join(' AND ')}` : '';

  const { gaps: items, dupes } = await gappedParents('estimate_job_orders', 'estimate_id',
    `JOIN estimates e ON e.id = x.estimate_id WHERE 1=1 ${estWhere}`, params);
  let lines = 0;
  for (const g of items) {
    const [[e]] = await pool.query('SELECT estimate_no FROM estimates WHERE id = ?', [g.parent_id]);
    const r = await renumber('estimate_job_orders', 'estimate_id', g.parent_id);
    lines += r.changed;
    console.log(`  ${e.estimate_no}: items ${r.before} -> 1..${g.n}`);
  }

  const { gaps: procs } = await gappedParents('estimate_job_order_processes', 'estimate_job_order_id',
    `JOIN estimate_job_orders j ON j.id = x.estimate_job_order_id JOIN estimates e ON e.id = j.estimate_id WHERE 1=1 ${estWhere}`, params);
  let procLines = 0;
  for (const g of procs) {
    const r = await renumber('estimate_job_order_processes', 'estimate_job_order_id', g.parent_id);
    procLines += r.changed;
  }

  for (const d of dupes) {
    const [[e]] = await pool.query('SELECT estimate_no FROM estimates WHERE id = ?', [d.parent_id]);
    console.log(`  ${e.estimate_no}: ${d.n} item lines but only ${d.distinct_nos} numbers -- lines repeated, LEFT ALONE (check for a double import)`);
  }
  console.log(`${items.length} estimate(s) with gapped item lines (${lines} renumbered), `
    + `${procs.length} item line(s) with gapped processes (${procLines} renumbered)${APPLY ? '' : ' -- preview, nothing written'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
