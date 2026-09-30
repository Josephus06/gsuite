// One-off, 2026-09-30 (cut-over day): hard-delete the SAMPLE documents staff and developers
// created inside T1S before go-live -- estimates, SO, JO, AB, ID, QI, customer payments,
// invoices, DT, journals and bank deposits -- and undo what they did to the MIGRATED records
// they touched (JO quantities, invoice balances, credit memo applications, deposited payments,
// bank reconciliation links, SO status, JO production stage).
//
// "Created in T1S" (migrated rows never carry these marks):
//   - an audit_logs 'Created' row for the document, or
//   - created_by_user_id set to anyone but user 1 (the account that ran every import;
//     importers stamp user 1 on AB/ID/QI/journals and leave CP/INV/DT/BD creator NULL), or
//   - hanging off a T1S document (the SO of a T1S estimate, the JOs of a T1S SO, ...).
// Web-quote estimates (web_source set) are customers' own quotes and are left alone.
// Void-reversal journals are kept unless the document they reverse is being deleted.
//
// Stock is derived from movement tables (lib/stockLedger.js), so deleting assembly_build_lines
// restores Bin Card / on-hand by itself; inventory_locations.qty_on_hand is still put back the
// way AB cancel does, to keep that unused snapshot consistent.
//
//   node src/db/delete-t1s-samples.js            preview only (default) -- changes nothing
//   node src/db/delete-t1s-samples.js --apply    do it, in one transaction
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');
const { computeSalesOrderStatus } = require('../lib/salesOrderStatus');

const APPLY = process.argv.includes('--apply');
const IMPORT_USER = 1;

