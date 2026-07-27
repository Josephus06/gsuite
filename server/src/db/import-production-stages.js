// Migrate the production-lifecycle stages the base sales import doesn't cover:
//   Assembly Build -> Quality Inspection -> Item Delivery
// These live as generic transaction headers (get_transactions) keyed by Module_TransH:
//   ASSMBUILD / QI link to a JO via SysFK_TransHJO_TransH (and carry UserPKJO_TransH = JO#)
//   ITEMD links to an SO via SysFK_TransHSO_TransH; its delivered JOs are ledger-job lines.
// We match to local rows by JO number / SO number (no live-PK persistence needed).
//
// Runs over the same rep presets as import-sales.js. RESUMABLE + IDEMPOTENT: each JO's
// assembly builds / QIs and each SO's deliveries are deleted+reinserted, so re-running is safe.
//
//   node src/db/import-production-stages.js --preset=sales3 --from=2026-01-01 --to=2026-07-31 --dry-run
//   node src/db/import-production-stages.js --preset=sales3 --from=2026-01-01 --to=2026-07-31
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const DELIVERIES_ONLY = process.argv.includes('--deliveries-only'); // re-do only item deliveries
function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '2026-01-01');
const TO = argVal('to', '2026-07-31');
const CONCURRENCY = 4;
const day = (v) => (v || '').toString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dOrNull = (v) => { const s = day(v); return s && s >= '1990-01-01' ? s : null; };
const repNorm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

