// The sales import brought in JO headers but never their process/material breakdown, so every
// imported Job Order's "Processes" tab is empty. This backfills job_order_processes from the
// live per-JO detail (get_job_order -> data[2] = LdgrInvty lines).
//
// Because we never persisted live JO PKs, we rediscover them: page get_sales_orders to map each
// local SO number -> live SO PK, then get_job_orders_for_cert per SO -> {JO#, JO PK}, then
// get_job_order per JO -> its process/material lines.
//
// RESUMABLE + IDEMPOTENT: a JO that already has job_order_processes rows is skipped, so a re-run
// continues where an interrupted run stopped. Pass --force to re-fetch and replace all.
//
//   node src/db/import-jo-processes.js --dry-run     # discover + report, no writes
//   node src/db/import-jo-processes.js               # backfill (skips already-populated JOs)
//   node src/db/import-jo-processes.js --force       # re-fetch and replace every JO's processes
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
// --missing-only: re-fetch just the JOs whose header enrichment (artist/location) is still
// blank -- i.e. the ones a prior run's live-side rate-limiting dropped. Implies FORCE for
// those JOs but leaves the already-enriched ones untouched, so a recovery run stays small.
const MISSING_ONLY = process.argv.includes('--missing-only');
// Live rate-limits sustained bursts; keep concurrency low on recovery runs to avoid it.
const JO_CONCURRENCY = MISSING_ONLY ? 3 : 5;

