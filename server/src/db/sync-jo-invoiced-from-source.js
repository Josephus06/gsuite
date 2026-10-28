// A Job Order's Invoiced quantity (job_orders.quantity_invoiced) raised to what the SOURCE says it
// invoiced (asked 2026-10-28, JO-23809-4-5: Invoiced 20 of 24 in T1S, all 24 in the source).
//
// The source keeps the figure per Sales Order line (get_transaction_ledger_jobs, Invoiced_LdgrJob)
// and it is not always the sum of invoice lines: DT-2341 delivered all 24 of JO-23809-4-5 and was
// converted, the source counting 24 invoiced, though INV-40262's line says 20. T1S counts invoice
// lines, so the JO sat on Pending Billing with 4 left. Pending Billing now takes the JO's counter
// when higher; this sets the counter from the source.
//
// Only ever RAISES the counter, and never above the JO's quantity. By default it checks every JO
// on Pending Billing (the report's own rows); name JOs or --so= to check those instead.
//
//   node src/db/sync-jo-invoiced-from-source.js                       preview, the Pending Billing JOs
//   node src/db/sync-jo-invoiced-from-source.js JO-23809-4-5          preview one
//   node src/db/sync-jo-invoiced-from-source.js --apply               writes a rollback file
//   node src/db/sync-jo-invoiced-from-source.js --rollback=rollback/jo-invoiced-source-<stamp>.json
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=').slice(1).join('=');
const ONLY = process.argv.slice(2).filter((a) => /^JO-/i.test(a)).map((a) => a.toUpperCase());
const num = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(t, ep, payload) {
  for (let a = 0; a < 4; a += 1) {
    try { return await L.api(t, ep, payload); } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return null;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLYING' : 'PREVIEW'}`);
  if (ROLLBACK) {
    const saved = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    for (const r of saved) await pool.query('UPDATE job_orders SET quantity_invoiced = ? WHERE id = ?', [r.quantity_invoiced, r.id]);
    console.log(`Restored ${saved.length} job order(s).`);
    await pool.end();
    return;
  }

  let jos;
  if (ONLY.length) {
    [jos] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.quantity, jo.quantity_invoiced, so.sales_order_no
         FROM job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id WHERE jo.job_order_no IN (?)`, [ONLY]);
  } else {
    const { loadRows } = require('../routes/pendingBillingReport');
    const rows = await loadRows({ query: {}, user: { id: 1 } }, { allReps: true });
    jos = rows.filter((r) => r.sales_order_no).map((r) => ({ id: r.id, job_order_no: r.job_order_no, quantity: r.quantity, quantity_invoiced: r.quantity_invoiced, sales_order_no: r.sales_order_no }));
  }
  console.log(`${jos.length} job order(s) to check against the source.\n`);

  const t = await L.login();
  const bySo = new Map();
  for (const jo of jos) { if (!bySo.has(jo.sales_order_no)) bySo.set(jo.sales_order_no, []); bySo.get(jo.sales_order_no).push(jo); }
  const plans = [];
  let checked = 0;
  for (const [soNo, list] of bySo) {
    const so = L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: soNo, Module_TransH: 'SALESORDER' }, limit: 1 }))[0];
    if (!so) { console.log(`${soNo}: not in the source`); continue; }
    const srcJos = L.listRows(await api(t, 'get_transactions', { where: { SysFK_TransHSO_TransH: so.SysPK_TransH, Module_TransH: 'JOBORDER' }, limit: 500 }));
    const joNoByPk = new Map(srcJos.map((j) => [j.SysPK_TransH, String(j.UserPK_TransH || '').toUpperCase()]));
    const invoicedByJo = new Map();
    for (const l of L.listRows(await api(t, 'get_transaction_ledger_jobs', { where: { SysFK_TransH_LdgrJob: so.SysPK_TransH } }))) {
      const no = joNoByPk.get(l.SysFK_TransHJO_LdgrJob);
      if (no) invoicedByJo.set(no, (invoicedByJo.get(no) || 0) + num(l.Invoiced_LdgrJob));
    }
    for (const jo of list) {
      checked += 1;
      const src = invoicedByJo.get(String(jo.job_order_no).toUpperCase());
      if (src == null) continue;
      const to = Math.min(num(jo.quantity), num(src));
      if (to > num(jo.quantity_invoiced) + 0.0001) {
        plans.push({ ...jo, to });
        console.log(`${jo.job_order_no} [${soNo}] qty ${num(jo.quantity)}: invoiced ${num(jo.quantity_invoiced)} -> ${to} (source ${num(src)})`);
      }
    }
  }
  console.log(`\nTo raise: ${plans.length} job order(s).`);
  if (!APPLY || !plans.length) { if (!APPLY) console.log('\nPREVIEW -- nothing written. Re-run with --apply.'); await pool.end(); return; }

  const dir = path.join(__dirname, '..', '..', 'rollback');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `jo-invoiced-source-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(plans.map((p) => ({ id: p.id, quantity_invoiced: p.quantity_invoiced }))));
  for (const p of plans) {
    await pool.query('UPDATE job_orders SET quantity_invoiced = ?, updated_at = NOW() WHERE id = ? AND COALESCE(quantity_invoiced, 0) < ?', [p.to, p.id, p.to]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'quantity_invoiced', ?, ?, 1)`, [p.id, String(num(p.quantity_invoiced)), String(p.to)]);
  }
  console.log(`\nRaised ${plans.length} job order(s). Rollback data: ${file}`);
  await pool.end();
})().catch(async (e) => { console.error('ERR', e.message); await pool.end(); process.exit(1); });
