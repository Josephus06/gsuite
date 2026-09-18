// One-off migration: writes the missing REVERSAL journal for every document that is already
// voided and has none.
//
//   node src/db/backfill-void-reversal-journals.js --dry-run
//   node src/db/backfill-void-reversal-journals.js
//
// WHY IT IS REQUIRED, not optional. lib/glImpact.js used to model a void by dropping the document
// out of the ledger walk. It no longer does -- a voided document keeps posting and its REVERSAL
// journal cancels it (lib/reversalJournal.js). Run the code without this backfill and every
// already-voided document starts posting an entry that nothing reverses: 81 cancelled invoices,
// 19 void tickets and 22 void cheques would simply appear in the general ledger. So this runs
// BEFORE the code that depends on it, exactly like any other additive migration.
//
// DATING. Not one of these documents carries a void date -- all 690 void cheques, all 81 cancelled
// invoices and all 19 void tickets have NULL in voided_at/cancelled_at, because the live import
// never brought one across. lib/reversalJournal.js therefore dates a backfilled reversal at the
// DOCUMENT'S OWN date, which puts it in the same period as the entry it cancels. The consequence
// is deliberate and worth stating plainly: every past period keeps the figures it has today,
// because each of these nets to zero inside its own month exactly as it did when the document was
// simply excluded. Only voids made from now on land in the period of the void, which is the
// behaviour this whole change exists to restore.
//
// Idempotent -- postReversalJournal skips any document that already has a live journal against it,
// so the 668 imported cheque reversals are left exactly as they are. Safe to re-run.
const pool = require('../db');
const { postReversalJournal } = require('../lib/reversalJournal');
const { computeSalesInvoiceGl, computeDeliveryTicketGl, computeChequeGl } = require('../lib/glImpact');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

// Each kind: how to find the voided documents missing a reversal, how to read one's lines, and
// how to compute the entry being reversed.
const KINDS = [
  {
    sourceType: 'sales_invoice',
    label: 'Sales Invoices (cancelled)',
    headers: `SELECT si.* FROM sales_invoices si
               WHERE si.status = 'cancelled'
                 AND NOT EXISTS (SELECT 1 FROM journals j
                                  WHERE j.source_type = 'sales_invoice' AND j.source_id = si.id AND j.status <> 'void')
               ORDER BY si.id`,
    lines: 'SELECT * FROM sales_invoice_lines WHERE sales_invoice_id = ?',
    no: (d) => d.invoice_no,
    locationId: (d) => d.office_location_id || null,
    gl: (d, lines) => computeSalesInvoiceGl(d, lines),
  },
  {
    sourceType: 'delivery_ticket',
    label: 'Delivery Tickets (void)',
    headers: `SELECT dt.*, so.office_location_id FROM delivery_tickets dt
                JOIN sales_orders so ON so.id = dt.sales_order_id
               WHERE dt.status = 'void'
                 AND NOT EXISTS (SELECT 1 FROM journals j
                                  WHERE j.source_type = 'delivery_ticket' AND j.source_id = dt.id AND j.status <> 'void')
               ORDER BY dt.id`,
    lines: 'SELECT * FROM delivery_ticket_lines WHERE delivery_ticket_id = ?',
    no: (d) => d.dt_no,
    locationId: (d) => d.office_location_id || null,
    gl: (d, lines) => computeDeliveryTicketGl(d, lines),
  },
  {
    sourceType: 'cheque',
    label: 'Cheques (void)',
    headers: `SELECT c.*, coa.account_code AS bank_code, coa.account_name AS bank_name FROM cheques c
                LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
               WHERE c.status = 'void'
                 AND NOT EXISTS (SELECT 1 FROM journals j
                                  WHERE j.source_type = 'cheque' AND j.source_id = c.id AND j.status <> 'void')
               ORDER BY c.id`,
    lines: `SELECT cl.amount, cl.department_id, coa.account_code, coa.account_name
              FROM cheque_lines cl LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
             WHERE cl.cheque_id = ? ORDER BY cl.line_no`,
    no: (d) => d.cheque_no,
    locationId: (d) => d.office_location_id || null,
    gl: (d, lines) => computeChequeGl(d, lines),
  },
];

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Database: ${db} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  let grandTotal = 0;
  let grandAmount = 0;

  for (const kind of KINDS) {
    const [docs] = await pool.query(kind.headers);
    console.log(`${kind.label}: ${docs.length} needing a reversal`);

    let written = 0;
    let skipped = 0;
    let amount = 0;

    for (const doc of docs) {
      const [lines] = await pool.query(kind.lines, [doc.id]);
      const glRows = await kind.gl(doc, lines);
      const value = glRows.reduce((s, r) => s + (Number(r.debit) || 0), 0);

      if (DRY_RUN) {
        // Still reports the empty ones -- a document with no computable entry is the one case
        // where nothing gets written and the reader should know which.
        if (!glRows.length) { skipped += 1; continue; }
        written += 1;
        amount += value;
        continue;
      }

      // One transaction per document: 122 independent entries, and a single bad row should not
      // cost the other 121. Each is idempotent on its own.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const res = await postReversalJournal(conn, {
          sourceType: kind.sourceType,
          sourceId: doc.id,
          sourceNo: kind.no(doc),
          glRows,
          documentDate: doc.date_created,
          voidedAt: null, // none recorded -- see the note at the top
          reason: 'Backfilled: voided before reversal journals were posted',
          userId: null,
          locationId: kind.locationId(doc),
        });
        await conn.commit();
        if (res) { written += 1; amount += value; console.log(`  + ${res.journalNo} reverses ${kind.no(doc)} (${value.toFixed(2)})`); }
        else { skipped += 1; }
      } catch (err) {
        await conn.rollback();
        console.error(`  !! ${kind.no(doc)} failed: ${err.message}`);
      } finally {
        conn.release();
      }
    }

    console.log(`  ${DRY_RUN ? 'would write' : 'wrote'} ${written}, skipped ${skipped} (nothing to reverse), ${amount.toFixed(2)} total\n`);
    grandTotal += written;
    grandAmount += amount;
  }

  console.log(`${DRY_RUN ? 'Would write' : 'Wrote'} ${grandTotal} reversal journals, ${grandAmount.toFixed(2)} total.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
