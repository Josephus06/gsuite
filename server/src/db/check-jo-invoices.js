// Job orders the SOURCE has invoiced but T1S shows as not invoiced (asked 2026-10-28, a list of 51).
// For each JO number: the source's invoices billing it -- every source invoice line carries its JO
// number (UserPK_TransH) -- against what T1S has, and which of three things is wrong:
//
//   MISSING    the source invoice is not in T1S at all
//              -> node src/db/import-invoices-by-number.js INV-1,INV-2 --dry-run   (then without)
//   UNLINKED   the invoice is in T1S, but none of its lines names this JO, so Pending Billing and
//              the JO read as never billed
//              -> node src/db/relink-invoice-lines-from-source.js --invoice=INV-1   (then --apply)
//   CANCELLED  the invoice is in T1S but cancelled there, while live in the source
//   DT LINES   billed by a delivery ticket the source CONVERTED into no invoice (a 0.00 sponsorship),
//              whose lines T1S never took in
//              -> node src/db/backfill-converted-dt-lines.js   (then --apply)
//
// READ-ONLY, here and against the source. It prints the commands to run for what it finds.
//
//   node src/db/check-jo-invoices.js JO-24604-10-10,JO-28446-3-3
//   node src/db/check-jo-invoices.js --file=jos.txt
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const L = require('./lib/liveWindow');

