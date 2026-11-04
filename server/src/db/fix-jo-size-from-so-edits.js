// Editing a Sales Order line copied only qty, description and job location to its Job Order, so a
// size or delivery change stayed on the line: SO-196032 line 3 went 150 x 150 MM to 20 x 20 CM and
// JO-196032-3-5 still read 150 x 150 (2026-11-04). The edit carries them over now; this puts the
// already-edited ones right.
//
// Only lines whose size / units / delivery was edited in T1S (the Sales Order's audit log names the
// line and field) are touched, and the JO takes the line's current values. A JO that already matches
// is left alone.
//
//   node src/db/fix-jo-size-from-so-edits.js              # preview
//   node src/db/fix-jo-size-from-so-edits.js SO-196032    # preview one
//   node src/db/fix-jo-size-from-so-edits.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const FIELDS = ['units', 'length', 'width', 'height', 'delivery_date', 'delivery_time'];
// Compared as text, numbers by value (DECIMAL 150.00 = 150).
const val = (v) => { const t = v == null ? '' : String(v).trim(); return /^-?\d+(\.\d+)?$/.test(t) ? String(Number(t)) : t; };

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [rows] = await pool.query(
    `SELECT DISTINCT so.sales_order_no, sol.line_no, jo.id AS jo_id, jo.job_order_no,
            ${FIELDS.map((f) => `sol.${f} AS sol_${f}, jo.${f} AS jo_${f}`).join(', ')}
       FROM audit_logs a
       JOIN sales_orders so ON so.id = a.auditable_id
       JOIN sales_order_lines sol ON sol.sales_order_id = so.id
        AND a.field_name IN (${FIELDS.map((f) => `CONCAT('line ', sol.line_no, ' · ${f}')`).join(', ')})
       JOIN job_orders jo ON jo.id = sol.job_order_id AND jo.status <> 'Cancelled'
      WHERE a.auditable_type = 'SalesOrder' ${ONE ? 'AND so.sales_order_no = ?' : ''}
      ORDER BY so.sales_order_no, sol.line_no`, ONE ? [ONE] : []);

  let changed = 0;
  for (const r of rows) {
    const diff = FIELDS.filter((f) => val(r[`sol_${f}`]) !== val(r[`jo_${f}`]));
    if (!diff.length) continue;
    changed += 1;
    console.log(`  ${r.job_order_no} (${r.sales_order_no} line ${r.line_no}): ${diff.map((f) => `${f} ${val(r[`jo_${f}`]) || '-'} -> ${val(r[`sol_${f}`]) || '-'}`).join(', ')}`);
    if (APPLY) {
      await pool.query(`UPDATE job_orders SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
        [...FIELDS.map((f) => r[`sol_${f}`]), r.jo_id]);
    }
  }
  console.log(`${rows.length} edited line(s) checked, ${changed} JO(s) ${APPLY ? 'updated' : 'to update'}.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
