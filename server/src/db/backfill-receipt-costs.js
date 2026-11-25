// Backfills Average Cost and Last Purchase Price from the receipts made in T1S (2026-11-25).
//
// Until lib/itemCost.js, nothing in T1S updated either figure: they were copied once from the
// source system (db/backfill-material-costing.js). Every receipt made in T1S since it took over
// purchasing (2026-10-01: from then on every Receiving Report was made by a T1S user; September's
// came from the source, which its own averages already include) was left out, and 69 items bought
// only in T1S had no Average Cost at all, so their stock went out at 0.
//
// What it does, per stock item received or returned since --from (default 2026-10-01):
//   start  = the item's imported Average Cost. If the live code has already re-costed it (an
//            "average_cost (RR-...)" audit entry), the value BEFORE the first such entry, so
//            nothing is counted twice.
//   replay = its receipts (+ qty at Net of Tax) and vendor returns (- qty at Net of Tax), in date
//            order, through lib/itemCost.js's nextAverage -- the same rule the live code uses. On
//            hand before each one is today's on hand (the Bin Card's number) less every movement
//            dated that day or later, plus the replayed ones earlier the same day.
//   last   = Last Purchase Price / Date from the latest receipt (Net of Tax / qty, its date).
//
// Dry run by default: prints every item it would change. --apply writes, with an audit entry on
// each item ("average_cost (backfill since 2026-10-01)").
//
// Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/backfill-receipt-costs.js                 # dry run
//   node src/db/backfill-receipt-costs.js --apply [--user=<username>]   (changes are audited under that user; default admin)
//   node src/db/backfill-receipt-costs.js --from=2026-10-01 --item=SIGN-POST-STEELFRAME-TUBE-W/PLATE-STIFFENER&BOLTS-SET
require('dotenv').config();
const pool = require('../db');
const { movementsSql, movementParams, deriveOnHand } = require('../lib/stockLedger');
const { nextAverage, NON_STOCK_TYPES } = require('../lib/itemCost');

