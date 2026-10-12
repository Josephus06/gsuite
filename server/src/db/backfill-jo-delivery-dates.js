// Job Orders' Delivery Date and Delivery Time from the source (2026-10-12). About 126,000 migrated JOs
// came over with neither -- JO-68702-1-2 read blank where the source has 11 Jul 2026, 7:03 PM -- and
// their Sales Order lines do not hold it either.
//
// Fills only what is EMPTY in T1S: a delivery date or time set here is never overwritten. The
// source's DeliveryTime_TransH is a UTC instant on 1970-01-01 ("1970-01-01T11:03:00.000Z"); T1S keeps
// the Manila wall-clock time (19:03), as the source's own screen shows it.
//
// READ-ONLY against the source (get_transactions, Module JOBORDER, paged).
//   node src/db/backfill-jo-delivery-dates.js --dry-run
//   node src/db/backfill-jo-delivery-dates.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const L = require('./lib/liveWindow');

const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => (s || '').toString().trim().toUpperCase();
// A real calendar date only: the source holds some as "0000-00-00", which MySQL refuses.
function ymd(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? m[0].slice(0, 10) : null;
}
// "1970-01-01T11:03:00.000Z" -> "19:03:00" (UTC+8, wrapped to the day)
function manilaTime(v) {
  const m = /T(\d{2}):(\d{2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const h = (Number(m[1]) + 8) % 24;
  return `${String(h).padStart(2, '0')}:${m[2]}:${m[3]}`;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  const [jos] = await pool.query(
    'SELECT id, job_order_no, delivery_date, delivery_time FROM job_orders WHERE delivery_date IS NULL OR delivery_time IS NULL');
  const missing = new Map(jos.map((j) => [norm(j.job_order_no), j]));
  console.log(`T1S JOs missing a delivery date or time: ${jos.length}`);

  const t = await L.login();
  const updates = []; let seen = 0;
  for (let off = 0; ; off += 500) {
    const rows = L.listRows(await L.api(t, 'get_transactions', { where: { Module_TransH: 'JOBORDER' }, order: [['ID_TransH', 'ASC']], limit: 500, offset: off }));
    for (const r of rows) {
      seen += 1;
      const mine = missing.get(norm(r.UserPK_TransH));
      if (!mine) continue;
      const date = !mine.delivery_date ? ymd(r.DeliveryDate_TransH) : null;
      const time = !mine.delivery_time ? manilaTime(r.DeliveryTime_TransH) : null;
      if (date || time) updates.push({ id: mine.id, no: mine.job_order_no, date, time });
    }
    if (rows.length < 500) break;
  }
  const withDate = updates.filter((u) => u.date).length;
  const withTime = updates.filter((u) => u.time).length;
  console.log(`source JOs read ${seen} | JOs to fill ${updates.length} (delivery date ${withDate}, delivery time ${withTime})`);
  const sample = updates.find((u) => u.no === 'JO-68702-1-2');
  if (sample) console.log(`  JO-68702-1-2: delivery date ${sample.date}, time ${sample.time}`);

  if (!DRY_RUN && updates.length) {
    for (let i = 0; i < updates.length; i += 1000) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const u of updates.slice(i, i + 1000)) {
          await conn.query(
            `UPDATE job_orders SET delivery_date = COALESCE(delivery_date, ?), delivery_time = COALESCE(delivery_time, ?) WHERE id = ?`,
            [u.date, u.time, u.id]);
        }
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
    console.log(`Filled ${updates.length} JO(s).`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
