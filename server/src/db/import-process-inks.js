// Process Materials / Ink tabs and the Ink Calculation (asked 2026-11-04), brought over from the source's
// process set-up (process_crud / process_view):
//
//   processes          + the Ink Calculation inputs: media usage, media weight without / with print,
//                        weight of ink full / empty container, ink volume -- and the two results the
//                        source stores, ink cost per sqft (actual and costing), kept up to date on save.
//   process_items      the Materials tab and the Ink tab rows (module 'Material' / 'Ink'): the inventory
//                      item, and for an ink its Ink Price and Volume (ml) -- one container's. The source
//                      has one volume for all its inks (InkVolume_Proc); T1S keeps one per ink, as
//                      Costing's INK COST workbook does (a 600 ml White among 700 ml cartridges).
// The formulas: lib/processInk.js.
//
// Adds what is missing, then copies from the source: get_processes (the Ink Calculation fields) and
// get_process_materials (the rows; their item through get_inventories, matched on item_code =
// UserPK_Invty). Processes are matched on process_code = UserPK_Proc -- run import-missing-processes.js
// first so new source processes exist. A process whose rows were changed in T1S since (any row
// without a source key) is left alone; otherwise its source rows are replaced, so it is safe to re-run.
// READ-ONLY against the source.
//   node src/db/import-process-inks.js --dry-run
//   node src/db/import-process-inks.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const clean = (s) => (s || '').toString().trim();
const num = (v) => (v == null || v === '' ? null : Number(v));

const INK_COLS = [
  ['ink_media_usage', 'MediaUsage_Proc'],
  ['ink_media_weight_wo_print', 'MediaWeightWOPrint_Proc'],
  ['ink_media_weight_w_print', 'MediaWeightWprint_Proc'],
  ['ink_weight_full', 'WeightOfInkFull_Proc'],
  ['ink_weight_empty', 'WeightOfInkEmpty_Proc'],
  ['ink_volume', 'InkVolume_Proc'],
  // The COSTING PRICE column (the INK COST workbook's MANUAL figures).
  ['ink_usage_costing', 'InkUsageCosting_Proc'],
  ['ink_price_per_ml_costing', 'InkPricePerSQFTCosting_Proc'],
  // The results, as the source last worked them out.
  ['ink_cost_per_sqft', 'InkCostPerSQFT_Proc'],
  ['ink_cost_per_sqft_costing', 'InkCostPerSQFTCosting_Proc'],
];