const num = (v) => { if (v === null || v === undefined || v === 'null' || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  return (await r.json())?.data?.token;
}
async function api(token, ep, payload, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The live server intermittently times out; retry with escalating timeout + backoff.
async function apiRetry(token, ep, payload, attempts = 4) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    try { return await api(token, ep, payload, 60000 + a * 30000); }
    catch (e) { last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- discover + report, nothing written.\n' : (FORCE ? 'APPLYING (--force: replace all).\n' : 'APPLYING (resume: skip already-populated JOs).\n'));

  // --- reference maps for FK resolution (all nullable, misses are fine) ---
  const [procs] = await pool.query('SELECT id, process_name FROM processes');
  const procById = new Map(procs.map((p) => [norm(p.process_name), p.id]));
  const [invs] = await pool.query('SELECT id, item_code, display_name, sales_description FROM inventories');
  const invById = new Map();
  for (const it of invs) { for (const k of [it.item_code, it.display_name, it.sales_description]) if (k && !invById.has(norm(k))) invById.set(norm(k), it.id); }
  const [locs] = await pool.query('SELECT id, location_name, location_code FROM locations');
  const locById = new Map();
  for (const l of locs) { for (const k of [l.location_name, l.location_code]) if (k && !locById.has(norm(k))) locById.set(norm(k), l.id); }
  // For the JO-header enrichment (artist / layout job type): resolve by name.
  const [emps] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS nm FROM employees");
  const empById = new Map(emps.map((e) => [norm(e.nm), e.id]));
  // The JO header's layout job type ("DESIGN-READY FILE ..." etc.) is a PMS job type: the
  // job_orders.layout_job_type_id FK (ibfk_7) references pms_job_types, NOT the sales job_types
  // table. These are pre-seeded and effectively complete, so resolve by name against them.
  // Collapse internal whitespace too -- live spells some names with a double space.
  const normWs = (s) => norm(s).replace(/\s+/g, ' ');
  const [pjts] = await pool.query('SELECT id, display_name FROM pms_job_types');
  const layoutById = new Map();
  for (const j of pjts) { const k = normWs(j.display_name); if (k && !layoutById.has(k)) layoutById.set(k, j.id); }
  let layoutCreated = 0;
  const layoutInflight = new Map();
  async function resolveLayoutJobType(displayName) {
    const key = normWs(displayName);
    if (!key) return null;
    if (layoutById.has(key)) return layoutById.get(key);
    if (layoutInflight.has(key)) return layoutInflight.get(key);
    const p = (async () => {
      let id = null;
      if (!DRY_RUN) {
        // Not in the seeded set -- create it in pms_job_types so the FK is satisfied and the
        // field still populates. code is NOT NULL and should be distinct; derive from the name.
        const base = String(displayName).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 40) || 'LAYOUT';
        const code = (base + '_' + (layoutCreated + 1)).slice(0, 50);
        const [r] = await pool.query('INSERT INTO pms_job_types (code, display_name, minutes_consume) VALUES (?, ?, 0)', [code, String(displayName).trim()]);
        id = r.insertId; layoutCreated += 1;
      }
      layoutById.set(key, id);
      return id;
    })();
    layoutInflight.set(key, p);
    return p;
  }

  // --- local JOs (number -> id) and which SOs own them ---
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, so.sales_order_no
       FROM job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id`);
  const joIdByNo = new Map(jos.map((j) => [j.job_order_no, j.id]));
  const localSoNos = new Set(jos.map((j) => j.sales_order_no));
  // JOs already populated (for resume)
  const [done] = await pool.query('SELECT DISTINCT job_order_id FROM job_order_processes');
  const populated = new Set(done.map((d) => d.job_order_id));
  console.log(`Local: ${joIdByNo.size} JO(s) across ${localSoNos.size} SO(s); ${populated.size} JO(s) already have processes.`);

  // --missing-only: the set of JOs whose header enrichment landed (artist or location set).
  // Everything NOT in here is what a prior run's rate-limiting dropped -- re-fetch only those.
  let enriched = new Set();
  if (MISSING_ONLY) {
    const [er] = await pool.query('SELECT id FROM job_orders WHERE artist_id IS NOT NULL OR job_location_id IS NOT NULL');
    enriched = new Set(er.map((r) => r.id));
    console.log(`--missing-only: ${enriched.size} JO(s) already enriched; will re-fetch the remaining ${joIdByNo.size - enriched.size}.`);
  }

  let token = await login();

  // --- page get_sales_orders: soNo -> live SO PK, only for SOs we imported ---
  // The viewAll listing occasionally returns an empty page transiently; retry a page a few
  // times before treating an empty result as "end of list".
  async function fetchPage(offset) {
    for (let a = 0; a < 4; a += 1) {
      const list = listRows(await apiRetry(token, 'get_sales_orders', { searchKey: '', viewAll: true, limit: 200, offset }));
      if (list.length) return list;
      await sleep(2000 * (a + 1));
    }
    return [];
  }
  const soPkByNo = new Map();
  const soGpByNo = new Map(); // so_upk -> live SO-level actual GP (gpRate)
  for (let offset = 0; offset < 80000; offset += 200) {
    const list = await fetchPage(offset);
    if (offset === 0) console.log(`  first page rows: ${list.length}` + (list[0] ? `, sample so_upk=${list[0].so_upk}, has so_pk=${list[0].so_pk != null}` : ''));
    if (!list.length) break;
    for (const so of list) {
      if (localSoNos.has(so.so_upk) && !soPkByNo.has(so.so_upk)) {
        soPkByNo.set(so.so_upk, so.so_pk ?? so.SysPK_TransH);
        if (so.gpRate != null && so.gpRate !== '') soGpByNo.set(so.so_upk, Number(so.gpRate));
      }
    }
    if (soPkByNo.size >= localSoNos.size) break;
    if (list.length < 200) break;
  }
  console.log(`Resolved live PK for ${soPkByNo.size}/${localSoNos.size} local SO(s).`);
  if (soPkByNo.size === 0) { console.error('No SO PKs resolved -- live listing returned nothing usable. Aborting (nothing written).'); await pool.end(); process.exit(1); }

  // Persist the exact SO-level actual GP (the one value live stores).
  if (!DRY_RUN && soGpByNo.size) {
    let gpUpd = 0;
    for (const [soNo, gp] of soGpByNo) {
      const [r] = await pool.query('UPDATE sales_orders SET actual_gp_rate = ? WHERE sales_order_no = ?', [gp, soNo]);
      gpUpd += r.affectedRows;
    }
    console.log(`Stored SO-level actual GP for ${gpUpd} sales order(s).`);
  }

  // --- per SO: list JOs (JO# -> live JO PK) ---
  const soEntries = [...soPkByNo.entries()];
  let certFail = 0;
  const joTargets = []; // {joNo, joId, joPk}
  await mapWithConcurrency(soEntries, JO_CONCURRENCY, async ([soNo, soPk]) => {
    try {
      const jrows = listRows(await apiRetry(token, 'get_job_orders_for_cert', { soPK: soPk }));
      for (const j of jrows) {
        const joNo = j.UserPK_TransH; const joId = joIdByNo.get(joNo);
        if (!joId) continue;
        if (MISSING_ONLY) { if (!enriched.has(joId)) joTargets.push({ joNo, joId, joPk: j.SysPK_TransH }); }
        else if (FORCE || !populated.has(joId)) joTargets.push({ joNo, joId, joPk: j.SysPK_TransH });
      }
    } catch (e) { certFail += 1; }
  });
  console.log(`${joTargets.length} JO(s) to fetch${FORCE ? '' : ' (unpopulated)'}; ${certFail} SO cert-list call(s) failed.`);

  if (DRY_RUN) {
    console.log('\nDRY RUN -- would fetch detail + write processes for the above JOs. Nothing written.');
    await pool.end(); return;
  }

  // --- per JO: fetch detail, map LdgrInvty -> job_order_processes ---
  // Live rejects sustained bursts: it either drops the connection (apiRetry throws) OR
  // replies 200 with no data array once the session goes stale after the long cert phase.
  // So: get a FRESH token right before this phase, keep concurrency low with a pacing gap,
  // and treat an empty (non-array) reply as a failure that re-logs in and retries -- never a
  // silent skip. A single sequential fetch is reliable; it's the burst that trips the limiter.
  // Fully sequential with a gap -- this exactly matches the pacing that tested 100% reliable;
  // any burst wider than this trips the live limiter, which then returns 200 with an EMPTY
  // data array (data[0] undefined), NOT a missing key -- so success must require a real header.
  const DETAIL_CONCURRENCY = 1;
  const DETAIL_GAP_MS = 200;
  // A throttled/stale reply is 200 with data[0] = {} (truthy but empty), NOT a missing key --
  // a real JO header carries dozens of fields, so require a substantial object. The retry then
  // paces us out of the throttle window (which clears within seconds once load drops).
  const isRealHeader = (d) => Array.isArray(d?.data) && d.data[0] && Object.keys(d.data[0]).length >= 5;
  await sleep(5000); // cool-down so the cert-phase burst clears before the detail phase starts
  token = await login(); // fresh session for the detail phase
  let sinceRelogin = 0, emptyRetries = 0;
  async function fetchDetail(t) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let detail;
      try { detail = await apiRetry(token, 'get_job_order', { pk: t.joPk }); }
      catch (e) { await sleep(1000 * (attempt + 1)); token = await login(); continue; }
      if (isRealHeader(detail)) return detail;
      // empty/stub header => throttled/stale session; back off, refresh, retry.
      emptyRetries += 1; await sleep(1200 * (attempt + 1)); token = await login();
    }
    return null;
  }
  let processed = 0, linesInserted = 0, detailFail = 0, unresolvedProc = 0, unresolvedItem = 0;
  await mapWithConcurrency(joTargets, DETAIL_CONCURRENCY, async (t) => {
    const detail = await fetchDetail(t);
    await sleep(DETAIL_GAP_MS);
    if (!detail) { detailFail += 1; return; }
    // Periodic token refresh so a long run never drifts into a stale session.
    if ((sinceRelogin += 1) >= 600) { sinceRelogin = 0; token = await login(); }
    const header = Array.isArray(detail?.data) ? detail.data[0] : null;
    const lines = Array.isArray(detail?.data?.[2]) ? detail.data[2] : [];
    const rows = lines.map((L, i) => {
      const procId = procById.get(norm(L.Name_Proc)) ?? null;
      const itemId = invById.get(norm(L.UserPK_Invty)) ?? invById.get(norm(L.SalesDescription_Invty)) ?? null;
      const locId = locById.get(norm(L.Name_Loc)) ?? null;
      if (L.Name_Proc && !procId) unresolvedProc += 1;
      if ((L.UserPK_Invty || L.SalesDescription_Invty) && !itemId) unresolvedItem += 1;
      return [
        t.joId, i + 1, procId, num(L.ProcessQty_LdgrInvty), L.UOM_Proc || null,
        L.Category_LdgrInvty || null, L.Parts_LdgrInvty || null, itemId, locId,
        L.ArtistRemarks_LdgrInvty || null, num(L.Length_LdgrInvty), num(L.Width_LdgrInvty),
        L.UnitOfMeasure_LdgrInvty || null, num(L.Qty_LdgrInvty), num(L.TotalAmountOut_LdgrInvty) ?? num(L.SubTotalAmountOut_LdgrInvty),
        L.Unit_LdgrInvty || null, L.SalesRemarks_LdgrInvty || null, L.Particulars_LdgrInvty || null,
        num(L.ProcessCost_LdgrInvty), num(L.MaterialCost_LdgrInvty),
        (num(L.MaterialTransCost_LdgrInvty) || 0) + (num(L.ProcessTransCost_LdgrInvty) || 0),
        num(L.Cost_LdgrInvty),
        L.ProductionRemarks_LdgrInvty || null,
      ];
    });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Header enrichment: artist, layout job type, job location (kept if unresolved).
      if (header) {
        const layoutJtId = await resolveLayoutJobType(header.DisplayName_JobT);
        await conn.query(
          `UPDATE job_orders SET artist_id = COALESCE(?, artist_id),
             layout_job_type_id = COALESCE(?, layout_job_type_id),
             job_location_id = COALESCE(?, job_location_id) WHERE id = ?`,
          [empById.get(norm(header.artist_name)) ?? null, layoutJtId ?? null,
           locById.get(norm(header.joloc_name)) ?? null, t.joId]);
      }
      // --missing-only is a header backfill: JOs that already have processes keep them as-is.
      // Re-deleting them would trip assembly_build_lines' FK (those rows point at existing
      // process ids). Only (re)write processes for JOs that don't have any yet.
      if (!MISSING_ONLY || !populated.has(t.joId)) {
        await conn.query('DELETE FROM job_order_processes WHERE job_order_id = ?', [t.joId]);
        if (rows.length) {
          await conn.query(
            `INSERT INTO job_order_processes
               (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, location_id,
                artist_remarks, length, width, uom, qty, total, unit, remarks, memo,
                process_cost, material_cost, total_cost, avg_cost, production_remarks)
             VALUES ?`, [rows]);
          linesInserted += rows.length;
        }
      }
      await conn.commit();
      processed += 1;
      if (processed % 200 === 0) console.log(`  ...${processed}/${joTargets.length} JOs (${linesInserted} lines so far)`);
    } catch (e) {
      await conn.rollback(); detailFail += 1;
      if (detailFail <= 5) console.error(`  [tx error] JO ${t.joNo}: ${e.message}`);
    }
    finally { conn.release(); }
  });

  console.log(`\nDone. ${processed} JO(s) processed, ${linesInserted} process line(s) inserted.`);
  console.log(`Detail-fetch failures: ${detailFail} (empty/throttled retries along the way: ${emptyRetries}). Unresolved process names: ${unresolvedProc}, unresolved items: ${unresolvedItem} (left NULL by design).`);
  console.log(`Layout job types created on demand (in pms_job_types): ${layoutCreated}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
