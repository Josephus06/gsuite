// 2026 Sales Orders whose lines do not add up to the SO (asked 2026-10-22, Commission report Weighted
// Sales, which adds up lines): the header matches the source, the LINES kept what they were before a
// change made in the source before the cut-over -- a quantity cut (SO-67242 line 3, 52 -> 35 yearbooks),
// a discount (SO-71527), a line merged (SO-61829). Each line is set to the source's own line, by order:
// quantity, price, subtotal, discount, net of tax, tax, gross. A T1S line the source no longer has, with
// no job order, is removed; one with a job order is reported and left. A line on a CANCELLED job order is
// skipped -- the SO total already leaves it out, as does the Commission report (SO-70642).
//
// Read-only against the source (get_transactions / get_estimate). Audit-logged per line.
//   node src/db/fix-so-lines-from-source.js                 preview, every such 2026 SO
//   node src/db/fix-so-lines-from-source.js SO-67242        preview one
//   node src/db/fix-so-lines-from-source.js --apply --by=<user id>
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;
const only = process.argv.slice(2).filter((a) => /^SO-/i.test(a));
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(n(v) * 100) / 100;

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- PREVIEW (add --apply to write)'}\n`);
  const [sos] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.net_of_tax FROM sales_orders so
       JOIN (SELECT sol.sales_order_id, SUM(sol.net_of_tax) s FROM sales_order_lines sol
               LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
              WHERE jo.id IS NULL OR jo.status <> 'Cancelled' GROUP BY sol.sales_order_id) x ON x.sales_order_id = so.id
      WHERE YEAR(so.date_created) = 2026 AND so.status <> 'cancelled' AND ABS(x.s - so.net_of_tax) > 1
        ${only.length ? 'AND so.sales_order_no IN (?)' : ''}
      ORDER BY so.sales_order_no`, only.length ? [only] : []);
  const login = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const token = (await login.json())?.data?.token;
  if (!token) throw new Error('Source login failed.');
  const call = async (ep, body) => (await (await fetch(`${SITE}/api/${ep}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json());

  let changed = 0; let removed = 0;
  for (const so of sos) {
    const t = await call('get_transactions', { where: { Module_TransH: 'SALESORDER', UserPK_TransH: so.sales_order_no }, limit: 1 });
    const h = ((Array.isArray(t?.data?.[0]) ? t.data[0] : t?.data) || [])[0];
    if (!h) { console.log(`${so.sales_order_no}: not in the source -- left alone`); continue; }
    if (Math.abs(n(h.SubTotalVatEx_TransH) - n(so.net_of_tax)) > 0.05) {
      console.log(`${so.sales_order_no}: the SO itself differs from the source (${so.net_of_tax} vs ${h.SubTotalVatEx_TransH}) -- left alone`);
      continue;
    }
    const e = await call('get_estimate', { pk: h.SysPK_TransH });
    const src = (e?.data?.[1] || []).filter((l) => !n(l.IsCancelled_LdgrJob));
    const [lines] = await pool.query(
      `SELECT sol.id, sol.line_no, sol.quantity, sol.price_per_unit, sol.subtotal, sol.disc_amount, sol.net_of_tax, sol.tax_amount,
              sol.gross_amount, sol.job_order_id, jo.status AS jo_status
         FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
        WHERE sol.sales_order_id = ? ORDER BY sol.line_no, sol.id`, [so.id]);
    const live = lines.filter((l) => l.jo_status !== 'Cancelled');
    console.log(`${so.sales_order_no}: SO ${n(so.net_of_tax)}; T1S lines ${r2(live.reduce((s, l) => s + n(l.net_of_tax), 0))} -> source lines ${r2(src.reduce((s, l) => s + n(l.VatExAmount_LdgrJob), 0))}`);
    const conn = APPLY ? await pool.getConnection() : null;
    try {
      if (conn) await conn.beginTransaction();
      for (let i = 0; i < live.length; i += 1) {
        const l = live[i]; const s = src[i];
        if (!s) {
          if (l.job_order_id) { console.log(`   line ${l.line_no}: not in the source but has a job order -- left`); continue; }
          console.log(`   line ${l.line_no}: not in the source -> removed (${n(l.quantity)}, ${n(l.net_of_tax)})`);
          removed += 1;
          if (conn) {
            await conn.query('DELETE FROM sales_order_lines WHERE id = ?', [l.id]);
            await conn.query(`INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
              VALUES ('SalesOrder', ?, 'Updated', ?, ?, 'removed -- not on the source (fix-so-lines-from-source.js)', ?)`,
            [so.id, `line ${l.line_no}`, `${n(l.quantity)} / ${n(l.net_of_tax)}`, BY]);
          }
          continue;
        }
        const v = {
          quantity: n(s.Qty_LdgrJob), price_per_unit: n(s.PriceRate_LdgrJob || s.Price_LdgrJob), subtotal: r2(s.SubTotal_LdgrJob),
          disc_amount: r2(s.DiscountAmount_LdgrJob), net_of_tax: r2(s.VatExAmount_LdgrJob), tax_amount: r2(s.TaxAmount_LdgrJob),
          gross_amount: r2(s.GrossAmount_LdgrJob),
        };
        if (Math.abs(v.net_of_tax - n(l.net_of_tax)) < 0.005 && Math.abs(v.quantity - n(l.quantity)) < 0.00005) continue;
        console.log(`   line ${l.line_no}: ${n(l.quantity)} @ ${n(l.price_per_unit)} = ${n(l.net_of_tax)}  ->  ${v.quantity} @ ${v.price_per_unit} = ${v.net_of_tax} (disc ${v.disc_amount}, tax ${v.tax_amount})`);
        changed += 1;
        if (!conn) continue;
        await conn.query(
          `UPDATE sales_order_lines SET quantity = ?, price_per_unit = ?, subtotal = ?, disc_amount = ?, net_of_tax = ?, tax_amount = ?, gross_amount = ?
            WHERE id = ?`, [v.quantity, v.price_per_unit, v.subtotal, v.disc_amount, v.net_of_tax, v.tax_amount, v.gross_amount, l.id]);
        await conn.query(`INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
          VALUES ('SalesOrder', ?, 'Updated', ?, ?, ?, ?)`,
        [so.id, `line ${l.line_no} · quantity / net_of_tax`, `${n(l.quantity)} / ${n(l.net_of_tax)}`,
          `${v.quantity} / ${v.net_of_tax} -- the source's line (fix-so-lines-from-source.js)`, BY]);
      }
      if (conn) await conn.commit();
    } catch (err) { if (conn) await conn.rollback(); throw err; } finally { if (conn) conn.release(); }
  }
  console.log(`\n${APPLY ? 'Changed' : 'Would change'} ${changed} line(s), ${APPLY ? 'removed' : 'would remove'} ${removed}, on ${sos.length} SO(s).`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
