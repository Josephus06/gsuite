// Job Orders whose Built / QI / Delivered read MORE than the JO's quantity (asked 2026-10-28,
// JO-70528-1-1: Qty 50, Built 80, QI 80, Delivered 80).
//
// The order was cut in the source after production -- SO-70528's line went 80 -> 50 and the source
// brought its JO, AB-130647, QI-129128 and ID-80038 down to 50 with it -- but T1S had already imported
// them at 80. T1S's own screens refuse to build, inspect or deliver past the JO quantity, so this is
// imported data only. (fix-so-lines-from-source.js already set the SO line to 50.)
//
// For every JO whose builds, inspections or deliveries exceed its quantity or its SO line's, this
// re-reads the source and sets, by document number:
//   the JO's quantity                    the source JO's Quantity
//   each assembly build                  built = the source AB's Quantity; passed = its inspected less
//                                        RMA, never above what it built (the source left AB-130647
//                                        saying 80 inspected of 50)
//   each QI line on that build           AB qty / pass qty to match
//   each item delivery line of the JO    the source delivery's quantity for the JO
// then the JO header's Built / QI / Delivered from those, never above the JO's quantity. A JO the
// source does not have, or a record the source no longer has, is listed and left alone.
//
//   node src/db/fix-jo-production-over-qty.js                  preview
//   node src/db/fix-jo-production-over-qty.js JO-70528-1-1     preview one
//   node src/db/fix-jo-production-over-qty.js --apply          writes a rollback file
//   node src/db/fix-jo-production-over-qty.js --rollback=rollback/jo-production-over-qty-<stamp>.json
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = (process.argv.find((a) => a.startsWith('--rollback=')) || '').split('=').slice(1).join('=');
const ONLY =process.argv.slice(2).filter((a) => /^JO-/i.test(a)).map((a) => a.toUpperCase());
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
    for (const p of saved) {
      for (const a of p.abs) {
        await pool.query('UPDATE assembly_builds SET quantity_built = ?, passed_qty = ?, rma_qty = ? WHERE id = ?', [a.quantity_built, a.passed_qty, a.rma_qty, a.id]);
        await pool.query('UPDATE quality_inspection_lines SET ab_qty = ?, pass_qty = ?, rma_qty = ? WHERE assembly_build_id = ?', [a.quantity_built, a.passed_qty, a.rma_qty, a.id]);
      }
      for (const d of p.dels) await pool.query('UPDATE item_delivery_lines SET qty_delivered = ? WHERE id = ?', [d.qty_delivered, d.id]);
      const j = p.jo;
      await pool.query('UPDATE job_orders SET quantity = ?, quantity_built = ?, quantity_inspected = ?, quantity_delivered = ? WHERE id = ?',
        [j.quantity, j.quantity_built, j.quantity_inspected, j.quantity_delivered, j.id]);
    }
    console.log(`Restored ${saved.length} job order(s).`);
    await pool.end();
    return;
  }
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered,
            jo.sales_order_id, so.sales_order_no, l.quantity AS line_qty
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN sales_order_lines l ON l.id = jo.sales_order_line_id
      WHERE (jo.status IS NULL OR jo.status <> 'Cancelled')
        ${ONLY.length
    ? 'AND jo.job_order_no IN (?)' // a JO named is checked against the source whatever it reads here
    : `AND GREATEST(COALESCE(jo.quantity_built, 0), COALESCE(jo.quantity_inspected, 0), COALESCE(jo.quantity_delivered, 0))
            > LEAST(jo.quantity, COALESCE(l.quantity, jo.quantity)) + 0.0001`}
      ORDER BY jo.id`, ONLY.length ? [ONLY] : []);
  console.log(`${jos.length} job order(s) with more built / QI'd / delivered than their quantity.\n`);
  if (!jos.length) { await pool.end(); return; }

  const t = await L.login();
  const soDeliveries = new Map(); // source SO number -> [{ no, jobs: [ledger job rows] }]
  const plans = [];
  const notes = { notInSource: [], stillOver: [], missingRecords: [] };

  for (const jo of jos) {
    const src = L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: jo.job_order_no, Module_TransH: 'JOBORDER' }, limit: 2 }))[0];
    if (!src) { notes.notInSource.push(jo.job_order_no); continue; }
    const qty = num(src.Quantity_TransH);
    const abs = L.listRows(await api(t, 'get_transactions', { where: { SysFK_TransHJO_TransH: src.SysPK_TransH, Module_TransH: 'ASSMBUILD' } }))
      .filter((x) => !L.isVoidOrCancelled(x.Status_TransH))
      .map((x) => {
        const built = num(x.Quantity_TransH);
        const rma = num(x.QuantityRMA_TransH);
        return { no: x.UserPK_TransH, built, rma, passed: Math.min(built, Math.max(0, num(x.QuantityInspected_TransH) - rma)) };
      });
    if (jo.sales_order_no && !soDeliveries.has(jo.sales_order_no)) {
      const so = L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: jo.sales_order_no, Module_TransH: 'SALESORDER' }, limit: 1 }))[0];
      const list = [];
      if (so) {
        const dels = L.listRows(await api(t, 'get_transactions', { where: { SysFK_TransHSO_TransH: so.SysPK_TransH, Module_TransH: 'ITEMD' }, limit: 200 }))
          .filter((d) => !L.isVoidOrCancelled(d.Status_TransH));
        for (const d of dels) list.push({ no: d.UserPK_TransH, jobs: L.listRows(await api(t, 'get_transaction_ledger_jobs', { where: { SysFK_TransH_LdgrJob: d.SysPK_TransH } })) });
      }
      soDeliveries.set(jo.sales_order_no, list);
    }
    const dels = (soDeliveries.get(jo.sales_order_no) || [])
      .map((d) => ({ no: d.no, qty: num(d.jobs.filter((j) => j.SysFK_TransHJO_LdgrJob === src.SysPK_TransH).reduce((s, j) => s + (Number(j.Qty_LdgrJob) || Number(j.Fulfilled_LdgrJob) || 0), 0)) }))
      .filter((d) => d.qty > 0);

    // The T1S records these update, by number.
    const [myAbs] = await pool.query('SELECT id, ab_no, quantity_built, passed_qty, rma_qty FROM assembly_builds WHERE job_order_id = ? AND COALESCE(status, \'\') <> \'cancelled\'', [jo.id]);
    const [myDels] = await pool.query(
      `SELECT dl.id, d.delivery_no, dl.qty_delivered FROM item_delivery_lines dl JOIN item_deliveries d ON d.id = dl.item_delivery_id
        WHERE dl.job_order_id = ? AND COALESCE(d.status, '') <> 'cancelled'`, [jo.id]);
    const [[hasQi]] = await pool.query("SELECT COUNT(*) AS n FROM quality_inspections WHERE job_order_id = ? AND COALESCE(status, '') <> 'cancelled'", [jo.id]);
    const abChanges = [];
    for (const a of myAbs) {
      const s = abs.find((x) => x.no === a.ab_no);
      if (!s) { notes.missingRecords.push(`${jo.job_order_no} ${a.ab_no} (not live in the source)`); continue; }
      if (num(a.quantity_built) !== s.built || num(a.passed_qty) !== s.passed || num(a.rma_qty) !== s.rma) abChanges.push({ ...a, to: s });
    }
    const delChanges = [];
    for (const d of myDels) {
      const s = dels.find((x) => x.no === d.delivery_no);
      if (!s) { notes.missingRecords.push(`${jo.job_order_no} ${d.delivery_no} (no line for this JO in the source)`); continue; }
      if (num(d.qty_delivered) !== s.qty) delChanges.push({ ...d, to: s.qty });
    }
    // The header from the records once changed (a record left alone keeps its own figure).
    const built = num(myAbs.reduce((s, a) => s + Number(abChanges.find((c) => c.id === a.id)?.to.built ?? a.quantity_built ?? 0), 0));
    const passed = hasQi.n ? num(myAbs.reduce((s, a) => s + Number(abChanges.find((c) => c.id === a.id)?.to.passed ?? a.passed_qty ?? 0), 0)) : num(jo.quantity_inspected);
    const delivered = num(myDels.reduce((s, d) => s + Number(delChanges.find((c) => c.id === d.id)?.to ?? d.qty_delivered ?? 0), 0));
    // Where the source itself is over (JO-66851-3-4: 194 delivered of 97 on one delivery; JO-70430-1-1:
    // two builds of 14 for 14), the JO's totals stop at its quantity -- what the SO shows and what the
    // next build / QI / delivery is limited by. The documents stay as the source has them.
    const jq = qty || num(jo.quantity);
    const header = { quantity: jq, quantity_built: Math.min(built, jq), quantity_inspected: Math.min(passed, jq), quantity_delivered: Math.min(delivered, jq) };
    if (Math.max(built, passed, delivered) > jq + 0.0001) notes.stillOver.push(`${jo.job_order_no} (source: qty ${jq}, built ${built}, QI ${passed}, delivered ${delivered})`);
    const headerChanged = Object.keys(header).some((k) => num(jo[k]) !== header[k]);
    if (!abChanges.length && !delChanges.length && !headerChanged) continue;
    plans.push({ jo, header, abChanges, delChanges });
    console.log(`${jo.job_order_no} [${jo.sales_order_no || '-'}]: qty ${num(jo.quantity)} -> ${header.quantity}, built ${num(jo.quantity_built)} -> ${header.quantity_built}, QI ${num(jo.quantity_inspected)} -> ${header.quantity_inspected}, delivered ${num(jo.quantity_delivered)} -> ${header.quantity_delivered}`
      + `${abChanges.length ? `; ${abChanges.map((c) => `${c.ab_no} ${num(c.quantity_built)}/${num(c.passed_qty)} -> ${c.to.built}/${c.to.passed}`).join(', ')}` : ''}`
      + `${delChanges.length ? `; ${delChanges.map((c) => `${c.delivery_no} ${num(c.qty_delivered)} -> ${c.to}`).join(', ')}` : ''}`);
  }

  console.log(`\nTo fix: ${plans.length} job order(s).`);
  if (notes.notInSource.length) console.log(`Not in the source (made in T1S) -- left alone (${notes.notInSource.length}): ${notes.notInSource.join(', ')}`);
  if (notes.missingRecords.length) console.log(`Records the source no longer has -- left alone (${notes.missingRecords.length}):\n  ${notes.missingRecords.join('\n  ')}`);
  if (notes.stillOver.length) console.log(`Over in the source itself -- the JO's totals capped at its quantity, the documents kept as the source has them (${notes.stillOver.length}):\n  ${notes.stillOver.join('\n  ')}`);
  if (!APPLY || !plans.length) { if (!APPLY) console.log('\nPREVIEW -- nothing written. Re-run with --apply.'); await pool.end(); return; }

  const dir = path.join(__dirname, '..', '..', 'rollback');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `jo-production-over-qty-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(plans.map((p) => ({
    jo: { id: p.jo.id, quantity: p.jo.quantity, quantity_built: p.jo.quantity_built, quantity_inspected: p.jo.quantity_inspected, quantity_delivered: p.jo.quantity_delivered },
    abs: p.abChanges.map((c) => ({ id: c.id, quantity_built: c.quantity_built, passed_qty: c.passed_qty, rma_qty: c.rma_qty })),
    dels: p.delChanges.map((c) => ({ id: c.id, qty_delivered: c.qty_delivered })),
  }))));
  for (const p of plans) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const c of p.abChanges) {
        await conn.query('UPDATE assembly_builds SET quantity_built = ?, passed_qty = ?, rma_qty = ? WHERE id = ?', [c.to.built, c.to.passed, c.to.rma, c.id]);
        await conn.query('UPDATE quality_inspection_lines SET ab_qty = ?, pass_qty = ?, rma_qty = ? WHERE assembly_build_id = ?', [c.to.built, c.to.passed, c.to.rma, c.id]);
      }
      for (const c of p.delChanges) await conn.query('UPDATE item_delivery_lines SET qty_delivered = ? WHERE id = ?', [c.to, c.id]);
      await conn.query(
        'UPDATE job_orders SET quantity = ?, quantity_built = ?, quantity_inspected = ?, quantity_delivered = ?, updated_at = NOW() WHERE id = ?',
        [p.header.quantity, p.header.quantity_built, p.header.quantity_inspected, p.header.quantity_delivered, p.jo.id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); console.error(`  !! ${p.jo.job_order_no}: ${e.message}`); } finally { conn.release(); }
  }
  console.log(`\nFixed ${plans.length} job order(s). Rollback data: ${file}`);
  await pool.end();
})().catch(async (e) => { console.error('ERR', e.message); await pool.end(); process.exit(1); });
