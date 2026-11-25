// Ties a Transfer Order to a Job Order process line, re-costs that line, and brings the Assembly
// Builds made from it up to date (2026-11-25, TO-42889 -> JO-69630-2-2 line 21 -> AB-356102).
//
// The case: a JO line's item was changed after the job was built (SERVICE LABOR -> the steel frame
// it really used), the frame was moved to the job location on a TO raised without a JO, and the
// build still showed the line as it was copied on the day (SERVICE LABOR, no material cost).
// Nothing in the app redoes any of the three, so this does what each screen would have done:
//
//   1. TO header and its line for the JO line's item -> job_order_id / job_order_process_id.
//   2. The JO line re-costed with lib/joProcessCosting.js (the estimate's formula: the process's
//      bracket and the item's Average Cost), so its Material Cost is no longer 0.
//   3. Every non-cancelled Assembly Build line made from that JO line takes the JO line's item,
//      process, unit and costs -- what production.js copies when a build is saved -- and the
//      build's total_amount is summed again the same way (process + material cost of its lines).
//      If the line now consumes a stock item it did not before, the on-hand snapshot at the line's
//      location is lowered by what the build took (the stock ledger derives it from the line).
//      GL Impact is computed live from the lines, so it follows.
// Every change is audited on its record.
//
// Dry run by default.
//   node src/db/link-to-to-jo-line.js --to=TO-42889 --jo=JO-69630-2-2 --line=21
//   node src/db/link-to-to-jo-line.js --to=TO-42889 --jo=JO-69630-2-2 --line=21 --apply [--user=admin]
require('dotenv').config();
const pool = require('../db');
const { costProcessLine } = require('../lib/joProcessCosting');
const { isNonStockItem } = require('../lib/itemTypes');

