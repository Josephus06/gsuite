// Cancels the sales orders whose every line was cancelled in the source (2026-10-14).
//
// The source cancels an order's LINES ("Customer Cancels an Order") and can leave the order itself
// at "JO IN-PROCESS" with its header amount untouched. The import skips cancelled lines, so these
// orders arrived with a header amount and no lines: the line-based reports (Weighted Sales,
// commission) rightly left them out, while the header-based Sales Order Report still counted them
// -- nineteen 2026 orders, SO-71811 and SO-72118 among them. Cancelling them here makes both agree.
//
// An order is only cancelled when it has no lines here, is not cancelled already, has no live
// invoice, and the source confirms that every one of its lines is cancelled there. The reason is
// the one the source gave the lines (Double Booking, Change Item/Quantity...), matched by name to
// Master Lists > Reasons, else "Customer Cancels an order"; recorded against --as=<user id> in the
// audit log, as the Cancel button would. Its item deliveries (they carry no lines) are left as they are.
//
//   node src/db/cancel-all-lines-cancelled-sos.js                (dry run)
//   node src/db/cancel-all-lines-cancelled-sos.js --as=1 --apply
//   --from=2026-01-01 (default) limits which orders are looked at, by order date.
const pool = require('../db');
require('dotenv').config();
const { login, api, fetchWindow } = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
function argVal(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
}
const FROM = argVal('from', '2026-01-01');
const AS = Number(argVal('as', 0)) || null;
const REMARKS = 'All lines cancelled in the source -- order cancelled to match';
const day = (v) => (v || '').toString().slice(0, 10);

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'APPLYING.\n' : 'DRY RUN -- nothing is written. Add --as=<user id> --apply to write.\n');
  if (APPLY && !AS) throw new Error('--apply needs --as=<user id> for the audit log.');
  if (AS) {
    const [[u]] = await pool.query('SELECT id FROM users WHERE id = ?', [AS]);
    if (!u) throw new Error(`No user ${AS}.`);
  }
  const [reasons] = await pool.query("SELECT id, name FROM reasons WHERE reason_type = 'Cancellation'");
  const reasonByName = new Map(reasons.map((r) => [r.name.trim().toLowerCase(), r]));
  const fallback = reasonByName.get('customer cancels an order');
  if (!fallback) throw new Error('Cancellation reason "Customer Cancels an order" not found.');

  const [orders] = await pool.query(
    `SELECT so.id, so.sales_order_no, so.date_created, so.status, so.net_of_tax
       FROM sales_orders so
      WHERE COALESCE(so.status, '') <> 'cancelled' AND COALESCE(so.net_of_tax, 0) <> 0
        AND so.date_created >= ?
        AND NOT EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.sales_order_id = so.id)
        AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.sales_order_id = so.id AND si.status <> 'cancelled')
      ORDER BY so.date_created, so.sales_order_no`, [FROM]);
  console.log(`${orders.length} lineless, uninvoiced sales order(s) to check.`);
  if (!orders.length) return;

  const token = await login();
  const soRows = await fetchWindow(token, {
    endpoint: 'get_sales_orders', from: day(orders[0].date_created), to: day(orders[orders.length - 1].date_created),
    keyField: 'so_upk', extra: { viewAll: true }, onProgress: () => {},
  });
  const srcByNo = new Map(soRows.map((r) => [r.so_upk, r]));

  let done = 0, total = 0;
  const skipped = [];
  for (const so of orders) {
    const src = srcByNo.get(so.sales_order_no);
    if (!src) { skipped.push(`${so.sales_order_no}: not found in the source`); continue; }
    const lines = (await api(token, 'get_estimate', { pk: src.so_pk })).data?.[1] || [];
    if (!lines.length) { skipped.push(`${so.sales_order_no}: the source has no lines at all`); continue; }
    if (lines.some((l) => !l.IsCancelled_LdgrJob)) { skipped.push(`${so.sales_order_no}: the source has a line that is NOT cancelled`); continue; }
    const whys = [...new Set(lines.map((l) => (l.Reason_LdgrJob || '').trim()).filter(Boolean))];
    const reason = reasonByName.get((whys[0] || '').toLowerCase()) || fallback;
    console.log(`${so.sales_order_no}  ${day(so.date_created)}  ${Number(so.net_of_tax).toFixed(2).padStart(10)}  ` +
      `${lines.length} line(s) cancelled in source (${whys.join('; ') || 'no reason given'}) -> ${reason.name}`);
    total += Number(so.net_of_tax) || 0;
    if (!APPLY) { done += 1; continue; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `UPDATE sales_orders SET status = 'cancelled', cancel_reason_id = ?, cancel_remarks = ?, cancelled_at = NOW(), cancelled_by_user_id = ?
          WHERE id = ? AND COALESCE(status, '') <> 'cancelled'
            AND NOT EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.sales_order_id = ?)`,
        [reason.id, REMARKS, AS, so.id, so.id]);
      if (!r.affectedRows) { await conn.rollback(); skipped.push(`${so.sales_order_no}: changed since it was read -- left alone`); continue; }
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('SalesOrder', ?, 'Cancelled', 'status', ?, ?, ?)`,
        [so.id, so.status, `cancelled -- ${reason.name}: ${REMARKS}`.slice(0, 2000), AS]);
      await conn.commit();
      done += 1;
    } catch (e) {
      await conn.rollback();
      skipped.push(`${so.sales_order_no}: FAILED, nothing written -- ${e.message}`);
    } finally {
      conn.release();
    }
  }
  console.log(`\n${APPLY ? 'Cancelled' : 'WOULD CANCEL'}: ${done} order(s), net ${total.toFixed(2)}.`);
  if (skipped.length) console.log(`\nLeft alone:\n  ${skipped.join('\n  ')}`);
}

main().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
