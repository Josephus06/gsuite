// Sales Orders' Office Location from the source (2026-10-09). import-sales.js gave every migrated
// order Head Office; the source's own office is LocationName_TransH. JO-63913-1-1 read Head Office
// where the source says Branch - Ayala (SO-63913). A JO shows its order's office, so fixing the
// order fixes its JOs.
//
// Only changes an order still on the import's default (Head Office, or none) whose source office
// differs; one set to something else in T1S is left as it is. The location is matched by name.
// READ-ONLY against the source (get_transactions, Module SALESORDER, paged).
//   node src/db/backfill-so-office-location.js --dry-run
//   node src/db/backfill-so-office-location.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l]));
  const [sos] = await pool.query(
    'SELECT so.id, so.sales_order_no, so.office_location_id, l.location_name FROM sales_orders so LEFT JOIN locations l ON l.id = so.office_location_id');
  const local = new Map(sos.map((s) => [norm(s.sales_order_no), s]));

  const t = await L.login();
  const changes = []; const unknownLoc = new Map(); let seen = 0; let notInT1s = 0; let noLoc = 0; let keptT1s = 0;
  for (let off = 0; ; off += 500) {
    const rows = L.listRows(await L.api(t, 'get_transactions', { where: { Module_TransH: 'SALESORDER' }, order: [['ID_TransH', 'ASC']], limit: 500, offset: off }));
    for (const r of rows) {
      seen += 1;
      const mine = local.get(norm(r.UserPK_TransH));
      if (!mine) { notInT1s += 1; continue; }
      if (!r.LocationName_TransH) { noLoc += 1; continue; }
      const loc = locByName.get(norm(r.LocationName_TransH));
      if (!loc) { unknownLoc.set(r.LocationName_TransH, (unknownLoc.get(r.LocationName_TransH) || 0) + 1); continue; }
      const onDefault = !mine.office_location_id || norm(mine.location_name).startsWith('head office');
      if (!onDefault && Number(mine.office_location_id) !== Number(loc.id)) { keptT1s += 1; continue; }
      if (Number(mine.office_location_id) !== Number(loc.id)) changes.push({ id: mine.id, no: mine.sales_order_no, from: mine.location_name, to: loc.location_name, toId: loc.id });
    }
    if (rows.length < 500) break;
  }
  console.log(`source SOs ${seen} | T1S SOs ${sos.length} | to change ${changes.length} | source has none ${noLoc} | not in T1S ${notInT1s} | set otherwise in T1S, kept ${keptT1s}`);
  if (unknownLoc.size) console.log('  source offices with no T1S location:', [...unknownLoc].map(([k, v]) => `${k} (${v})`).join(', '));
  const tally = {};
  changes.forEach((c) => { const k = `${c.from || '(none)'} -> ${c.to}`; tally[k] = (tally[k] || 0) + 1; });
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  const s = changes.find((c) => c.no === 'SO-63913');
  if (s) console.log(`  SO-63913: ${s.from} -> ${s.to}`);

  if (!DRY_RUN && changes.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const c of changes) await conn.query('UPDATE sales_orders SET office_location_id = ? WHERE id = ?', [c.toId, c.id]);
      await conn.commit();
      console.log(`Updated ${changes.length} sales order(s).`);
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  await pool.end();
}
main().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
