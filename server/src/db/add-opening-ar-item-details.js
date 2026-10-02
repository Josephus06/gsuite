// The AR opening items (opening_ar_items, the source's open documents at the cut-over) carry the
// document's own details, so AR Aging Details reads as the source's does: memo, PO #, BS #, office
// location and sales rep. The loader kept only numbers and amounts, so every credit memo and payment
// from before the cut-over said "Opening balance from the source system" with no PO # or location
// (CM-1170 is "EWT 2020-2021" at the source, INV-36582's PO # CW-11651586).
//
// 1. Adds the columns if missing (memo, po_no, bs_no, src_location, sales_rep) -- the report works
//    without them and simply falls back, so code and columns can go in either order.
// 2. Fills them from the source's own AR Aging Details (generate_ar_aging_detail, one call per
//    customer, as of the items' own date), matched by the source document id (source_doc_pk).
//    Fill-only: a value already there is kept.
//
//   node src/db/add-opening-ar-item-details.js            # adds columns, dry-run fill
//   node src/db/add-opening-ar-item-details.js --apply
const pool = require('../db');
require('dotenv').config();
const { sourceLogin, SITE, pool4 } = require('../lib/sourceLedger');

const APPLY = process.argv.includes('--apply');
const COLUMNS = [['memo', 'VARCHAR(1000) NULL'], ['po_no', 'VARCHAR(150) NULL'], ['bs_no', 'VARCHAR(100) NULL'],
  ['src_location', 'VARCHAR(150) NULL'], ['sales_rep', 'VARCHAR(150) NULL']];
const clean = (v, n) => { const t = (v == null ? '' : String(v)).trim(); return t ? t.slice(0, n) : null; };

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN (columns are still added)'}`);
  const [have] = await pool.query("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'opening_ar_items'");
  const existing = new Set(have.map((r) => r.c));
  for (const [col, type] of COLUMNS) {
    if (existing.has(col)) continue;
    await pool.query(`ALTER TABLE opening_ar_items ADD COLUMN ${col} ${type}`);
    console.log(`  added opening_ar_items.${col}`);
  }

  const [pairs] = await pool.query(
    `SELECT DATE_FORMAT(as_of, '%Y-%m-%d') AS as_of, source_customer_pk, COUNT(*) AS n
       FROM opening_ar_items WHERE source_customer_pk IS NOT NULL AND source_doc_pk IS NOT NULL
      GROUP BY as_of, source_customer_pk`);
  console.log(`Customers to read from the source: ${pairs.length} (${pairs.reduce((s, p) => s + Number(p.n), 0)} items)`);

  const token = await sourceLogin();
  const byDoc = new Map(); let failed = 0; let done = 0;
  await pool4(pairs, async (p) => {
    try {
      const r = await fetch(`${SITE}/api/generate_ar_aging_detail`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify([null, p.source_customer_pk, p.as_of, false, null]), signal: AbortSignal.timeout(180000),
      });
      const j = await r.json();
      for (const c of (Array.isArray(j?.data) ? j.data : [])) {
        for (const d of c.details || []) {
          byDoc.set(`${p.as_of}|${d.SysPK_TransH}`, {
            memo: clean(d.Memo_TransH, 1000), po_no: clean(d.PONo_TransH, 150), bs_no: clean(d.ReferrenceNO_TransH, 100),
            src_location: clean(d.Name_Loc, 150), sales_rep: clean(d.Name_Empl, 150),
          });
        }
      }
    } catch (e) { failed += 1; }
    done += 1;
    if (done % 50 === 0) process.stdout.write(`\r  ${done}/${pairs.length} customers read`);
  });
  console.log(`\nSource documents read: ${byDoc.size}${failed ? `; customers that failed to read: ${failed} (re-run to retry)` : ''}`);

  const [items] = await pool.query(
    `SELECT id, DATE_FORMAT(as_of, '%Y-%m-%d') AS as_of, source_doc_pk, doc_no, memo, po_no, bs_no, src_location, sales_rep
       FROM opening_ar_items WHERE source_doc_pk IS NOT NULL`);
  const updates = []; const counts = Object.fromEntries(COLUMNS.map(([c]) => [c, 0])); let unmatched = 0;
  for (const it of items) {
    const src = byDoc.get(`${it.as_of}|${it.source_doc_pk}`);
    if (!src) { unmatched += 1; continue; }
    const set = {};
    for (const [col] of COLUMNS) if (!it[col] && src[col]) { set[col] = src[col]; counts[col] += 1; }
    if (Object.keys(set).length) updates.push({ id: it.id, doc_no: it.doc_no, set });
  }
  console.log(`Items: ${items.length}; matched to a source document: ${items.length - unmatched}; to fill: ${updates.length}`);
  console.log('Fields to fill:', counts);
  for (const u of updates.slice(0, 6)) console.log(`  ${u.doc_no}: ${JSON.stringify(u.set)}`);
  if (!APPLY) return;
  let n = 0;
  for (const u of updates) {
    const keys = Object.keys(u.set);
    const [r] = await pool.query(
      `UPDATE opening_ar_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND ${keys.map((k) => `(${k} IS NULL OR ${k} = '')`).join(' AND ')}`,
      [...keys.map((k) => u.set[k]), u.id]);
    n += r.affectedRows;
  }
  console.log(`Filled ${n} item(s).`);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
