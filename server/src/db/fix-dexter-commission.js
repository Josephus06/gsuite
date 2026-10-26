// Dexter Bantilan's 2026 Commission report against the source (checked 2026-10-26):
//
//   SO-70464  (Jude Tamara, 1,607.14, 26 Jul)  the source's rep is Dexter Bantilan; T1S carried the
//             approver, Cindy Marie Deniay_AYALA, as the rep -- July's Weighted Sales came out
//             1,607.14 short (114.53% instead of 115.14%) and a bracket lower. -> rep set to Dexter.
//   SO-64157 / SO-64629  (D' Wonders of the World, 60,675.60 each, Jan / Feb)  GP 43.2%, under the
//             DPOD job type's 55% -- approved on the source by the General Manager (Jimmy Wu) and
//             counted there as passing; T1S left them out of "JOs with Passing Rate", and February
//             dropped a bracket. -> their lines marked approved low GP, as "Add to commission" does.
//
// Audit-logged on each sales order.
//   node src/db/fix-dexter-commission.js                  preview
//   node src/db/fix-dexter-commission.js --apply --by=1
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
const BY = Number((process.argv.find((a) => a.startsWith('--by=')) || '').slice(5)) || null;
const REP_FIX = { so: 'SO-70464', rep: ['Dexter', 'Bantilan'] };
const LOW_GP_SOS = ['SO-64157', 'SO-64629'];

async function audit(conn, soId, field, oldValue, newValue) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('SalesOrder', ?, 'Updated', ?, ?, ?, ?)`,
    [soId, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), BY]);
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply --by=<user id> to write)'}\n`);
  if (APPLY && !BY) throw new Error('--by=<user id> is required with --apply');
  const conn = await pool.getConnection();
  try {
    if (APPLY) await conn.beginTransaction();

    const [[dexter]] = await conn.query('SELECT id, CONCAT(first_name, " ", last_name) AS name FROM employees WHERE first_name = ? AND last_name = ?', REP_FIX.rep);
    if (!dexter) throw new Error('Dexter Bantilan not found in employees');
    const [[so]] = await conn.query(
      `SELECT so.id, so.sales_order_no, so.sales_rep_id, CONCAT(e.first_name, ' ', e.last_name) AS rep
         FROM sales_orders so LEFT JOIN employees e ON e.id = so.sales_rep_id WHERE so.sales_order_no = ?`, [REP_FIX.so]);
    if (!so) console.log(`${REP_FIX.so}: not found`);
    else if (Number(so.sales_rep_id) === Number(dexter.id)) console.log(`${REP_FIX.so}: rep already ${dexter.name}`);
    else {
      console.log(`${REP_FIX.so}: sales rep ${so.rep} -> ${dexter.name}`);
      if (APPLY) {
        await conn.query('UPDATE sales_orders SET sales_rep_id = ?, updated_at = NOW() WHERE id = ?', [dexter.id, so.id]);
        await audit(conn, so.id, 'sales_rep_id', `${so.rep} (source: Dexter Bantilan)`, dexter.name);
      }
    }

    for (const no of LOW_GP_SOS) {
      const [lines] = await conn.query(
        `SELECT so.id AS so_id, sol.id, sol.is_approved_low_gp, jo.job_order_no, sol.net_of_tax
           FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
           LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
          WHERE so.sales_order_no = ?`, [no]);
      if (!lines.length) { console.log(`${no}: not found`); continue; }
      for (const l of lines) {
        if (Number(l.is_approved_low_gp) === 1) { console.log(`${no} ${l.job_order_no || `line ${l.id}`}: already approved low GP`); continue; }
        if (!l.job_order_no) { console.log(`${no} line ${l.id}: no job order -- left`); continue; }
        console.log(`${no} ${l.job_order_no} (${l.net_of_tax}): approved low GP -> counts as passing`);
        if (APPLY) {
          await conn.query('UPDATE sales_order_lines SET is_approved_low_gp = 1 WHERE id = ?', [l.id]);
          await audit(conn, l.so_id, `Approved low GP (${l.job_order_no})`, 'No', 'Yes -- approved by the GM on the source');
        }
      }
    }

    if (APPLY) { await conn.commit(); console.log('\nApplied.'); }
  } catch (e) {
    if (APPLY) await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
