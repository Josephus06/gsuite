// Job Orders showing Built / QI / Delivered with no Assembly Build, QI or Item Delivery behind them
// (asked 2026-10-28, JO-64910-1-12: Built 4, QI 4, its Related Records only the SO -- in the source it
// is still Released, never built).
//
// The JO's totals (job_orders.quantity_built / quantity_inspected / quantity_delivered) are what the
// SO and JO show and what Pending Billing and the Bill / Item Delivery buttons go by. A rollup that ran
// until 2026-10-09 filled Built and QI with the whole quantity on any completed JO with no build
// (lib/joProductionRollup.js -- removed then), and SO-level "Pending Billing" marks every JO completed,
// so those figures were never real.
//
// For each JO whose totals are above what its own documents add up to, this reads the source and
// sets each total to what the source has -- its builds, their passed quantity, its delivery lines --
// never above the JO's quantity, and only ever DOWN. Where the source has documents T1S never took in,
// the total is left and the order listed to re-import (import-production-stages.js). Inspected is
// what the source's builds say passed (its QI records do not always name the JO). A JO the source
// does not have on the same Sales Order -- one made in T1S, or a number the source used on another
// order (RWIP-1) -- is listed and left alone.
//
//   node src/db/fix-jo-production-headers.js                   preview
//   node src/db/fix-jo-production-headers.js JO-64910-1-12     preview one
//   node src/db/fix-jo-production-headers.js --apply           writes a rollback file
//   node src/db/fix-jo-production-headers.js --rollback=rollback/jo-production-headers-<stamp>.json
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
const COLS = ['quantity_built', 'quantity_inspected', 'quantity_delivered'];

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
    for (const j of saved) {
      await pool.query('UPDATE job_orders SET quantity_built = ?, quantity_inspected = ?, quantity_delivered = ? WHERE id = ?',
        [j.quantity_built, j.quantity_inspected, j.quantity_delivered, j.id]);
    }
    console.log(`Restored ${saved.length} job order(s).`);
    await pool.end();
    return;
  }

  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered,
            so.sales_order_no, COALESCE(a.qb, 0) AS doc_built, COALESCE(a.pq, 0) AS doc_passed,
            COALESCE(d.qd, 0) AS doc_delivered
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN (SELECT job_order_id, SUM(quantity_built) qb, SUM(passed_qty) pq FROM assembly_builds
                   WHERE COALESCE(status, '') <> 'cancelled' GROUP BY job_order_id) a ON a.job_order_id = jo.id
       LEFT JOIN (SELECT dl.job_order_id, SUM(dl.qty_delivered) qd FROM item_delivery_lines dl JOIN item_deliveries x ON x.id = dl.item_delivery_id
                   WHERE COALESCE(x.status, '') <> 'cancelled' GROUP BY dl.job_order_id) d ON d.job_order_id = jo.id
      WHERE (jo.status IS NULL OR jo.status <> 'Cancelled')
        AND (jo.quantity_built > COALESCE(a.qb, 0) + 0.0001
             OR jo.quantity_inspected > COALESCE(a.pq, 0) + 0.0001
             OR jo.quantity_delivered > COALESCE(d.qd, 0) + 0.0001)
        ${ONLY.length ? 'AND jo.job_order_no IN (?)' : ''}
      ORDER BY jo.id`, ONLY.length ? [ONLY] : []);
  console.log(`${jos.length} job order(s) whose Built / QI / Delivered are above their own documents.\n`);
  if (!jos.length) { await pool.end(); return; }

  const t = await L.login();
  const soDeliveries = new Map();
  const soPks = new Map(); // SO number -> source pk
  const plans = [];
  const reimport = new Map(); // SO -> [JO numbers]
  const notInSource = [];

  for (const jo of jos) {
    const mine = { quantity_built: num(jo.doc_built), quantity_inspected: num(jo.doc_passed), quantity_delivered: num(jo.doc_delivered) };
    if (jo.sales_order_no && !soPks.has(jo.sales_order_no)) {
      const so = L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: jo.sales_order_no, Module_TransH: 'SALESORDER' }, limit: 1 }))[0];
      soPks.set(jo.sales_order_no, so ? so.SysPK_TransH : null);
    }
    const soPk = soPks.get(jo.sales_order_no);
    const src = soPk && L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: jo.job_order_no, Module_TransH: 'JOBORDER' }, limit: 5 }))
      .find((x) => x.SysFK_TransHSO_TransH === soPk);
    if (!src) { notInSource.push(jo.job_order_no); continue; }
    let theirs;
    {
      const abs = L.listRows(await api(t, 'get_transactions', { where: { SysFK_TransHJO_TransH: src.SysPK_TransH, Module_TransH: 'ASSMBUILD' } }))
        .filter((x) => !L.isVoidOrCancelled(x.Status_TransH));
      if (!soDeliveries.has(jo.sales_order_no)) {
        const list = [];
        {
          const dels = L.listRows(await api(t, 'get_transactions', { where: { SysFK_TransHSO_TransH: soPk, Module_TransH: 'ITEMD' }, limit: 200 }))
            .filter((d) => !L.isVoidOrCancelled(d.Status_TransH));
          for (const d of dels) list.push(...L.listRows(await api(t, 'get_transaction_ledger_jobs', { where: { SysFK_TransH_LdgrJob: d.SysPK_TransH } })));
        }
        soDeliveries.set(jo.sales_order_no, list);
      }
      const built = abs.reduce((s, x) => s + num(x.Quantity_TransH), 0);
      const passed = abs.reduce((s, x) => s + Math.min(num(x.Quantity_TransH), Math.max(0, num(x.QuantityInspected_TransH) - num(x.QuantityRMA_TransH))), 0);
      const delivered = (soDeliveries.get(jo.sales_order_no) || []).filter((j) => j.SysFK_TransHJO_LdgrJob === src.SysPK_TransH)
        .reduce((s, j) => s + (Number(j.Qty_LdgrJob) || Number(j.Fulfilled_LdgrJob) || 0), 0);
      theirs = { quantity_built: num(built), quantity_inspected: num(passed), quantity_delivered: num(delivered) };
    }
    const to = {};
    let lowers = false;
    for (const c of COLS) {
      const cur = num(jo[c]);
      if (cur <= mine[c] + 0.0001) { to[c] = cur; continue; } // backed by its own documents
      if (theirs[c] > mine[c] + 0.0001) { // the source has documents T1S does not
        if (!reimport.has(jo.sales_order_no)) reimport.set(jo.sales_order_no, []);
        reimport.get(jo.sales_order_no).push(jo.job_order_no);
      }
      const want = Math.min(num(jo.quantity), theirs[c]);
      to[c] = want < cur ? want : cur;
    }
    // Nothing is delivered that was not inspected, nor inspected that was not built: QI stays at least
    // Delivered and Built at least QI (JO-69527-1-1: delivered 1, its source build says 0 inspected).
    to.quantity_inspected = Math.min(num(jo.quantity_inspected), Math.max(to.quantity_inspected, to.quantity_delivered));
    to.quantity_built = Math.min(num(jo.quantity_built), Math.max(to.quantity_built, to.quantity_inspected));
    for (const c of COLS) if (to[c] < num(jo[c])) lowers = true;
    if (!lowers) continue;
    plans.push({ jo, to });
    console.log(`${jo.job_order_no} [${jo.sales_order_no || '-'}] qty ${num(jo.quantity)}: `
      + COLS.map((c) => `${c.replace('quantity_', '')} ${num(jo[c])}${to[c] !== num(jo[c]) ? ` -> ${to[c]}` : ''}`).join(', '));
  }

  console.log(`\nTo fix: ${plans.length} job order(s).`);
  if (notInSource.length) console.log(`Not in the source on the same order (made in T1S) -- left alone (${notInSource.length}): ${notInSource.join(', ')}`);
  if (reimport.size) {
    console.log(`\nThe source has builds / QIs / deliveries T1S never took in -- re-import these orders' production (${reimport.size}):`);
    for (const [so, list] of reimport) console.log(`  ${so}: ${[...new Set(list)].join(', ')}`);
  }
  if (!APPLY || !plans.length) { if (!APPLY) console.log('\nPREVIEW -- nothing written. Re-run with --apply.'); await pool.end(); return; }

  const dir = path.join(__dirname, '..', '..', 'rollback');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `jo-production-headers-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(plans.map((p) => ({ id: p.jo.id, quantity_built: p.jo.quantity_built, quantity_inspected: p.jo.quantity_inspected, quantity_delivered: p.jo.quantity_delivered }))));
  for (const p of plans) {
    await pool.query('UPDATE job_orders SET quantity_built = ?, quantity_inspected = ?, quantity_delivered = ?, updated_at = NOW() WHERE id = ?',
      [p.to.quantity_built, p.to.quantity_inspected, p.to.quantity_delivered, p.jo.id]);
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'production quantities', ?, ?, 1)`,
      [p.jo.id, COLS.map((c) => num(p.jo[c])).join(' / '), COLS.map((c) => p.to[c]).join(' / ')]);
  }
  console.log(`\nFixed ${plans.length} job order(s). Rollback data: ${file}`);
  await pool.end();
})().catch(async (e) => { console.error('ERR', e.message); await pool.end(); process.exit(1); });
