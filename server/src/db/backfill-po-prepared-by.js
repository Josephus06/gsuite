// Purchase Orders migrated from the source with no Created By (2026-10-27: PO-20560 showed "—").
//
// import-purchase-orders.js never carried the source's PreparedBy_TransH, so every migrated PO --
// about 20,000, 2021 to the cut-over -- has created_by_user_id NULL. The source's PO list has the
// name (PO-20560: Randill Caparroso); this matches it to a T1S user by display name, as the journal
// import does ("Jr." aside: Israel Hortezuela Jr. is the user Israel Hortezuela), and fills in only
// POs that have no creator yet. A name with no T1S user -- former staff with no login (Maria Shella
// Nayre, PINKY POLO, ...) -- is kept as text in purchase_orders.prepared_by_name, which the PO
// screens show when there is no user (routes/purchaseOrders.js).
//
// Read-only on the source.
//
//   node src/db/backfill-po-prepared-by.js --from=2021-01-01 --to=2026-12-31           # dry run
//   node src/db/backfill-po-prepared-by.js --from=2021-01-01 --to=2026-12-31 --apply
require('dotenv').config();
const pool = require('../db');
const { login, fetchWindow } = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const FROM = arg('from', '2021-01-01');
const TO = arg('to', '2026-12-31');
const norm = (s) => (s || '').toString().replace(/,?\s+jr\.?\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN'}  window ${FROM}..${TO}\n`);
  const [[col]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'purchase_orders' AND column_name = 'prepared_by_name'");
  if (!col.n) {
    if (APPLY) { await pool.query('ALTER TABLE purchase_orders ADD COLUMN prepared_by_name VARCHAR(150) NULL'); console.log('purchase_orders.prepared_by_name added.'); }
    else console.log('Would add purchase_orders.prepared_by_name (VARCHAR 150).');
  }
  const [users] = await pool.query('SELECT id, display_name FROM users');
  const userByName = new Map(users.map((u) => [norm(u.display_name), u.id]));
  const [missing] = await pool.query(
    'SELECT id, po_no FROM purchase_orders WHERE created_by_user_id IS NULL AND date_created BETWEEN ? AND ?', [FROM, TO]);
  const poByNo = new Map(missing.map((p) => [p.po_no, p.id]));
  console.log(`${missing.length} PO(s) in the window with no Created By.`);

  const token = await login();
  const rows = await fetchWindow(token, {
    endpoint: 'get_purchase_orders', from: FROM, to: TO, keyField: 'UserPK_TransH',
    extra: { viewAll: true }, refresh: REFRESH, onProgress: (m) => console.log(m),
  });

  const byUser = new Map(); // user id -> [po id]
  const byText = new Map(); // source name with no T1S user -> [po id]
  let noName = 0;
  for (const r of rows) {
    const id = poByNo.get(r.UserPK_TransH);
    if (!id) continue;
    const name = norm(r.PreparedBy_TransH);
    if (!name) { noName += 1; continue; }
    const uid = userByName.get(name);
    if (uid) { byUser.set(uid, [...(byUser.get(uid) || []), id]); continue; }
    const text = r.PreparedBy_TransH.replace(/\s+/g, ' ').trim();
    byText.set(text, [...(byText.get(text) || []), id]);
  }
  const count = (m) => [...m.values()].reduce((s, a) => s + a.length, 0);
  const nameOf = new Map(users.map((u) => [u.id, u.display_name]));
  console.log(`\nMatched to a T1S user: ${count(byUser)}`);
  for (const [uid, ids] of [...byUser].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(ids.length).padStart(6)}  ${nameOf.get(uid)}`);
  console.log(`\nNo T1S user -- the source's name is kept: ${count(byText)}`);
  for (const [n, ids] of [...byText].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(ids.length).padStart(6)}  ${n}`);
  console.log(`No Prepared By in the source: ${noName}`);
  console.log(`Not found in the source window: ${missing.length - count(byUser) - count(byText) - noName}`);

  if (!APPLY) { console.log('\nDry run -- re-run with --apply to set them.'); process.exit(0); }
  let n = 0; let t = 0;
  for (const [uid, ids] of byUser) {
    for (let i = 0; i < ids.length; i += 1000) {
      const [res] = await pool.query('UPDATE purchase_orders SET created_by_user_id = ? WHERE id IN (?) AND created_by_user_id IS NULL', [uid, ids.slice(i, i + 1000)]);
      n += res.affectedRows;
    }
  }
  for (const [text, ids] of byText) {
    for (let i = 0; i < ids.length; i += 1000) {
      const [res] = await pool.query('UPDATE purchase_orders SET prepared_by_name = ? WHERE id IN (?) AND created_by_user_id IS NULL AND prepared_by_name IS NULL', [text, ids.slice(i, i + 1000)]);
      t += res.affectedRows;
    }
  }
  console.log(`\nCreated By set to a T1S user on ${n} PO(s), and to the source's name on ${t} more.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
