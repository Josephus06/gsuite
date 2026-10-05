// Bring every Process Costing bracket in line with the source's Process Costs
// (http://gsuite.graphicstar.com.ph/#/process-costs) -- asked 2026-10-02: "update all data from
// process costing in the source".
//
// import-all-process-costs.js only ever INSERTED, and skipped any process that already had
// brackets, so T1S kept the 2023 figures and never took Sub Con at all (914 Subcontracting brackets
// had no cost inputs, only a stored price). This UPDATES:
//
//   get_costings {module:'Process'}  every costing (one per process), matched on process_code
//   get_costing {pk}                 its brackets; matched to ours on process + qty range
//
//   source                         -> process_cost_brackets
//   ClickCharge_CstngL               click_charge          InkjetCostCalc_CstngL  ink_cost
//   DL_CstngL                        direct_labor          MOHPE/DC/RM/IMC/IL     moh_*
//   OtherCharges_CostingL            other_charges         SubCon_CstngL          sub_con
//   MarkUpPrcnt_CstngL               markup_sub_con_pct (the Sub Con mark-up)
//   CostingAllowancePrcnt_CstngL     costing_allowance_pct MarkUpCOGSPrcnt_CstngL markup_cogs_pct
//   OPEXAdminPrcnt / OPEXSellingPrcnt opex_admin_pct / opex_selling_pct
//   CostingRef_CstngL                costing_reference     DiscCeilingPer/DCSS/DCSM/DCGM  disc_*_pct
//   SellingPrice_CstngL              NOT copied -- Selling Price is always Total Price rounded up;
//                                    it is only compared, to report where ours and the source's differ
//
// A source bracket T1S lacks is added; a T1S bracket the source lacks is reported, not touched.
// Each changed field is written to the process's System Info ("1-269 · DL (from source)"), and a
// rollback file of every bracket's prior values is written first. Then it checks our formula
// (shared/costing.js) against the source's own SellingPriceUnrounded for every bracket.
//
// READ-ONLY against the source.
//   node src/db/sync-process-costing.js --dry-run
//   node src/db/sync-process-costing.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const L = require('./lib/liveWindow');

const DRY = process.argv.includes('--dry-run');
const CONCURRENCY = 4;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const display = (v) => (v === null || v === undefined ? null : String(Number(v)));
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.00005;

