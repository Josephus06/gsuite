// Plan the Job Order link for migrated invoice lines that have none (sales_invoice_lines.job_order_id
// NULL -- 16,364 lines on 2026-10-01), from the source's own invoice lines, which name the JO they
// bill (UserPK_TransH on get_invoice's lines).
//
// A T1S line is paired with a source line by position when the invoice has the same number of lines
// in both, otherwise by description + quantity. Only a line with no JO yet, whose JO exists in T1S,
// is planned. Writes an ops file for apply-ops.js ({table, id, set, expect}) -- nothing is written
// to the database here.
//
// READ-ONLY (source and T1S).
//   node src/db/plan-invoice-line-jo-links.js --out=/root/match2026/links-ops.json [--from=2026-01-01]
const fs = require('fs');
const pool = require('../db');
require('dotenv').config();
const L = require('./lib/liveWindow');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const OUT = arg('out', '/root/match2026/links-ops.json');
const FROM = arg('from', '2000-01-01');
const CONCURRENCY = 4;
const clean = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function main() {
  const [invs] = await pool.query(
    `SELECT DISTINCT si.id, si.invoice_no FROM sales_invoices si JOIN sales_invoice_lines sil ON sil.sales_invoice_id = si.id
      WHERE sil.job_order_id IS NULL AND si.status <> 'cancelled' AND si.customer_id IS NULL AND si.nsso_id IS NULL
        AND si.date_created >= ? ORDER BY si.id`, [FROM]);
  const [jos] = await pool.query('SELECT id, job_order_no FROM job_orders');
  const joByNo = new Map(jos.map((j) => [j.job_order_no.toUpperCase(), j.id]));
  console.log(`${invs.length} invoice(s) with unlinked lines since ${FROM}`);
  let t = await L.login();
  const ops = [];
  const out = { invoices: 0, linked: 0, noSourceJo: 0, joNotInT1S: 0, unmatched: 0, notFound: 0, failed: 0 };
  let cursor = 0, since = 0;
  async function worker() {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= invs.length) return;
      const inv = invs[i];
      if ((since += 1) >= 400) { since = 0; t = await L.login(); }
      try {
        const h = L.listRows(await L.api(t, 'get_transactions', { where: { UserPK_TransH: inv.invoice_no, Module_TransH: 'INVC' }, limit: 1 }))[0];
        if (!h) { out.notFound += 1; continue; }
        const d = await L.api(t, 'get_invoice', { pk: h.SysPK_TransH });
        const src = (d.data?.[1] || []).map((l) => ({ jo: l.UserPK_TransH ? String(l.UserPK_TransH).toUpperCase() : null, desc: clean(l.DisplayDescription_LdgrInvty), qty: num(l.Qty_LdgrInvty) }));
        const [mine] = await pool.query('SELECT id, job_order_id, description, quantity FROM sales_invoice_lines WHERE sales_invoice_id = ? ORDER BY id', [inv.id]);
        const used = new Set();
        const byPosition = src.length === mine.length;
        mine.forEach((m, idx) => {
          if (m.job_order_id) return;
          let s = byPosition ? src[idx] : null;
          if (!s) {
            const k = src.findIndex((x, j) => !used.has(j) && x.desc === clean(m.description) && Math.abs(x.qty - num(m.quantity)) < 1e-6);
            if (k >= 0) { used.add(k); s = src[k]; }
          }
          if (!s) { out.unmatched += 1; return; }
          if (!s.jo) { out.noSourceJo += 1; return; }
          const joId = joByNo.get(s.jo);
          if (!joId) { out.joNotInT1S += 1; return; }
          ops.push({ table: 'sales_invoice_lines', id: m.id, no: `${inv.invoice_no}/${s.jo}`, set: { job_order_id: joId }, expect: { job_order_id: null } });
          out.linked += 1;
        });
        out.invoices += 1;
      } catch (e) { out.failed += 1; }
      if (out.invoices && out.invoices % 500 === 0) console.log(`  ...${out.invoices} invoices, ${out.linked} lines planned`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(OUT, JSON.stringify(ops));
  console.log(JSON.stringify(out));
  console.log(`planned ${ops.length} link(s) -> ${OUT}`);
  await pool.end();
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