const APPLY = process.argv.includes('--apply');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const TO_NO = arg('to');
const JO_NO = arg('jo');
const LINE_NO = Number(arg('line'));
const USER = arg('user') || 'admin';
const money = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function main() {
  if (!TO_NO || !JO_NO || !(LINE_NO > 0)) throw new Error('Usage: --to=TO-##### --jo=JO-##### --line=<JO process line no> [--apply]');
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'APPLYING changes.\n' : 'DRY RUN -- nothing will be written.\n');
  const conn = await pool.getConnection();
  try {
    const [[user]] = await conn.query('SELECT id, username FROM users WHERE username = ?', [USER]);
    if (!user) throw new Error(`No user "${USER}" to record the changes under (--user=)`);
    const [[to]] = await conn.query('SELECT * FROM transfer_orders WHERE to_no = ?', [TO_NO]);
    if (!to) throw new Error(`${TO_NO} not found`);
    const [[jo]] = await conn.query('SELECT id, job_order_no FROM job_orders WHERE job_order_no = ?', [JO_NO]);
    if (!jo) throw new Error(`${JO_NO} not found`);
    const [[line]] = await conn.query(
      `SELECT jop.*, i.item_code, i.item_type FROM job_order_processes jop LEFT JOIN inventories i ON i.id = jop.item_id
        WHERE jop.job_order_id = ? AND jop.line_no = ?`, [jo.id, LINE_NO]);
    if (!line) throw new Error(`${JO_NO} has no line ${LINE_NO}`);
    const [toLines] = await conn.query('SELECT * FROM transfer_order_lines WHERE transfer_order_id = ? AND item_id = ?', [to.id, line.item_id]);
    if (!toLines.length) throw new Error(`${TO_NO} has no line for ${line.item_code}, the item on ${JO_NO} line ${LINE_NO}`);
    if (to.job_order_id && Number(to.job_order_id) !== jo.id) throw new Error(`${TO_NO} is already on another job order (id ${to.job_order_id})`);

    // 1. Transfer Order
    console.log(`1. ${TO_NO} (${toLines.length} line(s) of ${line.item_code}) -> ${JO_NO} line ${LINE_NO}`);

    // 2. JO line cost
    const cost = await costProcessLine(conn, line);
    if (cost.needs_check) throw new Error(`${JO_NO} line ${LINE_NO} cannot be costed: ${cost.needs_check}`);
    console.log(`2. ${JO_NO} line ${LINE_NO}: process ${money(line.process_cost)} -> ${money(cost.process_cost)}, material ${money(line.material_cost)} -> ${money(cost.material_cost)}, total ${money(line.total_cost)} -> ${money(cost.total_cost)}`);

    // 3. Assembly Build lines made from it
    const [abLines] = await conn.query(
      `SELECT abl.*, ab.ab_no, ab.id AS ab_id, i.item_code AS old_item_code, i.item_type AS old_item_type
         FROM assembly_build_lines abl
         JOIN assembly_builds ab ON ab.id = abl.assembly_build_id
         LEFT JOIN inventories i ON i.id = abl.item_id
        WHERE abl.job_order_process_id = ? AND ab.status <> 'cancelled'`, [line.id]);
    const [[unitRow]] = await conn.query(
      `SELECT u.code AS base_code, i.conversion_factor FROM inventories i LEFT JOIN units_of_measure u ON u.id = i.base_unit_id WHERE i.id = ?`,
      [line.item_id]);
    const toBase = (qty) => (String(line.unit || '').toUpperCase() === String(unitRow?.base_code || '').toUpperCase()
      ? qty : qty * (Number(unitRow?.conversion_factor) || 1));
    for (const l of abLines) {
      console.log(`3. ${l.ab_no} line (from ${JO_NO} line ${LINE_NO}): ${l.old_item_code} ${l.unit} -> ${line.item_code} ${line.unit}; `
        + `process ${money(l.process_cost)} -> ${money(cost.process_cost)}, material ${money(l.material_cost)} -> ${money(cost.material_cost)}, total ${money(l.total_cost)} -> ${money(cost.total_cost)}`);
      const newlyStock = !isNonStockItem(line.item_type) && (isNonStockItem(l.old_item_type) || Number(l.item_id) !== Number(line.item_id));
      if (newlyStock && l.location_id) console.log(`   it now takes ${toBase(Number(l.total_qty_to_build))} ${unitRow?.base_code} of ${line.item_code} off location ${l.location_id}`);
    }
    if (!abLines.length) console.log('3. No Assembly Build was made from that line.');
    if (!APPLY) { console.log('\nDry run: nothing written. Re-run with --apply.'); return; }

    await conn.beginTransaction();
    const audit = (type, id, field, oldV, newV) => conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES (?, ?, 'Updated', ?, ?, ?, ?)`, [type, id, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), user.id]);

    if (!to.job_order_id) {
      await conn.query('UPDATE transfer_orders SET job_order_id = ?, updated_at = NOW() WHERE id = ?', [jo.id, to.id]);
      await audit('TransferOrder', to.id, 'job_order', null, JO_NO);
    }
    for (const tl of toLines) {
      await conn.query('UPDATE transfer_order_lines SET job_order_id = ?, job_order_process_id = ? WHERE id = ?', [jo.id, line.id, tl.id]);
      await audit('TransferOrder', to.id, `line ${tl.line_no} job_order_process`, null, `${JO_NO} line ${LINE_NO}`);
    }

    await conn.query('UPDATE job_order_processes SET process_cost = ?, material_cost = ?, total_cost = ? WHERE id = ?',
      [cost.process_cost, cost.material_cost, cost.total_cost, line.id]);
    await audit('JobOrder', jo.id, `line ${LINE_NO} material_cost`, line.material_cost, cost.material_cost);
    await audit('JobOrder', jo.id, `line ${LINE_NO} total_cost`, line.total_cost, cost.total_cost);

    for (const l of abLines) {
      const newlyStock = !isNonStockItem(line.item_type) && (isNonStockItem(l.old_item_type) || Number(l.item_id) !== Number(line.item_id));
      await conn.query(
        `UPDATE assembly_build_lines SET item_id = ?, process_id = ?, unit = ?, process_cost = ?, material_cost = ?, total_cost = ? WHERE id = ?`,
        [line.item_id, line.process_id, line.unit, cost.process_cost, cost.material_cost, cost.total_cost, l.id]);
      if (newlyStock && l.location_id) {
        await conn.query('UPDATE inventory_locations SET qty_on_hand = qty_on_hand - ? WHERE inventory_id = ? AND location_id = ?',
          [toBase(Number(l.total_qty_to_build)), line.item_id, l.location_id]);
      }
      const [[sum]] = await conn.query(
        'SELECT SUM(COALESCE(process_cost, 0) + COALESCE(material_cost, 0)) AS total FROM assembly_build_lines WHERE assembly_build_id = ?', [l.ab_id]);
      const [[ab]] = await conn.query('SELECT total_amount FROM assembly_builds WHERE id = ?', [l.ab_id]);
      await conn.query('UPDATE assembly_builds SET total_amount = ?, updated_at = NOW() WHERE id = ?', [sum.total, l.ab_id]);
      await audit('AssemblyBuild', l.ab_id, `line from ${JO_NO} line ${LINE_NO}`, `${l.old_item_code} / material ${l.material_cost}`, `${line.item_code} / material ${cost.material_cost}`);
      await audit('AssemblyBuild', l.ab_id, 'total_amount', ab.total_amount, sum.total);
      console.log(`   ${l.ab_no} total_amount ${money(ab.total_amount)} -> ${money(sum.total)}`);
    }
    await conn.commit();
    console.log('\nApplied.');
  } catch (err) {
    try { await conn.rollback(); } catch { /* not in a transaction */ }
    throw err;
  } finally {
    conn.release();
  }
}

main().then(() => pool.end()).catch(async (err) => { console.error(`ERROR: ${err.message}`); await pool.end(); process.exit(1); });
