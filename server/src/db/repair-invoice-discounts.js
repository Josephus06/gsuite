// Restores the discount and withholding the first migration dropped from invoices.
//
// import-sales.js read neither: each line's Net of Tax was saved as its PRE-discount sub total and
// the header's discount and EWT as nothing. INV-82382 is the pattern -- a line of 80 x 10.98 =
// 878.40 under a 640.00 invoice, because the source discounted it 27.14% (238.40) and withheld
// 12.80. The header totals were right all along (they came from the source's own figures), so
// Net of Tax, Tax, Gross and Amount Due are NOT touched here, and nothing in the GL, AR or
// payments moves. What changes: the header's Sub Total / Discount / EWT, and each line's
// discount fields and Net of Tax.
//
// Scope: migrated invoices (no creator) whose lines do not sum to the header's Net of Tax -- the
// visible symptom. An invoice is only written when the source agrees on its net and its lines
// match one-for-one by quantity and price; everything else is reported and left alone.
//
// Droplet and office replicate: run on ONE of them. Railway: its own run.
//
//   node src/db/repair-invoice-discounts.js --dry-run      report only
//   node src/db/repair-invoice-discounts.js [--limit=N]    write
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const CONCURRENCY = 4;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const near = (a, b, tol = 0.02) => Math.abs(num(a) - num(b)) <= tol;

let token;
async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  token = (await r.json())?.data?.token;
  if (!token) throw new Error('Source system login failed.');
}
async function call(ep, payload) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await fetch(`${SITE}/api/${ep}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return await r.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
}

// invoice no -> source SysPK, from one pass over the source list (far fewer calls than a search
// per invoice).
async function sourceKeys(wanted) {
  const map = new Map();
  // A handful (a --limit trial run) is cheaper looked up one by one.
  if (wanted.size <= 50) {
    for (const no of wanted) {
      const j = await call('get_invoices', { searchKey: no, limit: 20, offset: 0 });
      const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (j?.data || []);
      const hit = rows.find((x) => x.invc_pk === no);
      if (hit) map.set(no, hit.SysPK_TransH);
    }
    return map;
  }
  for (let offset = 0; ; offset += 200) {
    const j = await call('get_invoices', { searchKey: '', limit: 200, offset });
    const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (j?.data || []);
    if (!rows.length) break;
    for (const x of rows) if (wanted.has(x.invc_pk)) map.set(x.invc_pk, x.SysPK_TransH);
    if (offset % 20000 === 0) console.log(`  source list: ${offset + rows.length} read, ${map.size} matched`);
  }
  return map;
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? '  (DRY RUN)' : ''}`);
  const [cands] = await pool.query(
    `SELECT si.id, si.invoice_no, si.net_of_tax
       FROM sales_invoices si
       JOIN (SELECT sales_invoice_id, SUM(net_of_tax) AS s FROM sales_invoice_lines GROUP BY sales_invoice_id) x
         ON x.sales_invoice_id = si.id
      WHERE si.created_by_user_id IS NULL AND ABS(x.s - si.net_of_tax) > 0.05
      ORDER BY si.id DESC`
  );
  const list = cands.slice(0, LIMIT);
  console.log(`  ${cands.length} invoice(s) whose lines do not sum to the header${list.length < cands.length ? `; doing ${list.length}` : ''}`);

  await login();
  const keys = await sourceKeys(new Set(list.map((c) => c.invoice_no)));
  const out = { fixed: 0, notInSource: 0, headerDisagrees: 0, linesDisagree: 0, errors: 0 };
  const skipped = [];
  let done = 0;

  async function one(c) {
    const pk = keys.get(c.invoice_no);
    if (!pk) { out.notInSource += 1; return; }
    const d = await call('get_invoice', { pk });
    const h = Array.isArray(d?.data?.[0]) ? d.data[0][0] : d?.data?.[0];
    const src = d?.data?.[1] || [];
    if (!h || !near(h.SubTotalVatEx_TransH, c.net_of_tax, 0.05)) {
      out.headerDisagrees += 1; skipped.push(`${c.invoice_no} header net ${c.net_of_tax} vs source ${h?.SubTotalVatEx_TransH}`); return;
    }
    const [lines] = await pool.query(
      'SELECT id, quantity, price_per_unit FROM sales_invoice_lines WHERE sales_invoice_id = ? ORDER BY id', [c.id]);
    const aligned = lines.length === src.length
      && lines.every((l, i) => near(l.quantity, src[i].Qty_LdgrInvty, 0.0001) && near(l.price_per_unit, src[i].Price_LdgrInvty, 0.0001));
    if (!aligned) {
      out.linesDisagree += 1; skipped.push(`${c.invoice_no} lines ${lines.length} here vs ${src.length} in source`); return;
    }
    const net = num(h.SubTotalVatEx_TransH);
    const ewt = num(h.WTAXAmount_TransH);
    if (DRY) { out.fixed += 1; return; }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'UPDATE sales_invoices SET subtotal = ?, discount_amount = ?, ewt_amount = ?, withholding_tax_pct = ? WHERE id = ?',
        [num(h.SubTotal_TransH) || net, num(h.DiscountAmount_TransH), ewt,
          net > 0 ? Math.round((ewt / net) * 1000000) / 10000 : 0, c.id]);
      for (let i = 0; i < lines.length; i += 1) {
        const s = src[i];
        await conn.query(
          `UPDATE sales_invoice_lines
              SET disc_percent = ?, disc_amount = ?, disc_price_per_unit = ?, net_of_tax = ?, tax_amount = ?, gross_amount = ?
            WHERE id = ?`,
          [num(s.DiscountPercent_LdgrInvty), num(s.DiscountAmount_LdgrInvty),
            Math.round((num(s.Price_LdgrInvty) - num(s.DiscountRate_LdgrInvty)) * 1e6) / 1e6,
            num(s.Total_LdgrInvty), num(s.TaxAmount_LdgrInvty), num(s.TotalAmountOut_LdgrInvty), lines[i].id]);
      }
      await conn.commit();
      out.fixed += 1;
    } catch (e) {
      await conn.rollback(); out.errors += 1; skipped.push(`${c.invoice_no} error ${e.message}`);
    } finally { conn.release(); }
  }

  const queue = [...list];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const c = queue.shift();
      try { await one(c); } catch (e) { out.errors += 1; skipped.push(`${c.invoice_no} error ${e.message}`); }
      done += 1;
      if (done % 500 === 0) console.log(`  ${done}/${list.length}`, JSON.stringify(out));
    }
  }));

  console.log(`  ${DRY ? 'would fix' : 'fixed'}: ${out.fixed}`, JSON.stringify(out));
  if (skipped.length) console.log('  skipped (first 20):\n   ' + skipped.slice(0, 20).join('\n   '));
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