// source field -> our column (numeric unless noted)
const MAP = {
  click_charge: 'ClickCharge_CstngL', ink_cost: 'InkjetCostCalc_CstngL', direct_labor: 'DL_CstngL',
  moh_power_equipment: 'MOHPE_CstngL', moh_depreciation: 'MOHDC_CstngL', moh_repairs_maintenance: 'MOHRM_CstngL',
  moh_indirect_materials: 'MOHIMC_CstngL', moh_indirect_labor: 'MOHIL_CstngL', other_charges: 'OtherCharges_CostingL',
  sub_con: 'SubCon_CstngL', markup_sub_con_pct: 'MarkUpPrcnt_CstngL',
  costing_allowance_pct: 'CostingAllowancePrcnt_CstngL', markup_cogs_pct: 'MarkUpCOGSPrcnt_CstngL',
  opex_admin_pct: 'OPEXAdminPrcnt_CstngL', opex_selling_pct: 'OPEXSellingPrcnt_CstngL',
  markup_opex_admin_pct: 'MarkUpOPEXAdminPrcnt_CstngL', markup_opex_selling_pct: 'MarkUpOPEXSellingPrcnt_CstngL',
  disc_ceiling_pct: 'DiscCeilingPer_CstngL', disc_supervisor_pct: 'DCSSPercent_CstngL',
  disc_manager_pct: 'DCSMPercent_CstngL', disc_gm_pct: 'DCGMPercent_CstngL',
  // Selling Price is not copied: it is always Total Price rounded up (shared/costing.js).
};
const LABELS = {
  click_charge: 'Click Charge', ink_cost: 'INK', direct_labor: 'DL', moh_power_equipment: 'MOH (P/E)',
  moh_depreciation: 'MOH (DC)', moh_repairs_maintenance: 'MOH (R&M)', moh_indirect_materials: 'MOH (IM&C)',
  moh_indirect_labor: 'MOH (IL)', other_charges: 'Other Charges', sub_con: 'Sub Con', markup_sub_con_pct: 'Mark-Up Sub Con %',
  costing_allowance_pct: 'Costing Allowance %', markup_cogs_pct: 'Mark-Up (COGS) %', opex_admin_pct: 'OPEX (Admin) %',
  opex_selling_pct: 'OPEX (Selling) %', markup_opex_admin_pct: 'Mark-Up OPEX (Admin) %', markup_opex_selling_pct: 'Mark-Up OPEX (Selling) %',
  disc_ceiling_pct: 'DC Account Officer %', disc_supervisor_pct: 'DC Sales Supervisor %',
  disc_manager_pct: 'DC Sales Manager %', disc_gm_pct: 'DC General Manager %', selling_price_override: 'Selling Price (source)',
  costing_reference: 'Costing Reference',
};
const COLS = [...Object.keys(MAP), 'costing_reference'];
// Source brackets whose Range is not "min-max" -- typed in wrong on the source, so the parser
// below skipped them and the process was left with no price in T1S (found 2026-10-05: Wall Mural
// Installation SqFt 151-200 had a bracket on the source, none here). Each is mapped to what its
// siblings show it meant. Any other unreadable range is reported, never silently skipped.
const RANGE_FIXES = {
  'SUBCON-WALLMURAL-INST-SQFT-151-200|0': { min: 151, max: 200 }, // its siblings are 101-150, 201-250
  'SUBCON-INSTL-BLDUP-LGHTD-HIGH|.00 1-50': { min: 0.001, max: 50 }, // the tier before its 51-60
  'SUBCON-STKR-INST-LOWEL-SQFT-601-900|.00.1-1000000': { min: 0.001, max: 1000000 }, // as its 301-600 sibling
  'DPOD-SUBCON|': { min: 0.001, max: 1000000 }, // no range at all: its one bracket covers any quantity
};
const range = (s, code) => {
  const fix = RANGE_FIXES[`${code}|${String(s ?? '').trim()}`];
  if (fix) return fix;
  const [a, b] = String(s || '').trim().split('-'); return { min: Number(a), max: Number(b) };
};
// --add-only: insert the brackets T1S lacks and change nothing else. The full sync also rewrites
// existing brackets, DL among them -- which takes off the +8% T1S adds (adjust-process-costing-dl.js).
const ADD_ONLY = process.argv.includes('--add-only');
const bracketName = (r) => `${display(r.qty_min) ?? '?'}-${display(r.qty_max) ?? '?'}`;