async function ensureSchema() {
  const [cols] = await pool.query('SHOW COLUMNS FROM processes');
  const have = new Set(cols.map((c) => c.Field));
  const add = INK_COLS.map(([c]) => c).filter((c) => !have.has(c));
  if (add.length) {
    if (DRY_RUN) console.log(`would add processes.${add.join(', ')}`);
    else {
      await pool.query(`ALTER TABLE processes ${add.map((c) => `ADD COLUMN ${c} DECIMAL(16,4) NULL`).join(', ')}`);
      console.log(`Added processes.${add.join(', ')}`);
    }
  }
  const [t] = await pool.query("SHOW TABLES LIKE 'process_items'");
  if (!t.length) {
    if (DRY_RUN) { console.log('would create process_items'); return false; }
    await pool.query(`CREATE TABLE process_items (
        id BIGINT NOT NULL AUTO_INCREMENT,
        process_id BIGINT NOT NULL,
        module VARCHAR(10) NOT NULL,
        seq INT NOT NULL DEFAULT 0,
        inventory_id BIGINT NOT NULL,
        ink_price DECIMAL(16,4) NULL,
        volume_ml DECIMAL(16,4) NULL,
        live_pk CHAR(36) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_process_items_live (live_pk),
        KEY idx_process_items (process_id, module, seq),
        CONSTRAINT fk_process_items_process FOREIGN KEY (process_id) REFERENCES processes (id) ON DELETE CASCADE,
        CONSTRAINT fk_process_items_inventory FOREIGN KEY (inventory_id) REFERENCES inventories (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('Created process_items');
  } else {
    const [v] = await pool.query("SHOW COLUMNS FROM process_items LIKE 'volume_ml'");
    if (!v.length) {
      if (DRY_RUN) console.log('would add process_items.volume_ml');
      else { await pool.query('ALTER TABLE process_items ADD COLUMN volume_ml DECIMAL(16,4) NULL AFTER ink_price'); console.log('Added process_items.volume_ml'); }
    }
  }
  return !add.length || !DRY_RUN;
}

async function main() {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const schemaReady = await ensureSchema();
  const t = await L.login();

  const live = [];
  for (let off = 0; ; off += 500) {
    const page = L.listRows(await L.api(t, 'get_processes', { order: [['Name_Proc', 'ASC']], limit: 500, offset: off }));
    live.push(...page);
    if (page.length < 500) break;
  }
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const page = L.listRows(await L.api(t, 'get_process_materials', { where: {}, limit: 1000, offset: off }));
    rows.push(...page);
    if (page.length < 1000) break;
  }
  console.log(`source: ${live.length} processes, ${rows.length} material / ink rows`);

  const [local] = await pool.query('SELECT id, process_code FROM processes');
  const procByCode = new Map(local.map((p) => [clean(p.process_code).toLowerCase(), p.id]));
  const liveByPk = new Map(live.map((p) => [p.SysPK_Proc, p]));
  const localOf = (p) => (p ? procByCode.get(clean(p.UserPK_Proc).toLowerCase()) : null);

  // 1. The Ink Calculation, for every source process that has one.
  const withInk = live.filter((p) => INK_COLS.some(([, s]) => Number(p[s])));
  let inkSet = 0;
  const missingProc = new Set();
  for (const p of withInk) {
    const id = localOf(p);
    if (!id) { missingProc.add(clean(p.UserPK_Proc)); continue; }
    inkSet += 1;
    if (!DRY_RUN && schemaReady) {
      await pool.query(`UPDATE processes SET ${INK_COLS.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...INK_COLS.map(([, s]) => num(p[s])), id]);
    }
  }
  console.log(`ink calculation: ${inkSet} process(es)${DRY_RUN ? ' would be' : ''} set`);

  // 2. The rows. Items by source key -> local item_code.
  const invPks = [...new Set(rows.map((r) => r.SysFK_Invty_PMat).filter(Boolean))];
  const [items] = await pool.query('SELECT id, item_code FROM inventories');
  const itemByCode = new Map(items.map((i) => [clean(i.item_code).toLowerCase(), i.id]));
  const itemOf = new Map();
  const missingItem = new Set();
  for (const pk of invPks) {
    const inv = L.listRows(await L.api(t, 'get_inventories', { where: { SysPK_Invty: pk }, limit: 1, offset: 0 }))[0];
    const id = inv ? itemByCode.get(clean(inv.UserPK_Invty).toLowerCase()) : null;
    if (id) itemOf.set(pk, id); else missingItem.add(inv ? clean(inv.UserPK_Invty) : pk);
  }

  const byProc = new Map();
  for (const r of rows) {
    if (!byProc.has(r.SysFK_Proc_PMat)) byProc.set(r.SysFK_Proc_PMat, []);
    byProc.get(r.SysFK_Proc_PMat).push(r);
  }
  let procsDone = 0; let rowsDone = 0; let kept = 0;
  for (const [procPk, list] of byProc) {
    const p = liveByPk.get(procPk);
    const id = localOf(p);
    if (!id) { missingProc.add(p ? clean(p.UserPK_Proc) : procPk); continue; }
    if (schemaReady) {
      const [[edited]] = await pool.query('SELECT COUNT(*) AS n FROM process_items WHERE process_id = ? AND live_pk IS NULL', [id]).catch(() => [[{ n: 0 }]]);
      if (edited.n) { kept += 1; console.log(`  kept ${clean(p.UserPK_Proc)}: changed in T1S`); continue; }
    }
    const good = list.filter((r) => itemOf.has(r.SysFK_Invty_PMat));
    procsDone += 1; rowsDone += good.length;
    console.log(`  ${clean(p.UserPK_Proc)}: ${good.filter((r) => r.Module_PMat === 'Ink').length} ink, ${good.filter((r) => r.Module_PMat !== 'Ink').length} material${good.length < list.length ? ` (${list.length - good.length} item(s) not in T1S)` : ''}`);
    if (DRY_RUN || !schemaReady) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM process_items WHERE process_id = ?', [id]);
      // Source order: Seq_PMat where it has one, else as listed.
      const ordered = good.map((r, i) => ({ r, i })).sort((a, b) => (Number(a.r.Seq_PMat ?? a.i) - Number(b.r.Seq_PMat ?? b.i)) || a.i - b.i);
      let seq = 0;
      for (const { r } of ordered) {
        seq += 1;
        await conn.query(
          'INSERT INTO process_items (process_id, module, seq, inventory_id, ink_price, volume_ml, live_pk) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, r.Module_PMat === 'Ink' ? 'Ink' : 'Material', seq, itemOf.get(r.SysFK_Invty_PMat),
            r.Module_PMat === 'Ink' ? num(r.Price_PMat) : null, r.Module_PMat === 'Ink' ? num(p.InkVolume_Proc) : null, r.SysPK_PMat]);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log(`rows: ${procsDone} process(es), ${rowsDone} row(s)${DRY_RUN ? ' would be' : ''} copied; ${kept} kept (edited in T1S)`);
  if (missingProc.size) console.log(`processes not in T1S (run import-missing-processes.js): ${[...missingProc].join(', ')}`);
  if (missingItem.size) console.log(`items not in T1S (rows skipped): ${[...missingItem].join(', ')}`);
  await pool.end();
}

main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
