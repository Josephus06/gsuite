// READ-ONLY. Cheques and Bill Payments whose Date is in the future.
//
// The Date is the day the payment was issued, and it is what places the payment in a period -- in
// the GL, the disbursement report and the lists' date sort. Recent cheques carry Dates weeks or
// years ahead (05 Dec 2026, 27 Dec 2028), which looks like a post-dated cheque's own date typed
// into Date instead of Cheque Date. This lists them, with who entered each, for accounting to
// correct; it changes nothing.
//
//   node src/db/list-future-dated-payments.js [--today=2026-10-02] [--out=future.csv]
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const OUT = arg('out', null);
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');

(async () => {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- dated after ${TODAY}\n`);
  const [cheques] = await pool.query(
    `SELECT 'Cheque' AS kind, c.cheque_no AS no, c.date_created, c.cheque_date, c.cheque_number AS check_no,
            c.payee_name AS payee, c.total_amount, c.status, c.date_released, u.display_name AS entered_by, c.created_at
       FROM cheques c LEFT JOIN users u ON u.id = c.created_by_user_id
      WHERE c.date_created > ? AND c.status <> 'void' ORDER BY c.date_created DESC`, [TODAY]);
  const [payments] = await pool.query(
    `SELECT 'Bill Payment' AS kind, bp.bill_payment_no AS no, bp.date_created, bp.check_date AS cheque_date, bp.check_no,
            COALESCE(s.name, bp.payee_name) AS payee, bp.total_amount, bp.status, bp.date_released, u.display_name AS entered_by, bp.created_at
       FROM bill_payments bp LEFT JOIN suppliers s ON s.id = bp.supplier_id LEFT JOIN users u ON u.id = bp.created_by_user_id
      WHERE bp.date_created > ? AND bp.status <> 'voided' ORDER BY bp.date_created DESC`, [TODAY]);
  const all = [...cheques, ...payments];
  const total = (list) => list.reduce((s, r) => s + Number(r.total_amount || 0), 0).toFixed(2);
  console.log(`Cheques dated in the future: ${cheques.length} (${total(cheques)})`);
  console.log(`Bill Payments dated in the future: ${payments.length} (${total(payments)})\n`);
  for (const r of all) {
    const same = day(r.date_created) === day(r.cheque_date) ? ' (Date = Cheque Date)' : '';
    console.log(`  ${r.kind.padEnd(12)} ${String(r.no).padEnd(11)} Date ${day(r.date_created)}  Cheque Date ${day(r.cheque_date) || '-'}${same}  ${String(r.payee || '').slice(0, 30).padEnd(30)} ${Number(r.total_amount).toFixed(2).padStart(13)}  ${r.date_released ? 'released ' + day(r.date_released) : 'not released'}  by ${r.entered_by || '(imported)'} on ${day(r.created_at)}`);
  }
  if (OUT) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = 'Type,Number,Date,Cheque Date,Check #,Payee,Amount,Status,Date Released,Entered By,Entered On';
    fs.writeFileSync(OUT, [head, ...all.map((r) => [r.kind, r.no, day(r.date_created), day(r.cheque_date), r.check_no, r.payee,
      Number(r.total_amount).toFixed(2), r.status, day(r.date_released), r.entered_by || '(imported)', day(r.created_at)].map(esc).join(','))].join('\n'));
    console.log(`\nCSV -> ${OUT}`);
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