async function main() {
  const conn = await pool.getConnection();
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const ids = (rows, k = 'id') => [...new Set(rows.map((r) => Number(r[k])).filter(Boolean))];
  const IN = (arr) => (arr.length ? arr : [0]);
  // ONLY the audit row a document's own creation writes. 'Created' is also logged when a line is
  // added to an existing document (field 'job_order[1]', 'material[3]', 'delivery_method' ...),
  // which on 2026-09-30 wrongly swept in migrated EST-88037 and everything hanging off it.
  const audited = async (type, fields) => ids(await q(
    `SELECT DISTINCT auditable_id id FROM audit_logs WHERE auditable_type = ? AND event_type = 'Created'
       AND (${fields.map((f) => (f === null ? 'field_name IS NULL' : 'field_name = ?')).join(' OR ')})`,
    [type, ...fields.filter((f) => f !== null)]));
  const union = (...a) => [...new Set(a.flat())];

  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLY' : 'PREVIEW (nothing is changed)'}`);

  // ---------------------------------------------------------------- the sets
  const webEst = ids(await q('SELECT id FROM estimates WHERE web_source IS NOT NULL'));
  // ...and T1S's own numbering, as a second guard: EST-(100000+id), SO-(60000+id).
  const estAudited = await audited('Estimate', [null, 'replicated_from']);
  const EST = ids(await q("SELECT id FROM estimates WHERE id IN (?) AND estimate_no = CONCAT('EST-', 100000 + id) AND web_source IS NULL", [IN(estAudited)]));
  const estRejected = estAudited.filter((id) => !EST.includes(id) && !webEst.includes(id));
  const SO = ids(await q("SELECT id FROM sales_orders WHERE estimate_id IN (?) AND sales_order_no = CONCAT('SO-', 60000 + id)", [IN(EST)]));
  // A sample estimate that a REAL (source-numbered) SO points at stays: sales_orders.estimate_id is
  // NOT NULL, and the importer matched those SOs to it by number (SO-66534/66561/66551 ->
  // EST-100015/21/22, all billed). Removing it would mean removing a real order.
  const estNeededByReal = ids(await q('SELECT DISTINCT estimate_id id FROM sales_orders WHERE estimate_id IN (?) AND id NOT IN (?)', [IN(EST), IN(SO)]));
  for (const id of estNeededByReal) EST.splice(EST.indexOf(id), 1);
  if (estNeededByReal.length) console.log(`Kept ${estNeededByReal.length} sample estimate(s) a real SO points at: ${(await q('SELECT estimate_no n FROM estimates WHERE id IN (?)', [estNeededByReal])).map((r) => r.n).join(', ')}`);
  let JO = union(await audited('JobOrder', ['status']), ids(await q('SELECT id FROM job_orders WHERE sales_order_id IN (?)', [IN(SO)])));
  for (;;) { // RWIP / RFQC children of sample JOs
    const kids = ids(await q('SELECT id FROM job_orders WHERE parent_job_order_id IN (?) AND id NOT IN (?)', [IN(JO), IN(JO)]));
    if (!kids.length) break;
    JO = union(JO, kids);
  }
  // Downstream documents: their OWN creation marks, plus anything made ON a sample -- unless it
  // was stamped by an import batch (created_at shared by 3+ rows of the table). Those are real
  // source documents that the importer attached to a sample because the sample had taken the
  // real document's number (SO-60005, JO-163411-1-2 ...); they stay, and are unlinked below.
  const notBatch = async (t, set) => (set.length ? ids(await q(
    `SELECT x.id FROM ${t} x WHERE x.id IN (?) AND (SELECT COUNT(*) FROM ${t} y WHERE y.created_at = x.created_at) < 3`, [set])) : []);
  const AB = union(
    ids(await q('SELECT id FROM assembly_builds WHERE created_by_user_id <> ?', [IMPORT_USER])),
    await notBatch('assembly_builds', ids(await q('SELECT id FROM assembly_builds WHERE job_order_id IN (?)', [IN(JO)]))));
  const QI = union(
    ids(await q('SELECT id FROM quality_inspections WHERE created_by_user_id <> ?', [IMPORT_USER])),
    await audited('QualityInspection', ['qi_no']),
    await notBatch('quality_inspections', union(
      ids(await q('SELECT id FROM quality_inspections WHERE job_order_id IN (?)', [IN(JO)])),
      ids(await q('SELECT DISTINCT quality_inspection_id id FROM quality_inspection_lines WHERE assembly_build_id IN (?)', [IN(AB)])))));
  // Every delivery on a sample SO goes with it: item_deliveries.sales_order_id is NOT NULL, so it
  // cannot be unlinked, and the only batch-stamped ones (ID-67687/67711/67713) are line-less
  // ACME CORP test rows from a 2026-08-12 script, not source documents.
  const ID = union(
    ids(await q('SELECT id FROM item_deliveries WHERE created_by_user_id <> ?', [IMPORT_USER])),
    await audited('ItemDelivery', ['delivery_no']),
    ids(await q('SELECT id FROM item_deliveries WHERE sales_order_id IN (?)', [IN(SO)])),
    await notBatch('item_deliveries',
      ids(await q('SELECT DISTINCT item_delivery_id id FROM item_delivery_lines WHERE job_order_id IN (?)', [IN(JO)]))));
  const DT = union(
    ids(await q('SELECT id FROM delivery_tickets WHERE created_by_user_id IS NOT NULL')),
    await audited('DeliveryTicket', ['dt_no']),
    await notBatch('delivery_tickets', ids(await q('SELECT id FROM delivery_tickets WHERE sales_order_id IN (?)', [IN(SO)]))));
  const INV = union(
    ids(await q('SELECT id FROM sales_invoices WHERE created_by_user_id IS NOT NULL')),
    await audited('SalesInvoice', ['invoice_no']),
    await notBatch('sales_invoices', union(
      ids(await q('SELECT id FROM sales_invoices WHERE sales_order_id IN (?) OR estimate_id IN (?) OR delivery_ticket_id IN (?)', [IN(SO), IN(EST), IN(DT)])),
      ids(await q('SELECT DISTINCT sales_invoice_id id FROM sales_invoice_lines WHERE job_order_id IN (?)', [IN(JO)])))));
  // Plus the synthetic CPAY-<invoice> payments the status sync made for sample invoices: a
  // payment every line of which settles a sample invoice.
  const CP = union(
    ids(await q('SELECT id FROM customer_payments WHERE created_by_user_id IS NOT NULL')),
    await audited('CustomerPayment', ['customer_payment_no']),
    ids(await q(`SELECT customer_payment_id id FROM customer_payment_lines GROUP BY customer_payment_id
        HAVING SUM(sales_invoice_id IN (?)) > 0 AND SUM(sales_invoice_id IN (?)) = COUNT(*)`, [IN(INV), IN(INV)])));
  const BD = union(
    ids(await q('SELECT id FROM bank_deposits WHERE created_by_user_id IS NOT NULL')),
    await audited('BankDeposit', ['bd_no']));
  // Journals: everything made in T1S by staff, except void reversals of documents that stay;
  // plus the reversals of documents being deleted, whoever posted them.
  const revOf = [['sales_invoice', INV], ['delivery_ticket', DT]];
  const revDeleted = [];
  for (const [t, set] of revOf) revDeleted.push(...ids(await q('SELECT id FROM journals WHERE source_type = ? AND source_id IN (?)', [t, IN(set)])));
  const JRN = union(
    ids(await q('SELECT id FROM journals WHERE created_by_user_id IS NOT NULL AND created_by_user_id <> ? AND source_type IS NULL', [IMPORT_USER])),
    revDeleted);
  const keptReversals = ids(await q('SELECT id FROM journals WHERE created_by_user_id <> ? AND source_type IS NOT NULL AND id NOT IN (?)', [IMPORT_USER, IN(JRN)]));
  const JL = ids(await q('SELECT id FROM journal_lines WHERE journal_id IN (?)', [IN(JRN)]));

  const sets = { EST, SO, JO, AB, QI, ID, DT, INV, CP, BD, JRN };
  const list0 = async (t, col, set) => (set.length ? (await q(`SELECT ${col} n FROM ${t} WHERE id IN (?)`, [set])).map((r) => r.n).join(', ') : '-');
  console.log('\nTo delete:', Object.entries(sets).map(([k, v]) => `${k} ${v.length}`).join(' · '));
  console.log(`Kept: ${webEst.length} web-quote estimate(s), ${keptReversals.length} void-reversal journal(s) of documents that stay,`
    + ` ${estRejected.length} audited estimate(s) without T1S numbering (${await list0('estimates', 'estimate_no', estRejected)}).`);
  // Numbering sanity for the rest: flag anything whose number is not in T1S's own series.
  const odd = [];
  for (const [k, t, c, re] of [['SO', 'sales_orders', 'sales_order_no', /^SO-\d+$/], ['AB', 'assembly_builds', 'ab_no', /^AB-\d+$/]]) {
    for (const r of await q(`SELECT ${c} n, created_at FROM ${t} WHERE id IN (?)`, [IN(sets[k])])) if (!re.test(r.n)) odd.push(`${k} ${r.n}`);
  }
  if (odd.length) console.log('  odd numbers:', odd.join(', '));
  const list = async (t, col, set) => (set.length ? (await q(`SELECT ${col} n FROM ${t} WHERE id IN (?) ORDER BY id`, [set])).map((r) => r.n).join(', ') : '-');
  for (const [k, t, c] of [['EST', 'estimates', 'estimate_no'], ['SO', 'sales_orders', 'sales_order_no'], ['JO', 'job_orders', 'job_order_no'],
    ['AB', 'assembly_builds', 'ab_no'], ['QI', 'quality_inspections', 'qi_no'], ['ID', 'item_deliveries', 'delivery_no'],
    ['DT', 'delivery_tickets', 'dt_no'], ['INV', 'sales_invoices', 'invoice_no'], ['CP', 'customer_payments', 'customer_payment_no'],
    ['BD', 'bank_deposits', 'bd_no']]) console.log(`  ${k}: ${await list(t, c, sets[k])}`);
  console.log(`  JRN: ${JRN.length} journal(s) -- ${(await q("SELECT COALESCE(u.display_name,'?') who, COUNT(*) n FROM journals j LEFT JOIN users u ON u.id=j.created_by_user_id WHERE j.id IN (?) GROUP BY who ORDER BY n DESC", [IN(JRN)])).map((r) => `${r.who} ${r.n}`).join(', ')}`);

  // ---------------------------------------------------------------- blockers
  // Rows that stay but point at something being deleted, and are not handled below.
  const blockers = [];
  const check = async (label, sql, params) => { const [[r]] = await conn.query(sql, params); if (Number(r.n)) blockers.push(`${label}: ${r.n}`); };
  await check('imported payments applied to a sample invoice', 'SELECT COUNT(*) n FROM customer_payment_lines WHERE sales_invoice_id IN (?) AND customer_payment_id NOT IN (?)', [IN(INV), IN(CP)]);
  await check('credit memos on a sample invoice', 'SELECT COUNT(*) n FROM credit_memos WHERE sales_invoice_id IN (?)', [IN(INV)]);
  await check('credit memo applications to a sample invoice', 'SELECT COUNT(*) n FROM credit_memo_applications WHERE sales_invoice_id IN (?)', [IN(INV)]);
  await check('kept ABs on a sample JO', 'SELECT COUNT(*) n FROM assembly_builds WHERE job_order_id IN (?) AND id NOT IN (?)', [IN(JO), IN(AB)]);
  await check('kept QIs on a sample JO', 'SELECT COUNT(*) n FROM quality_inspections WHERE job_order_id IN (?) AND id NOT IN (?)', [IN(JO), IN(QI)]);
  await check('kept JOs on a sample SO', 'SELECT COUNT(*) n FROM job_orders WHERE sales_order_id IN (?) AND id NOT IN (?)', [IN(SO), IN(JO)]);
  await check('kept QI lines on a sample AB', 'SELECT COUNT(*) n FROM quality_inspection_lines WHERE assembly_build_id IN (?) AND quality_inspection_id NOT IN (?)', [IN(AB), IN(QI)]);
  if (blockers.length) console.log('\nBLOCKERS (rows that stay but point at a sample):\n  ' + blockers.join('\n  '));
  else console.log('\nNo blockers.');

  // Rows that stay (real imported documents, or transfer orders -- not in the delete list) but
  // point at a sample: the link is cleared, the row kept.
  const UNLINK = [
    ['purchase order lines -> JO', 'purchase_order_lines', 'job_order_id', JO, null],
    ['purchase requisition lines -> JO', 'purchase_requisition_lines', 'job_order_id', JO, null],
    ['transfer orders -> JO', 'transfer_orders', 'job_order_id', JO, null],
    ['transfer order lines -> JO', 'transfer_order_lines', 'job_order_id', JO, null],
    ['transfer order lines -> JO process', 'transfer_order_lines', 'job_order_process_id',
      ids(await q('SELECT id FROM job_order_processes WHERE job_order_id IN (?)', [IN(JO)])), null],
    ['material issue lines -> JO', 'rmi_lines', 'job_order_id', JO, null],
    ['credit memo lines -> JO', 'credit_memo_lines', 'job_order_id', JO, null],
    ['kept deliveries -> SO', 'item_deliveries', 'sales_order_id', SO, ['id', ID]],
    ['kept delivery lines -> JO', 'item_delivery_lines', 'job_order_id', JO, ['item_delivery_id', ID]],
    ['kept DTs -> SO', 'delivery_tickets', 'sales_order_id', SO, ['id', DT]],
    ['kept DT lines -> JO', 'delivery_ticket_lines', 'job_order_id', JO, ['delivery_ticket_id', DT]],
    ['kept invoices -> SO', 'sales_invoices', 'sales_order_id', SO, ['id', INV]],
    ['kept invoices -> estimate', 'sales_invoices', 'estimate_id', EST, ['id', INV]],
    ['kept invoices -> DT', 'sales_invoices', 'delivery_ticket_id', DT, ['id', INV]],
    ['kept invoice lines -> JO', 'sales_invoice_lines', 'job_order_id', JO, ['sales_invoice_id', INV]],
    ['warranty certificates -> SO', 'warranty_certificates', 'sales_order_id', SO, null],
    ['warranty certificate lines -> JO', 'warranty_certificate_lines', 'job_order_id', JO, null],
    ['delivery run stops -> SO', 'delivery_itinerary_stops', 'sales_order_id', SO, null],
  ];
  const unlinkCounts = [];
  for (const [label, t, col, set, keep] of UNLINK) {
    if (!set.length) continue;
    try {
      const [[r]] = await conn.query(`SELECT COUNT(*) n FROM ${t} WHERE ${col} IN (?)${keep ? ` AND ${keep[0]} NOT IN (?)` : ''}`, keep ? [set, IN(keep[1])] : [set]);
      if (Number(r.n)) unlinkCounts.push(`${label}: ${r.n}`);
    } catch (e) { if (!/doesn't exist|Unknown column/.test(e.message)) throw e; }
  }
  console.log(unlinkCounts.length ? `\nKept but unlinked from a sample:\n  ${unlinkCounts.join('\n  ')}` : '\nNothing to unlink.');

  // ---------------------------------------------------------------- undo on rows that stay
  const touchedJO = new Map(); // JO id -> { built, inspected, delivered, invoiced } to subtract
  const bump = (jo, k, v) => { if (!jo || JO.includes(Number(jo)) || !Number(v)) return; const m = touchedJO.get(Number(jo)) || { built: 0, inspected: 0, delivered: 0, invoiced: 0 }; m[k] += Number(v); touchedJO.set(Number(jo), m); };
  for (const r of await q('SELECT job_order_id, quantity_built FROM assembly_builds WHERE id IN (?)', [IN(AB)])) bump(r.job_order_id, 'built', r.quantity_built);
  for (const r of await q('SELECT qi.job_order_id, SUM(l.pass_qty) p FROM quality_inspections qi JOIN quality_inspection_lines l ON l.quality_inspection_id = qi.id WHERE qi.id IN (?) GROUP BY qi.job_order_id', [IN(QI)])) bump(r.job_order_id, 'inspected', r.p);
  for (const r of await q('SELECT job_order_id, SUM(qty_delivered) d FROM item_delivery_lines WHERE item_delivery_id IN (?) GROUP BY job_order_id', [IN(ID)])) bump(r.job_order_id, 'delivered', r.d);
  // Invoices raised quantity_invoiced only on SO-path lines, and on DT-path lines that carry both
  // a JO and an SO line; estimate-path lines never did.
  for (const r of await q(`SELECT l.job_order_id, SUM(l.quantity) qty FROM sales_invoice_lines l JOIN sales_invoices si ON si.id = l.sales_invoice_id
      WHERE si.id IN (?) AND si.status <> 'cancelled' AND l.job_order_id IS NOT NULL AND l.estimate_job_order_id IS NULL
        AND (si.delivery_ticket_id IS NULL OR l.sales_order_line_id IS NOT NULL) GROUP BY l.job_order_id`, [IN(INV)])) bump(r.job_order_id, 'invoiced', r.qty);
  const abLinesKeptJop = await q(`SELECT l.job_order_process_id, l.item_id, l.location_id, l.total_qty_to_build FROM assembly_build_lines l
      JOIN assembly_builds b ON b.id = l.assembly_build_id WHERE b.id IN (?) AND b.status <> 'cancelled'`, [IN(AB)]);
  const qiOnKeptAB = await q(`SELECT l.assembly_build_id, SUM(l.pass_qty) p, SUM(l.rma_qty) r FROM quality_inspection_lines l
      WHERE l.quality_inspection_id IN (?) AND l.assembly_build_id NOT IN (?) GROUP BY l.assembly_build_id`, [IN(QI), IN(AB)]);
  const cpApps = await q(`SELECT sales_invoice_id, credit_memo_id, applied_amount FROM customer_payment_lines
      WHERE customer_payment_id IN (?) AND ((sales_invoice_id IS NOT NULL AND sales_invoice_id NOT IN (?)) OR credit_memo_id IS NOT NULL)`, [IN(CP), IN(INV)]);
  const keptDeposited = ids(await q('SELECT id FROM customer_payments WHERE deposit_id IN (?) AND id NOT IN (?)', [IN(BD), IN(CP)]));
  const dtToReopen = ids(await q("SELECT delivery_ticket_id id FROM sales_invoices WHERE id IN (?) AND delivery_ticket_id IS NOT NULL AND delivery_ticket_id NOT IN (?) AND status <> 'cancelled'", [IN(INV), IN(DT)]));
  const recKinds = await q('SELECT source_kind, COUNT(*) n FROM bank_reconciliation_matches GROUP BY source_kind');
  const matchIds = ids(await q(`SELECT id FROM bank_reconciliation_matches WHERE
      (source_kind LIKE '%journal%' AND source_id IN (?)) OR (source_kind LIKE '%deposit%' AND source_id IN (?))
      OR (source_kind LIKE '%payment%' AND source_kind NOT LIKE '%bill%' AND source_id IN (?))`, [IN(JL), IN(BD), IN(CP)]));
  const stmtLines = ids(await q('SELECT DISTINCT statement_line_id id FROM bank_reconciliation_matches WHERE id IN (?) UNION SELECT id FROM bank_statement_lines WHERE posted_journal_id IN (?)', [IN(matchIds), IN(JRN)]));
  const soOfTouched = ids(await q('SELECT DISTINCT sales_order_id id FROM job_orders WHERE id IN (?) AND sales_order_id NOT IN (?)', [IN([...touchedJO.keys()]), IN(SO)]));
  const invSoLinks = ids(await q('SELECT id FROM sales_invoices WHERE sales_order_id IN (?) AND id NOT IN (?)', [IN(SO), IN(INV)]));

  console.log('\nMigrated records adjusted:');
  console.log(`  JOs whose built/inspected/delivered/invoiced qty comes back down: ${touchedJO.size}`);
  console.log(`  JO process lines total_built / stock snapshot put back: ${abLinesKeptJop.filter((l) => l.item_id && l.location_id).length} line(s)`);
  console.log(`  ABs that stay with QI pass/RMA taken off: ${qiOnKeptAB.length}`);
  console.log(`  invoice balances restored (payments removed): ${cpApps.filter((a) => a.sales_invoice_id).length}; credit memo applications reversed: ${cpApps.filter((a) => a.credit_memo_id).length}`);
  console.log(`  payments un-deposited: ${keptDeposited.length}; DTs back to open: ${dtToReopen.length}; invoices unlinked from a sample SO: ${invSoLinks.length}`);
  console.log(`  bank reconciliation matches removed: ${matchIds.length}; statement lines back to unmatched: ${stmtLines.length} (match kinds on file: ${recKinds.map((k) => `${k.source_kind} ${k.n}`).join(', ')})`);
  console.log(`  migrated SOs whose status is recalculated: ${soOfTouched.length}`);

  if (!APPLY) { console.log('\nPreview only. Re-run with --apply to delete.'); conn.release(); await pool.end(); return; }
  if (blockers.length) throw new Error('Blockers present -- resolve them first; nothing was changed.');

  await conn.beginTransaction();
  try {
    const run = (sql, params) => conn.query(sql, params);
    // undo on migrated rows
    for (const a of cpApps) {
      if (a.sales_invoice_id) {
        await run("UPDATE sales_invoices SET amount_due = ROUND(amount_due + ?, 2), status = IF(status = 'paid_in_full' AND amount_due + ? > 0.005, 'saved', status) WHERE id = ?",
          [a.applied_amount, a.applied_amount, a.sales_invoice_id]);
      }
      if (a.credit_memo_id) await run('UPDATE credit_memos SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?', [a.applied_amount, a.credit_memo_id]);
    }
    if (keptDeposited.length) await run("UPDATE customer_payments SET deposit_id = NULL, status = 'not_deposited' WHERE id IN (?)", [keptDeposited]);
    if (dtToReopen.length) await run("UPDATE delivery_tickets SET status = 'open' WHERE id IN (?) AND status = 'converted'", [dtToReopen]);
    if (invSoLinks.length) await run('UPDATE sales_invoices SET sales_order_id = NULL WHERE id IN (?)', [invSoLinks]);
    for (const l of abLinesKeptJop) {
      if (!l.item_id || !l.location_id) continue;
      await run('UPDATE inventory_locations SET qty_on_hand = qty_on_hand + ? WHERE inventory_id = ? AND location_id = ?', [l.total_qty_to_build, l.item_id, l.location_id]);
      await run('UPDATE job_order_processes SET total_built = GREATEST(total_built - ?, 0) WHERE id = ? AND job_order_id NOT IN (?)', [l.total_qty_to_build, l.job_order_process_id, IN(JO)]);
    }
    for (const r of qiOnKeptAB) await run('UPDATE assembly_builds SET passed_qty = GREATEST(passed_qty - ?, 0), rma_qty = GREATEST(rma_qty - ?, 0) WHERE id = ?', [r.p, r.r, r.assembly_build_id]);
    for (const [jo, m] of touchedJO) {
      await run(`UPDATE job_orders SET quantity_built = GREATEST(quantity_built - ?, 0), quantity_inspected = GREATEST(quantity_inspected - ?, 0),
          quantity_delivered = GREATEST(quantity_delivered - ?, 0), quantity_invoiced = GREATEST(quantity_invoiced - ?, 0), updated_at = NOW() WHERE id = ?`,
        [m.built, m.inspected, m.delivered, m.invoiced, jo]);
      // Production stage back to what it was before T1S first moved it (imports write no audit).
      const [[first]] = await conn.query("SELECT old_value FROM audit_logs WHERE auditable_type = 'JobOrder' AND auditable_id = ? AND field_name = 'production_stage' ORDER BY set_at, id LIMIT 1", [jo]);
      if (first && first.old_value) await run('UPDATE job_orders SET production_stage = ? WHERE id = ?', [first.old_value, jo]);
    }
    if (matchIds.length) await run('DELETE FROM bank_reconciliation_matches WHERE id IN (?)', [matchIds]);
    if (stmtLines.length) await run("UPDATE bank_statement_lines SET status = 'unmatched', bank_only_account_id = NULL, posted_journal_id = NULL WHERE id IN (?)", [stmtLines]);
    await run('UPDATE non_standard_sales_order_lines SET created_job_order_id = NULL WHERE created_job_order_id IN (?)', [IN(JO)]).catch(() => {});
    for (const [, t, col, set, keep] of UNLINK) {
      if (!set.length) continue;
      await run(`UPDATE ${t} SET ${col} = NULL WHERE ${col} IN (?)${keep ? ` AND ${keep[0]} NOT IN (?)` : ''}`, keep ? [set, IN(keep[1])] : [set])
        .catch((e) => { if (!/doesn't exist|Unknown column/.test(e.message)) throw e; });
    }

    // deletes, children first
    const del = async (label, sql, params) => { const [r] = await conn.query(sql, params); console.log(`  ${label}: ${r.affectedRows}`); };
    console.log('\nDeleting:');
    await del('journal lines', 'DELETE FROM journal_lines WHERE journal_id IN (?)', [IN(JRN)]);
    await del('journals', 'DELETE FROM journals WHERE id IN (?)', [IN(JRN)]);
    await del('bank deposit lines', 'DELETE FROM bank_deposit_lines WHERE deposit_id IN (?)', [IN(BD)]);
    await run('UPDATE customer_payments SET deposit_id = NULL WHERE deposit_id IN (?)', [IN(BD)]);
    await del('bank deposits', 'DELETE FROM bank_deposits WHERE id IN (?)', [IN(BD)]);
    await del('payment lines', 'DELETE FROM customer_payment_lines WHERE customer_payment_id IN (?)', [IN(CP)]);
    await del('customer payments', 'DELETE FROM customer_payments WHERE id IN (?)', [IN(CP)]);
    await del('invoice lines', 'DELETE FROM sales_invoice_lines WHERE sales_invoice_id IN (?)', [IN(INV)]);
    await del('invoices', 'DELETE FROM sales_invoices WHERE id IN (?)', [IN(INV)]);
    await del('DT lines', 'DELETE FROM delivery_ticket_lines WHERE delivery_ticket_id IN (?)', [IN(DT)]);
    await del('DTs', 'DELETE FROM delivery_tickets WHERE id IN (?)', [IN(DT)]);
    await del('ID lines', 'DELETE FROM item_delivery_lines WHERE item_delivery_id IN (?)', [IN(ID)]);
    await del('IDs', 'DELETE FROM item_deliveries WHERE id IN (?)', [IN(ID)]);
    await del('QI lines', 'DELETE FROM quality_inspection_lines WHERE quality_inspection_id IN (?)', [IN(QI)]);
    await del('QIs', 'DELETE FROM quality_inspections WHERE id IN (?)', [IN(QI)]);
    await del('AB lines', 'DELETE FROM assembly_build_lines WHERE assembly_build_id IN (?)', [IN(AB)]);
    await del('ABs', 'DELETE FROM assembly_builds WHERE id IN (?)', [IN(AB)]);
    await run('UPDATE sales_order_lines SET job_order_id = NULL WHERE job_order_id IN (?)', [IN(JO)]);
    await run('UPDATE job_orders SET parent_job_order_id = NULL WHERE parent_job_order_id IN (?) AND id NOT IN (?)', [IN(JO), IN(JO)]);
    const JOP = ids(await q('SELECT id FROM job_order_processes WHERE job_order_id IN (?)', [IN(JO)]));
    await del('JO process sessions', 'DELETE FROM job_order_process_sessions WHERE job_order_process_id IN (?)', [IN(JOP)]);
    await del('JO processes', 'DELETE FROM job_order_processes WHERE job_order_id IN (?)', [IN(JO)]);
    await del('JO attachments', 'DELETE FROM job_order_attachments WHERE job_order_id IN (?)', [IN(JO)]);
    await del('JO layout sessions', 'DELETE FROM job_order_layout_sessions WHERE job_order_id IN (?)', [IN(JO)]);
    await del('JOs', 'DELETE FROM job_orders WHERE id IN (?)', [IN(JO)]);
    await run('UPDATE estimates SET sales_order_id = NULL WHERE sales_order_id IN (?)', [IN(SO)]);
    await del('SO attachments', 'DELETE FROM sales_order_attachments WHERE sales_order_id IN (?)', [IN(SO)]);
    await del('SO lines', 'DELETE FROM sales_order_lines WHERE sales_order_id IN (?)', [IN(SO)]);
    await del('SOs', 'DELETE FROM sales_orders WHERE id IN (?)', [IN(SO)]);
    const EJO = ids(await q('SELECT id FROM estimate_job_orders WHERE estimate_id IN (?)', [IN(EST)]));
    await del('estimate processes', 'DELETE FROM estimate_job_order_processes WHERE estimate_job_order_id IN (?)', [IN(EJO)]);
    await del('estimate job lines', 'DELETE FROM estimate_job_orders WHERE estimate_id IN (?)', [IN(EST)]);
    await del('estimate addresses', 'DELETE FROM estimate_shipping_addresses WHERE estimate_id IN (?)', [IN(EST)]);
    await del('estimate attachments', 'DELETE FROM estimate_attachments WHERE estimate_id IN (?)', [IN(EST)]);
    await del('estimates', 'DELETE FROM estimates WHERE id IN (?)', [IN(EST)]);
    for (const [type, set] of [['Estimate', EST], ['JobOrder', JO], ['AssemblyBuild', AB], ['QualityInspection', QI], ['ItemDelivery', ID],
      ['DeliveryTicket', DT], ['SalesInvoice', INV], ['CustomerPayment', CP], ['BankDeposit', BD], ['Journal', JRN]]) {
      if (set.length) await run('DELETE FROM audit_logs WHERE auditable_type = ? AND auditable_id IN (?)', [type, set]);
    }
    await run("DELETE FROM notifications WHERE related_type = 'JobOrder' AND related_id IN (?)", [IN(JO)]);

    // SO status from the adjusted JO quantities -- only for migrated SOs a sample touched.
    for (const soId of soOfTouched) {
      const lines = await q(`SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
          FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`, [soId]);
      await run('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [computeSalesOrderStatus(lines), soId]);
    }
    await conn.commit();
    console.log('\nCommitted.');
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally { conn.release(); }
  await pool.end();
}

main().catch(async (e) => { console.error('FAILED:', e.message); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