async function main() {
  const { computeProcessCosting } = await import(`file://${path.resolve(__dirname, '../../../shared/costing.js').replace(/\\/g, '/')}`);
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[admin]] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
  const [procs] = await pool.query('SELECT id, process_code FROM processes');
  const procByCode = new Map(procs.map((p) => [p.process_code, p.id]));
  const [ours] = await pool.query('SELECT * FROM process_cost_brackets');
  const oursByProc = new Map();
  for (const b of ours) { if (!oursByProc.has(b.process_id)) oursByProc.set(b.process_id, []); oursByProc.get(b.process_id).push(b); }

  const t = await L.login();
  const stubs = [];
  for (let off = 0; ; off += 200) {
    const [batch] = (await L.api(t, 'get_costings', { module: 'Process', limit: 200, offset: off }))?.data || [[]];
    if (!batch?.length) break;
    stubs.push(...batch); if (batch.length < 200) break;
  }
  console.log(`source costings: ${stubs.length}; T1S brackets: ${ours.length} on ${oursByProc.size} process(es)`);

  const out = { noProcess: [], badRange: [], updated: 0, fieldsChanged: 0, added: 0, onlyInT1S: 0, failed: [], unknownKeys: new Map(),
    byField: {}, priceCheck: { ok: 0, off: [], pesoOk: 0, pesoOff: [] } };
  const updates = []; const inserts = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < stubs.length) {
      const stub = stubs[cursor]; cursor += 1;
      const processId = procByCode.get(stub.UserPK_Proc);
      if (!processId) { out.noProcess.push(stub.UserPK_Proc); continue; }
      let detail;
      try { detail = await L.api(t, 'get_costing', { pk: stub.SysPK_Cstng }); } catch (e) { out.failed.push(`${stub.UserPK_Proc}: ${e.message}`); continue; }
      const src = detail?.data?.[1] || [];
      const mine = [...(oursByProc.get(processId) || [])];
      for (const b of src) {
        // Any non-zero source field we do not carry -- reported, so nothing is dropped unnoticed.
        for (const [k, v] of Object.entries(b)) {
          if (!/_Cstng(L)?$|_CostingL$/.test(k) || /^Sys|Description|Range|Unrounded|Amount|SubTotal|Total|MarkUpCOGS_|MarkUp_|OPEXAdmin_|OPEXSelling_|CostingAllowance_|DiscCeiling_/.test(k)) continue;
          if (num(v) && !Object.values(MAP).includes(k) && k !== 'CostingRef_CstngL') out.unknownKeys.set(k, (out.unknownKeys.get(k) || 0) + 1);
        }
        const { min, max } = range(b.Range_CstngL, stub.UserPK_Proc);
        if (!Number.isFinite(min) || !Number.isFinite(max)) { out.badRange.push(`${stub.UserPK_Proc} ${JSON.stringify(b.Range_CstngL)}`); continue; }
        const want = Object.fromEntries(Object.entries(MAP).map(([col, k]) => [col, b[k] == null || b[k] === '' ? (col === 'selling_price_override' ? null : 0) : num(b[k])]));
        want.costing_reference = b.CostingRef_CstngL == null ? null : String(Number(b.CostingRef_CstngL));
        // Our formula against the source's own unrounded price, on the source's inputs.
        const calc = computeProcessCosting({ ...want, selling_price_override: null }).priceUnrounded;
        if (b.SellingPriceUnrounded_CstngL != null && Math.abs(calc - num(b.SellingPriceUnrounded_CstngL)) > 0.01) {
          out.priceCheck.off.push(`${stub.UserPK_Proc} ${b.Range_CstngL}: ours ${calc.toFixed(4)} vs source ${num(b.SellingPriceUnrounded_CstngL)}`);
          if (process.env.SHOW_OFF && out.priceCheck.off.length <= Number(process.env.SHOW_OFF)) console.log('OFF', JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k, v]) => /_Cstng(L)?$|_CostingL$/.test(k) && v !== null && v !== '' && num(v) !== 0 && !/^Sys|Description/.test(k)))));
        } else out.priceCheck.ok += 1;
        // What a customer sees: our Selling Price (Total Price rounded up) vs the source's.
        if (b.SellingPrice_CstngL != null) {
          const ourPrice = Math.ceil(Number(calc.toFixed(6)));
          if (Math.abs(ourPrice - num(b.SellingPrice_CstngL)) >= 0.5) {
            out.priceCheck.pesoOff.push({ code: stub.UserPK_Proc, range: b.Range_CstngL, ours: ourPrice, source: num(b.SellingPrice_CstngL), other: num(b.OtherCharges_CostingL) });
          } else out.priceCheck.pesoOk += 1;
        }
        const idx = mine.findIndex((m) => same(m.qty_min, min) && same(m.qty_max, max));
        if (idx < 0) { inserts.push({ process_id: processId, qty_min: min, qty_max: max, ...want }); continue; }
        const cur = mine.splice(idx, 1)[0];
        const changes = COLS.filter((c) => (c === 'costing_reference' || c === 'selling_price_override')
          ? String(cur[c] == null ? '' : Number(cur[c])) !== String(want[c] == null ? '' : Number(want[c]))
          : !same(cur[c], want[c]));
        if (changes.length) updates.push({ cur, want, changes });
      }
      out.onlyInT1S += mine.length;
    }
  }));

  for (const u of updates) for (const c of u.changes) out.byField[c] = (out.byField[c] || 0) + 1;
  // How DL moves: source / ours. ~1.0 = rounding only; ~0.926 = the source lacks the +8% T1S has.
  const dl = updates.filter((u) => u.changes.includes('direct_labor') && num(u.cur.direct_labor));
  if (dl.length) {
    const buckets = {};
    for (const u of dl) {
      const r = num(u.want.direct_labor) / num(u.cur.direct_labor);
      const k = Math.abs(r - 1) < 0.001 ? 'same (rounding)' : Math.abs(r - 1 / 1.08) < 0.002 ? 'source = ours / 1.08 (no +8% there)' : Math.abs(r - 1.08) < 0.002 ? 'source = ours x 1.08' : 'other';
      buckets[k] = (buckets[k] || 0) + 1;
    }
    console.log(`DL changes by kind: ${JSON.stringify(buckets)}`);
    for (const u of dl.filter((x) => Math.abs(num(x.want.direct_labor) / num(x.cur.direct_labor) - 1) >= 0.001).slice(0, 6)) {
      console.log(`   process ${u.cur.process_id} ${bracketName(u.cur)}: T1S ${display(u.cur.direct_labor)} -> source ${display(u.want.direct_labor)}`);
    }
  }
  console.log(`brackets to update: ${updates.length} (${updates.reduce((s, u) => s + u.changes.length, 0)} field changes); to add: ${inserts.length}; in T1S only: ${out.onlyInT1S}`);
  console.log(`changes by field: ${JSON.stringify(out.byField)}`);
  console.log(`no T1S process for: ${out.noProcess.length}${out.noProcess.length ? ` e.g. ${out.noProcess.slice(0, 5).join(', ')}` : ''}; failed: ${out.failed.length}`);
  if (out.unknownKeys.size) console.log(`source fields not carried (non-zero): ${JSON.stringify(Object.fromEntries(out.unknownKeys))}`);
  console.log(`formula check vs source's unrounded price: ${out.priceCheck.ok} match, ${out.priceCheck.off.length} differ${out.priceCheck.off.length ? ` e.g. ${out.priceCheck.off.slice(0, 5).join(' | ')}` : ''}`);
  const po = out.priceCheck.pesoOff;
  const withOther = po.filter((x) => x.other).length;
  console.log(`selling price in pesos (ours = Total Price rounded up) vs source: ${out.priceCheck.pesoOk} same, ${po.length} differ`
    + ` (${withOther} of them carry Other Charges, which our SubTotal leaves out by the workbook's rule)`);
  for (const x of po.filter((y) => !y.other).slice(0, 8)) console.log(`   ${x.code} ${x.range}: ours ${x.ours} vs source ${x.source}`);
  console.log(`unreadable source ranges (skipped): ${out.badRange.length}${out.badRange.length ? ` -- ${out.badRange.join(', ')}` : ''}`);
  for (const r of inserts) console.log(`   add: process ${r.process_id} ${bracketName(r)} sub_con ${display(r.sub_con)} DL ${display(r.direct_labor)}`);
  if (ADD_ONLY) { updates.length = 0; console.log('--add-only: existing brackets left as they are.'); }
  if (DRY) { await pool.end(); return; }

  // Dated per run, so a later run never overwrites an earlier run's rollback.
  if (updates.length) {
    const name = `process-costing-before-sync-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const file = process.platform === 'win32' ? name : `/root/${name}`;
    fs.writeFileSync(file, JSON.stringify(updates.map((u) => u.cur)));
    console.log(`Rollback file (prior values of every updated bracket): ${file}`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const u of updates) {
      await conn.query(`UPDATE process_cost_brackets SET ${u.changes.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
        [...u.changes.map((c) => u.want[c]), u.cur.id]);
      for (const c of u.changes) {
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('ProcessCosting', ?, 'Updated', ?, ?, ?, ?)`,
          [u.cur.process_id, `${bracketName(u.cur)} · ${LABELS[c] || c} (from source)`.slice(0, 150),
            u.cur[c] == null ? null : display(u.cur[c]), u.want[c] == null ? null : display(u.want[c]), admin.id]);
      }
    }
    for (const r of inserts) {
      await conn.query(`INSERT INTO process_cost_brackets (process_id, qty_min, qty_max, ${COLS.join(', ')}) VALUES (?, ?, ?, ${COLS.map(() => '?').join(', ')})`,
        [r.process_id, r.qty_min, r.qty_max, ...COLS.map((c) => r[c])]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, set_by_user_id)
         VALUES ('ProcessCosting', ?, 'Created', ?, ?)`, [r.process_id, `Bracket ${bracketName(r)} (from source)`, admin.id]);
    }
    await conn.commit();
    console.log(`Updated ${updates.length} bracket(s), added ${inserts.length}.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
}
main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