const APPLY = process.argv.includes('--apply');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const FROM = arg('from') || '2026-10-01';
const ONLY_ITEM = arg('item');
const USER = arg('user');
const round4 = (v) => Math.round(v * 10000) / 10000;
const fmt = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString('en-PH', { maximumFractionDigits: 4 }));
const day = (v) => String(v).slice(0, 10);

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM)) throw new Error('--from must be YYYY-MM-DD');
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} -- receipts and vendor returns dated ${FROM} onwards.\n`);

  const [events] = await pool.query(
    `SELECT 'receipt' AS kind, rl.id, rl.item_id, r.date_created AS d, r.receipt_no AS doc,
            rl.qty_received AS qty, rl.net_of_tax AS value
       FROM purchase_order_receipt_lines rl
       JOIN purchase_order_receipts r ON r.id = rl.purchase_order_receipt_id
      WHERE r.date_created >= ? AND rl.location_id IS NOT NULL AND rl.qty_received > 0
     UNION ALL
     SELECT 'return', xl.id, xl.item_id, x.date_created, x.return_no, xl.qty_returned, xl.net_of_tax
       FROM purchase_return_lines xl
       JOIN purchase_returns x ON x.id = xl.purchase_return_id
      WHERE x.date_created >= ? AND xl.location_id IS NOT NULL AND xl.qty_returned > 0`,
    [FROM, FROM]);

  const itemIds = [...new Set(events.map((e) => Number(e.item_id)))];
  if (!itemIds.length) { console.log('Nothing received since then.'); return; }
  const [items] = await pool.query(
    `SELECT id, item_code, item_type, average_cost, last_purchase_price, last_purchase_date, conversion_factor
       FROM inventories WHERE id IN (?)${ONLY_ITEM ? ' AND item_code = ?' : ''}`,
    ONLY_ITEM ? [itemIds, ONLY_ITEM] : [itemIds]);
  const stock = items.filter((i) => !NON_STOCK_TYPES.has(i.item_type));
  const ids = stock.map((i) => i.id);
  if (!ids.length) { console.log('No stock items to re-cost.'); return; }

  // The average each item had before any live re-costing (the earliest live audit entry's old value).
  const [liveAudit] = await pool.query(
    `SELECT a.auditable_id AS id, a.old_value
       FROM audit_logs a
       JOIN (SELECT auditable_id, MIN(id) AS first_id FROM audit_logs
              WHERE auditable_type = 'Inventory' AND field_name LIKE 'average_cost (%' AND field_name NOT LIKE 'average_cost (backfill%'
                AND auditable_id IN (?) GROUP BY auditable_id) f ON f.first_id = a.id`,
    [ids]);
  const imported = new Map(liveAudit.map((r) => [Number(r.id), r.old_value === null ? 0 : Number(r.old_value)]));

  // On hand now, and every movement since FROM by date, to work back to the start of any day.
  const onHandNow = new Map();
  for (const [key, balance] of await deriveOnHand(pool, ids)) {
    const id = Number(key.split('|')[0]);
    onHandNow.set(id, (onHandNow.get(id) || 0) + balance);
  }
  const [moves] = await pool.query(
    `SELECT m.item_id, DATE(m.trans_date) AS d, SUM(m.qty_in - m.qty_out) AS net
       FROM (${movementsSql(true)}) m WHERE m.trans_date >= ? GROUP BY m.item_id, DATE(m.trans_date)`,
    [...movementParams(ids), FROM]);
  const movesByItem = new Map();
  for (const m of moves) {
    const list = movesByItem.get(Number(m.item_id)) || [];
    list.push({ d: day(m.d), net: Number(m.net) });
    movesByItem.set(Number(m.item_id), list);
  }

  const plans = [];
  for (const item of stock) {
    const cf = Number(item.conversion_factor) || 1;
    const mine = events.filter((e) => Number(e.item_id) === item.id)
      .sort((a, b) => day(a.d).localeCompare(day(b.d)) || (a.kind === b.kind ? a.id - b.id : a.kind === 'receipt' ? -1 : 1));
    const startOfDay = (d) => {
      const after = (movesByItem.get(item.id) || []).filter((m) => m.d >= d).reduce((t, m) => t + m.net, 0);
      return ((onHandNow.get(item.id) || 0) - after) / cf;
    };
    let average = imported.has(item.id) ? imported.get(item.id) : Number(item.average_cost || 0);
    const start = average;
    let currentDay = null;
    let sameDay = 0;
    let last = null;
    for (const e of mine) {
      const d = day(e.d);
      if (d !== currentDay) { currentDay = d; sameDay = 0; }
      const onHand = startOfDay(d) + sameDay;
      const qty = Number(e.qty);
      const value = Number(e.value);
      if (e.kind === 'receipt') {
        average = nextAverage({ onHand, average, addQty: qty, addValue: value });
        sameDay += qty;
        if (!last || d >= last.date) last = { price: round4(value / qty), date: d, doc: e.doc };
      } else {
        average = nextAverage({ onHand, average, removeQty: qty, removeValue: value });
        sameDay -= qty;
      }
    }
    const lastDay = item.last_purchase_date ? day(item.last_purchase_date) : null;
    const newLast = last && (!lastDay || last.date >= lastDay) ? last : null;
    const avgChanged = Math.abs(average - Number(item.average_cost || 0)) > 0.00005 || (item.average_cost === null && average > 0);
    // Under half a centavo is the source's rounding of the same price (53.5714 vs 53.5713), not a change.
    const lastChanged = newLast && (Math.abs(newLast.price - Number(item.last_purchase_price || 0)) >= 0.005
      || item.last_purchase_price === null || newLast.date !== lastDay);
    if (avgChanged || lastChanged) {
      plans.push({ item, start, average: round4(average), newLast, avgChanged, lastChanged, receipts: mine.filter((e) => e.kind === 'receipt').length, returns: mine.filter((e) => e.kind === 'return').length });
    }
  }

  plans.sort((a, b) => a.item.item_code.localeCompare(b.item.item_code));
  for (const p of plans) {
    console.log(`${p.item.item_code}`);
    console.log(`   average  ${fmt(p.item.average_cost)} -> ${fmt(p.average)}   (from ${fmt(p.start)}, ${p.receipts} receipt(s), ${p.returns} return(s))`);
    if (p.lastChanged) console.log(`   last     ${fmt(p.item.last_purchase_price)} ${p.item.last_purchase_date ? day(p.item.last_purchase_date) : ''} -> ${fmt(p.newLast.price)} ${p.newLast.date} (${p.newLast.doc})`);
  }
  const blank = plans.filter((p) => !(Number(p.item.average_cost) > 0)).length;
  console.log(`\n${stock.length} stock item(s) received or returned since ${FROM}; ${plans.length} to change (${blank} had no Average Cost).`);

  if (!APPLY) { console.log('Dry run: nothing written. Re-run with --apply.'); return; }
  const conn = await pool.getConnection();
  try {
    // audit_logs.set_by_user_id is required: the changes are logged under --user (default admin).
    const [[actor]] = await conn.query(
      `SELECT id, username FROM users WHERE username = ? OR (? = '' AND account_type = 'System Admin' AND is_active = 1)
        ORDER BY username = ? DESC, id LIMIT 1`, [USER, USER, USER || 'admin']);
    if (!actor) throw new Error(`No user ${USER ? `"${USER}"` : 'System Admin'} to record the changes under (--user=<username>).`);
    console.log(`Recording the changes under user ${actor.username}.`);
    await conn.beginTransaction();
    const ref = `backfill since ${FROM}`;
    for (const p of plans) {
      const sets = []; const params = []; const audit = [];
      if (p.avgChanged) { sets.push('average_cost = ?'); params.push(p.average); audit.push(['average_cost', p.item.average_cost, p.average]); }
      if (p.lastChanged) {
        sets.push('last_purchase_price = ?', 'last_purchase_date = ?'); params.push(p.newLast.price, p.newLast.date);
        audit.push(['last_purchase_price', p.item.last_purchase_price, p.newLast.price]);
      }
      await conn.query(`UPDATE inventories SET ${sets.join(', ')} WHERE id = ?`, [...params, p.item.id]);
      for (const [field, oldValue, newValue] of audit) {
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('Inventory', ?, 'Updated', ?, ?, ?, ?)`,
          [p.item.id, `${field} (${ref})`, oldValue === null ? null : String(oldValue), String(newValue), actor.id]);
      }
    }
    await conn.commit();
    console.log(`Applied to ${plans.length} item(s).`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

main().then(() => pool.end()).catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