const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1];
const listArg = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(',');
const JOS = [...new Set((fileArg ? fs.readFileSync(fileArg, 'utf8') : listArg).split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(t, ep, payload) {
  for (let a = 0; a < 4; a += 1) {
    try { return await L.api(t, ep, payload); } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return null;
}

(async () => {
  if (!JOS.length) { console.error('Give JO numbers: JO-1-1-1,JO-2-1-1 or --file=path'); process.exit(2); }
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- READ ONLY. ${JOS.length} job order(s).\n`);
  const t = await L.login();
  const soInvoices = new Map(); // source SO number -> [{ no, status, lines }]
  const missing = new Set(); const unlinked = new Set(); const dtLinesMissing = new Set();
  const tally = { ok: 0, missing: 0, unlinked: 0, cancelled: 0, notInvoicedInSource: 0, joNotInT1s: 0, soNotInSource: 0 };

  for (const joNo of JOS) {
    const soNo = (/^JO-(\d+)-/.exec(joNo) || [])[1] ? `SO-${/^JO-(\d+)-/.exec(joNo)[1]}` : null;
    const [[jo]] = await pool.query(
      `SELECT jo.id, jo.quantity, jo.quantity_invoiced, jo.status, so.sales_order_no, so.status AS so_status
         FROM job_orders jo LEFT JOIN sales_orders so ON so.id = jo.sales_order_id WHERE jo.job_order_no = ?`, [joNo]);
    const out = [];
    if (!jo) { tally.joNotInT1s += 1; console.log(`${joNo}: NOT IN T1S`); continue; }

    // The source's invoices on the JO's sales order, each with its lines (cached per order).
    if (soNo && !soInvoices.has(soNo)) {
      const soHead = L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: soNo, Module_TransH: 'SALESORDER' }, limit: 1 }))[0];
      const list = [];
      if (soHead) {
        // Invoices raised on the order itself...
        const heads = L.listRows(await api(t, 'get_transactions', { where: { SysFK_TransHSO_TransH: soHead.SysPK_TransH, Module_TransH: 'INVC' }, limit: 100 }));
        for (const h of heads) {
          const inv = await api(t, 'get_invoice', { pk: h.SysPK_TransH });
          list.push({ no: h.UserPK_TransH, status: h.Status_TransH, void: L.isVoidOrCancelled(h.Status_TransH), lines: inv?.data?.[1] || [] });
        }
        // ...and through its Delivery Tickets: a CONVERTED ticket became an invoice whose sl_pk is the
        // ticket's number (import-delivery-tickets.js); an OPEN one still holds its own lines.
        const dts = L.listRows(await api(t, 'get_transactions', { where: { SysFK_TransHSO_TransH: soHead.SysPK_TransH, Module_TransH: 'DELIVERYTICKET' }, limit: 100 }));
        for (const dt of dts) {
          if (L.isVoidOrCancelled(dt.Status_TransH)) continue;
          if (/CONVERT/i.test(dt.Status_TransH || '')) {
            const cands = L.listRows(await api(t, 'get_invoices', { searchKey: dt.UserPK_TransH, limit: 20, offset: 0 })).filter((iv) => iv.sl_pk === dt.UserPK_TransH);
            if (!cands.length) {
              // Converted into no invoice (a 0.00 sponsorship ticket): the ticket itself is the billing.
              const det = await api(t, 'get_invoice', { pk: dt.SysPK_TransH });
              list.push({ no: dt.UserPK_TransH, convertedDt: true, status: dt.Status_TransH, void: false, lines: det?.data?.[1] || [] });
            }
            for (const c of cands) {
              if (list.some((x) => x.no === c.invc_pk)) continue;
              const inv = await api(t, 'get_invoice', { pk: c.SysPK_TransH });
              list.push({ no: c.invc_pk, via: dt.UserPK_TransH, status: c.Status_TransH, void: L.isVoidOrCancelled(c.Status_TransH), lines: inv?.data?.[1] || [] });
            }
          } else {
            const det = await api(t, 'get_invoice', { pk: dt.SysPK_TransH });
            list.push({ no: dt.UserPK_TransH, openDt: true, status: dt.Status_TransH, void: false, lines: det?.data?.[1] || [] });
          }
        }
      }
      soInvoices.set(soNo, soHead ? list : null);
    }
    const srcList = soNo ? soInvoices.get(soNo) : null;
    if (srcList === null || srcList === undefined) { tally.soNotInSource += 1; console.log(`${joNo}: ${soNo || 'its SO'} not found in the source`); continue; }
    const names = (i) => i.lines.some((l) => String(l.UserPK_TransH || '').trim().toUpperCase() === joNo);
    const billing = srcList.filter((i) => !i.void && !i.openDt && names(i));
    const openDts = srcList.filter((i) => i.openDt && names(i));
    if (!billing.length) {
      if (openDts.length) { tally.openDtOnly = (tally.openDtOnly || 0) + 1; console.log(`${joNo}: only on OPEN delivery ticket ${openDts.map((i) => i.no).join(', ')} in the source -- not invoiced there yet`); continue; }
      tally.notInvoicedInSource += 1;
      console.log(`${joNo}: no live source invoice names this JO (source invoices on ${soNo}: ${srcList.map((i) => `${i.no}${i.via ? ` via ${i.via}` : ''}${i.void ? ' void' : ''}${i.openDt ? ' open DT' : ''}`).join(', ') || 'none'})`);
      continue;
    }

    for (const src of billing) {
      const qty = src.lines.filter((l) => String(l.UserPK_TransH || '').trim().toUpperCase() === joNo).reduce((n, l) => n + Number(l.Qty_LdgrInvty || 0), 0);
      if (src.convertedDt) {
        const [[dtLine]] = await pool.query(
          `SELECT COUNT(*) AS n FROM delivery_ticket_lines l JOIN delivery_tickets d ON d.id = l.delivery_ticket_id
            WHERE d.dt_no = ? AND l.job_order_id = ?`, [src.no, jo.id]);
        if (dtLine.n) { out.push(`${src.no} (converted, no invoice) ok`); tally.ok += 1; }
        else { out.push(`${src.no} (qty ${qty}) converted with no invoice -- its lines are not in T1S`); dtLinesMissing.add(src.no); tally.dtLinesMissing = (tally.dtLinesMissing || 0) + 1; }
        continue;
      }
      const [[mine]] = await pool.query('SELECT id, status, sales_order_id FROM sales_invoices WHERE invoice_no = ?', [src.no]);
      if (!mine) { out.push(`${src.no} (qty ${qty}) MISSING from T1S`); missing.add(src.no); tally.missing += 1; continue; }
      if (mine.status === 'cancelled') { out.push(`${src.no} CANCELLED in T1S, live in the source (${src.status})`); tally.cancelled += 1; continue; }
      const [[linked]] = await pool.query('SELECT COUNT(*) AS n FROM sales_invoice_lines WHERE sales_invoice_id = ? AND job_order_id = ?', [mine.id, jo.id]);
      if (!linked.n) { out.push(`${src.no} (qty ${qty}) in T1S but its lines do not name this JO`); unlinked.add(src.no); tally.unlinked += 1; continue; }
      out.push(`${src.no} ok`); tally.ok += 1;
    }
    console.log(`${joNo} [${jo.sales_order_no || '-'} ${jo.so_status || ''}; T1S invoiced ${Number(jo.quantity_invoiced || 0)}/${Number(jo.quantity || 0)}]: ${out.join('; ')}`);
  }

  console.log(`\nSummary: ${JSON.stringify(tally)}`);
  if (missing.size) console.log(`\nMissing invoices -- import them (dry run first):\n  node src/db/import-invoices-by-number.js ${[...missing].join(',')} --dry-run`);
  if (dtLinesMissing.size) {
    console.log(`\nConverted delivery tickets that became no invoice, missing their lines -- bring them in (dry run first):\n  node src/db/backfill-converted-dt-lines.js${dtLinesMissing.size === 1 ? ` --only=${[...dtLinesMissing][0]}` : ''}`);
  }
  if (unlinked.size) {
    console.log('\nInvoices whose lines are not linked to the JO -- preview each, then add --apply:');
    for (const n of unlinked) console.log(`  node src/db/relink-invoice-lines-from-source.js --invoice=${n}`);
  }
  await pool.end();
})().catch(async (e) => { console.error('ERR', e.message); await pool.end(); process.exit(1); });
