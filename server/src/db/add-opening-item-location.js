// opening_ar_items / opening_ap_items get the office location each open document belongs to, so
// AR / AP Aging can be narrowed to a location. Without it a report filtered to Head Office (or any
// location) showed nothing at all up to the cut-over -- the opening items ARE the whole of AR and
// AP there, and they carried no location (lib/openingBalances.js openingItems).
//
//   AR  from the source's own aging snapshot: every detail line names its location (Name_Loc).
//       Pass each snapshot the items were loaded from:  --snapshot=2026-09-30:/root/.../ar.json
//   AP  the source's AP aging carries no location, so it is taken from the linked vendor bill where
//       there is one; the rest stay without a location (they show under "No Location").
//
// Idempotent: adds the columns if missing, fills only items still without a location.
//   node src/db/add-opening-item-location.js --snapshot=2026-09-30:<ar.json> --snapshot=2025-12-31:<ar.json> --dry-run
//   node src/db/add-opening-item-location.js --ap-default="Head Office" --dry-run    (AP only)
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');
const SNAPS = process.argv.filter((a) => a.startsWith('--snapshot=')).map((a) => {
  const v = a.split('=').slice(1).join('='); const i = v.indexOf(':');
  return { asOf: v.slice(0, i), file: v.slice(i + 1) };
});
// "Branch - SM\r\n" vs "Branch - SM", "Branch IT Park" vs "Branch - IT Park": letters and digits only.
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const t of ['opening_ar_items', 'opening_ap_items']) {
    const [c] = await pool.query(`SHOW COLUMNS FROM ${t} LIKE 'location_id'`);
    if (c.length) console.log(`${t}.location_id already present.`);
    else if (DRY) console.log(`${t}.location_id would be added.`);
    else { await pool.query(`ALTER TABLE ${t} ADD COLUMN location_id BIGINT NULL AFTER customer_name`.replace('customer_name', t === 'opening_ar_items' ? 'customer_name' : 'supplier_name')); console.log(`Added ${t}.location_id.`); }
  }
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locBy = new Map(locs.map((l) => [squash(l.location_name), l.id]));

  // AR, from each snapshot: (customer pk | document no) -> location, then document no alone.
  for (const s of SNAPS) {
    const snap = JSON.parse(fs.readFileSync(s.file, 'utf8'));
    const byKey = new Map(); const byDoc = new Map(); const unknown = new Set();
    for (const r of snap.rows) for (const d of r.details || []) {
      const id = locBy.get(squash(d.Name_Loc));
      if (d.Name_Loc && !id) unknown.add(String(d.Name_Loc).trim());
      if (!id) continue;
      byKey.set(`${r.SysPK_Cust}|${String(d.UserPK_TransH || '').trim()}`, id);
      if (!byDoc.has(String(d.UserPK_TransH || '').trim())) byDoc.set(String(d.UserPK_TransH || '').trim(), id);
    }
    const [items] = DRY
      ? await pool.query('SELECT id, source_customer_pk, doc_no FROM opening_ar_items WHERE as_of = ?', [s.asOf])
      : await pool.query('SELECT id, source_customer_pk, doc_no FROM opening_ar_items WHERE as_of = ? AND location_id IS NULL', [s.asOf]);
    let set = 0; const by = {};
    for (const i of items) {
      const id = byKey.get(`${i.source_customer_pk}|${i.doc_no}`) || byDoc.get(i.doc_no);
      if (!id) continue;
      set += 1; by[id] = (by[id] || 0) + 1;
      if (!DRY) await pool.query('UPDATE opening_ar_items SET location_id = ? WHERE id = ?', [id, i.id]);
    }
    const name = new Map(locs.map((l) => [l.id, l.location_name]));
    console.log(`AR ${s.asOf}: ${set}/${items.length} item(s) given a location ${JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [name.get(Number(k)), v])))}${unknown.size ? `; unmatched location names: ${[...unknown].join(', ')}` : ''}`);
  }

  // AP, from the linked bill; a Bill Credit from the credit of the same number (2026-11-26); and,
  // with --ap-default=<location name>, whatever has no document to take one from (source journals,
  // bills never migrated) -- in this database 99.9% of vendor bills are Head Office's.
  const apDefaultName = (process.argv.find((a) => a.startsWith('--ap-default=')) || '').split('=').slice(1).join('=');
  const apDefault = apDefaultName ? locBy.get(squash(apDefaultName)) : null;
  if (apDefaultName && !apDefault) throw new Error(`--ap-default: no location named "${apDefaultName}"`);
  const steps = [
    ['their bill\'s location',
      `SELECT COUNT(*) n FROM opening_ap_items o JOIN vendor_bills vb ON vb.id = o.vendor_bill_id WHERE o.location_id IS NULL AND vb.office_location_id IS NOT NULL`,
      `UPDATE opening_ap_items o JOIN vendor_bills vb ON vb.id = o.vendor_bill_id
          SET o.location_id = vb.office_location_id
        WHERE o.location_id IS NULL AND vb.office_location_id IS NOT NULL`, []],
    ['their bill credit\'s location',
      `SELECT COUNT(*) n FROM opening_ap_items o JOIN bill_credits bc ON bc.bill_credit_no = o.doc_no COLLATE utf8mb4_unicode_ci WHERE o.doc_type = 'Bill Credit' AND o.location_id IS NULL AND bc.office_location_id IS NOT NULL`,
      `UPDATE opening_ap_items o JOIN bill_credits bc ON bc.bill_credit_no = o.doc_no COLLATE utf8mb4_unicode_ci
          SET o.location_id = bc.office_location_id
        WHERE o.doc_type = 'Bill Credit' AND o.location_id IS NULL AND bc.office_location_id IS NOT NULL`, []],
  ];
  if (apDefault) {
    steps.push([`the default location (${apDefaultName})`,
      'SELECT COUNT(*) n FROM opening_ap_items WHERE location_id IS NULL',
      'UPDATE opening_ap_items SET location_id = ? WHERE location_id IS NULL', [apDefault]]);
  }
  // A dry run counts each step as if the ones before it had not run, so its counts can overlap.
  for (const [label, countSql, updateSql, params] of steps) {
    if (DRY) { const [[r]] = await pool.query(countSql); console.log(`AP: ${r.n} item(s) would take ${label}.`); }
    else { const [r] = await pool.query(updateSql, params); console.log(`AP: ${r.affectedRows} item(s) given ${label}.`); }
  }
  const [left] = await pool.query("SELECT DATE_FORMAT(as_of, '%Y-%m-%d') AS as_of, doc_type, COUNT(*) n, ROUND(SUM(balance), 2) b FROM opening_ap_items WHERE location_id IS NULL GROUP BY as_of, doc_type");
  if (left.length) console.log('AP items still without a location (No Location):', left.map((r) => `${r.as_of} ${r.doc_type} ${r.n} (${r.b})`).join('; '));
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