const REP_PRESETS = {
  sales1: ['Michelle Riveral', 'Arjie Bayagna', 'Jocel Ann Berina', 'Catherine Jane Langajed'],
  sales3: ['JOJI ANN NICOLE FUENTES', 'Margie Lyn C. Cañete', 'Jerome Magale', 'Paul Adam T. Oporto', 'Vanessa Krystal Jean Garcia'],
};
const REPS = REP_PRESETS[argVal('preset', 'sales3')] || REP_PRESETS.sales3;
const REP_NORM_SET = new Set(REPS.map(repNorm));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function apiOnce(token, ep, payload, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function api(token, ep, payload, ms = 60000) {
  let last; for (let a = 0; a < 4; a += 1) { try { return await apiOnce(token, ep, payload, ms); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); } } throw last;
}
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));
const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : []); // get_transactions returns data:[...]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapWithConcurrency(items, limit, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Preset: ${argVal('preset', 'sales3')} | window ${FROM}..${TO}`);
  console.log(DRY_RUN ? 'DRY RUN -- fetch + report only.\n' : 'APPLYING.\n');

  // Local lookups.
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.sales_order_id, so.sales_order_no
       FROM job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id`);
  const joByNo = new Map(jos.map((j) => [j.job_order_no, j]));
  const [sos] = await pool.query('SELECT id, sales_order_no FROM sales_orders');
  const soByNo = new Map(sos.map((s) => [s.sales_order_no, s.id]));
  const [procs] = await pool.query('SELECT id, job_order_id, process_id, item_id, location_id, category, parts, process_qty, qty, unit, process_cost, material_cost, total_cost FROM job_order_processes');
  const procsByJo = new Map();
  for (const p of procs) { if (!procsByJo.has(p.job_order_id)) procsByJo.set(p.job_order_id, []); procsByJo.get(p.job_order_id).push(p); }
  const [[u]] = await pool.query("SELECT id FROM users WHERE is_active=TRUE ORDER BY id LIMIT 1");
  const sysUser = u ? u.id : null;

  const token = await login();

  // Collect target SOs (rep preset + date window), with their live PK + cert JOs.
  async function fetchPage(off) {
    for (let a = 0; a < 5; a += 1) { const l = listRows(await api(token, 'get_sales_orders', { searchKey: '', viewAll: true, limit: 200, offset: off })); if (l.length) return l; await sleep(2000 * (a + 1)); }
    return [];
  }
  const targetSos = [];
  for (let off = 0; off < 80000; off += 200) {
    const list = await fetchPage(off);
    if (!list.length) break;
    for (const so of list) {
      const d = day(so.DateCreated_TransH);
      if (d >= FROM && d <= TO && REP_NORM_SET.has(repNorm(so.Name_Empl))) targetSos.push({ soNo: so.so_upk, soPk: so.so_pk });
    }
    if (list.every((so) => day(so.DateCreated_TransH) < FROM)) break;
    if (off % 4000 === 0) process.stdout.write(`  paged ${off}...\n`);
  }
  console.log(`\n${targetSos.length} target SO(s).`);

  let abCount = 0, abLines = 0, qiCount = 0, qiLines = 0, delCount = 0, delLines = 0, fail = 0, processed = 0;

  await mapWithConcurrency(targetSos, CONCURRENCY, async (t) => {
    try {
      const localSoId = soByNo.get(t.soNo);
      if (!localSoId) return;
      const cert = listRows(await api(token, 'get_job_orders_for_cert', { soPK: t.soPk }));
      // live JO PK -> local job order (used to resolve delivery lines' SysFK_TransHJO_LdgrJob).
      const certByPk = new Map();
      for (const j of cert) { const lj = joByNo.get(j.UserPK_TransH); if (lj) certByPk.set(j.SysPK_TransH, lj); }

      // --- Per-JO: assembly builds + QIs ---
      const abByJo = new Map(); // localJoId -> [{abId(local), qty}] for QI linking
      for (const j of DELIVERIES_ONLY ? [] : cert) {
        const localJo = joByNo.get(j.UserPK_TransH);
        if (!localJo) continue;
        const abs = rowsOf(await api(token, 'get_transactions', { where: { SysFK_TransHJO_TransH: j.SysPK_TransH, Module_TransH: 'ASSMBUILD' } }));
        const qis = rowsOf(await api(token, 'get_transactions', { where: { SysFK_TransHJO_TransH: j.SysPK_TransH, Module_TransH: 'QI' } }));
        if (!abs.length && !qis.length) continue;

        if (!DRY_RUN) {
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            // replace this JO's assembly builds + QIs
            const [oldAbs] = await conn.query('SELECT id FROM assembly_builds WHERE job_order_id = ?', [localJo.id]);
            if (oldAbs.length) {
              const [oldQis] = await conn.query('SELECT id FROM quality_inspections WHERE job_order_id = ?', [localJo.id]);
              if (oldQis.length) await conn.query('DELETE FROM quality_inspection_lines WHERE quality_inspection_id IN (?)', [oldQis.map((q) => q.id)]);
              await conn.query('DELETE FROM quality_inspection_lines WHERE assembly_build_id IN (?)', [oldAbs.map((a) => a.id)]);
              await conn.query('DELETE FROM assembly_build_lines WHERE assembly_build_id IN (?)', [oldAbs.map((a) => a.id)]);
            }
            await conn.query('DELETE FROM quality_inspections WHERE job_order_id = ?', [localJo.id]);
            await conn.query('DELETE FROM assembly_builds WHERE job_order_id = ?', [localJo.id]);

            const localAbIds = [];
            for (const ab of abs) {
              const [r] = await conn.query(
                `INSERT INTO assembly_builds (ab_no, job_order_id, date_created, quantity_built, total_amount, status, memo, created_by_user_id, passed_qty, rma_qty)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [ab.UserPK_TransH, localJo.id, dOrNull(ab.DateCreated_TransH) || day(new Date().toISOString()), num(ab.Quantity_TransH),
                 num(ab.TotalAmount_TransH), (ab.Status_TransH || 'completed').toString().slice(0, 40), ab.Memo_TransH || null, sysUser,
                 Math.max(0, num(ab.QuantityInspected_TransH) - num(ab.QuantityRMA_TransH)), num(ab.QuantityRMA_TransH)]);
              localAbIds.push({ id: r.insertId, qty: num(ab.Quantity_TransH), inspected: num(ab.QuantityInspected_TransH), rma: num(ab.QuantityRMA_TransH) });
              abCount += 1;
              // lines: link the AB to each of the JO's process rows
              const jps = procsByJo.get(localJo.id) || [];
              let ln = 0;
              for (const p of jps) {
                ln += 1;
                await conn.query(
                  `INSERT INTO assembly_build_lines (assembly_build_id, job_order_process_id, process_id, item_id, location_id, category, parts, process_qty, qty, total_qty_to_build, total_completed, total_build, unit, process_cost, material_cost, total_cost)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                  [r.insertId, p.id, p.process_id, p.item_id, p.location_id, p.category, p.parts, p.process_qty, p.qty,
                   num(ab.Quantity_TransH), num(ab.Quantity_TransH), num(ab.Quantity_TransH), p.unit, p.process_cost, p.material_cost, p.total_cost]);
                abLines += 1;
              }
            }
            abByJo.set(localJo.id, localAbIds);

            for (const qi of qis) {
              const [r] = await conn.query(
                `INSERT INTO quality_inspections (qi_no, job_order_id, date_created, memo, status, created_by_user_id)
                 VALUES (?,?,?,?,?,?)`,
                [qi.UserPK_TransH, localJo.id, dOrNull(qi.DateCreated_TransH) || day(new Date().toISOString()), qi.Memo_TransH || null,
                 (qi.Status_TransH || 'completed').toString().slice(0, 40), sysUser]);
              qiCount += 1;
              // QI lines: one per assembly build of this JO
              for (const a of localAbIds) {
                await conn.query(
                  `INSERT INTO quality_inspection_lines (quality_inspection_id, assembly_build_id, ab_qty, pass_qty, rma_qty)
                   VALUES (?,?,?,?,?)`,
                  [r.insertId, a.id, a.qty, Math.max(0, a.inspected - a.rma) || a.qty, a.rma]);
                qiLines += 1;
              }
            }
            await conn.commit();
          } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
        } else { abCount += abs.length; qiCount += qis.length; }
      }

      // --- Per-SO: item deliveries ---
      const dels = rowsOf(await api(token, 'get_transactions', { where: { SysFK_TransHSO_TransH: t.soPk, Module_TransH: 'ITEMD' } }));
      if (dels.length && !DRY_RUN) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [oldD] = await conn.query('SELECT id FROM item_deliveries WHERE sales_order_id = ?', [localSoId]);
          if (oldD.length) await conn.query('DELETE FROM item_delivery_lines WHERE item_delivery_id IN (?)', [oldD.map((d) => d.id)]);
          await conn.query('DELETE FROM item_deliveries WHERE sales_order_id = ?', [localSoId]);
          for (const del of dels) {
            const [r] = await conn.query(
              `INSERT INTO item_deliveries (delivery_no, sales_order_id, date_created, memo, status, created_by_user_id)
               VALUES (?,?,?,?,?,?)`,
              [del.UserPK_TransH, localSoId, dOrNull(del.DateCreated_TransH) || day(new Date().toISOString()), del.Memo_TransH || null,
               (del.Status_TransH || 'delivered').toString().slice(0, 40), sysUser]);
            delCount += 1;
            // delivery lines: delivered JOs via the delivery's ledger-job rows
            const ljobs = rowsOf(await api(token, 'get_transaction_ledger_jobs', { where: { SysFK_TransH_LdgrJob: del.SysPK_TransH } }));
            const seen = new Set();
            for (const lj of ljobs) {
              // Delivery lines reference the delivered JO by its live PK (SysFK_TransHJO_LdgrJob).
              const lj2 = certByPk.get(lj.SysFK_TransHJO_LdgrJob);
              if (!lj2 || seen.has(lj2.id)) continue; seen.add(lj2.id);
              await conn.query('INSERT INTO item_delivery_lines (item_delivery_id, job_order_id, qty_delivered, memo) VALUES (?,?,?,?)',
                [r.insertId, lj2.id, num(lj.Qty_LdgrJob) || num(lj.Fulfilled_LdgrJob) || 0, null]);
              delLines += 1;
            }
          }
          await conn.commit();
        } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
      } else if (dels.length) { delCount += dels.length; }
    } catch (e) { fail += 1; }
    processed += 1;
    if (processed % 100 === 0) console.log(`  ...${processed}/${targetSos.length} SOs | AB ${abCount} QI ${qiCount} DEL ${delCount}`);
  });

  console.log(`\nDone. Assembly builds: ${abCount} (${abLines} lines) | QIs: ${qiCount} (${qiLines} lines) | Deliveries: ${delCount} (${delLines} lines). SO failures: ${fail}.`);
  if (DRY_RUN) console.log('DRY RUN -- nothing written.');
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
