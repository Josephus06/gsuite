// Re-point 2026 invoice lines at the Job Order the SOURCE says they billed, and the invoice at the
// Sales Order the source raised it from.
//
// Found 2026-10-02 from JO-70419-4-12, "invoiced in the source but Pending Billing here". The source
// billed its 169 pcs on INV-81375, but in T1S that invoice carried sales_order_id 74691 and
// job_order_id 133441 -- ids that exist in no table (written through from another database
// without remapping). Pending Billing counts a JO as invoiced from the invoice LINES that name it,
// so the JO read as never billed. Across live 2026 invoices:
//   95 invoices point at a sales order id that does not exist (219 lines at a JO that does not),
//   1,654 lines name no JO at all,
//   and lines name the WRONG JO of the right order (INV-82385 / INV-82217 bill items 5251/5256 and
//   CR2032 but point at JO-70419-1-12).
// Every source invoice line carries its JO number (UserPK_TransH = 'JO-70419-12-12'), so that is
// the authority: each T1S line is matched to its source line and given that JO's T1S id.
//
// Lines are matched by position when both sides have the same count and quantities agree line for
// line; otherwise by quantity + description, then quantity alone when unique. An invoice is skipped
// whole when its T1S gross differs from the source's -- that is not the same document (a T1S-native
// invoice that took a source number, see doc-number collisions) and ERP-native rows must win.
// Never writes a JO number T1S does not hold; such lines are reported.
//
//   node src/db/relink-invoice-lines-from-source.js                     # preview, suspect 2026 invoices
//   node src/db/relink-invoice-lines-from-source.js --invoice=INV-81375 # preview one
//   node src/db/relink-invoice-lines-from-source.js --apply             # backs up to /root/match2026/
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const L = require('./lib/liveWindow');

const APPLY = process.argv.includes('--apply');
const ONE = (process.argv.find((a) => a.startsWith('--invoice=')) || '').split('=')[1] || null;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(t, ep, payload) {
  for (let a = 0; a < 4; a += 1) {
    try { return await L.api(t, ep, payload); } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return null;
}

function matchLines(mine, src) {
  const out = new Map(); // T1S line id -> source line
  const sameQty = (m, s) => Math.abs(num(m.quantity) - num(s.Qty_LdgrInvty)) < 0.0001;
  if (mine.length === src.length && mine.every((m, i) => sameQty(m, src[i]))) {
    mine.forEach((m, i) => out.set(m.id, src[i]));
    return out;
  }
  const free = [...src];
  for (const m of mine) {
    let k = free.findIndex((s) => sameQty(m, s) && norm(s.DisplayDescription_LdgrInvty) === norm(m.description));
    if (k < 0) {
      const byQty = free.filter((s) => sameQty(m, s));
      if (byQty.length === 1) k = free.indexOf(byQty[0]);
    }
    if (k >= 0) { out.set(m.id, free[k]); free.splice(k, 1); }
  }
  return out;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const [targets] = ONE
    ? await pool.query('SELECT id, invoice_no, sales_order_id, gross_amount FROM sales_invoices WHERE invoice_no = ?', [ONE])
    : await pool.query(
      `SELECT DISTINCT si.id, si.invoice_no, si.sales_order_id, si.gross_amount
         FROM sales_invoices si
         JOIN sales_invoice_lines sil ON sil.sales_invoice_id = si.id
         LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
         LEFT JOIN sales_orders so ON so.id = si.sales_order_id
        WHERE si.date_created >= '2026-01-01' AND si.status <> 'cancelled'
          AND (sil.job_order_id IS NULL OR jo.id IS NULL OR (si.sales_order_id IS NOT NULL AND so.id IS NULL)
               OR TRIM(UPPER(jo.description)) <> TRIM(UPPER(sil.description)))
        ORDER BY si.id`);
  console.log(`Invoices to check: ${targets.length}`);

  const t = await L.login();
  const stats = { checked: 0, notInSource: 0, totalDiffers: 0, headerFix: 0, lineFix: 0, unmatched: 0, joNotInT1s: 0, invoicesChanged: 0 };
  const changes = []; const unknownJo = new Map(); const samples = [];
  const joCache = new Map(); const soCache = new Map();
  const joId = async (no) => {
    if (!joCache.has(no)) { const [[r]] = await pool.query('SELECT id, sales_order_id FROM job_orders WHERE job_order_no = ?', [no]); joCache.set(no, r || null); }
    return joCache.get(no);
  };
  const soId = async (no) => {
    if (!soCache.has(no)) { const [[r]] = await pool.query('SELECT id FROM sales_orders WHERE sales_order_no = ?', [no]); soCache.set(no, r ? r.id : null); }
    return soCache.get(no);
  };

  for (const inv of targets) {
    stats.checked += 1;
    if (stats.checked % 100 === 0) process.stdout.write(`\r  ${stats.checked}/${targets.length}`);
    const head = L.listRows(await api(t, 'get_transactions', { where: { UserPK_TransH: inv.invoice_no, Module_TransH: 'INVC' }, limit: 1 }))[0];
    if (!head) { stats.notInSource += 1; continue; }
    if (Math.abs(num(head.TotalAmount_TransH) - num(inv.gross_amount)) > 0.05) { stats.totalDiffers += 1; continue; }
    const det = await api(t, 'get_invoice', { pk: head.SysPK_TransH });
    const src = det?.data?.[1] || [];
    const [mine] = await pool.query('SELECT id, job_order_id, description, quantity FROM sales_invoice_lines WHERE sales_invoice_id = ? ORDER BY id', [inv.id]);

    const change = { invoice_id: inv.id, invoice_no: inv.invoice_no, old_sales_order_id: inv.sales_order_id, new_sales_order_id: null, lines: [] };
    if (head.SysFK_TransHSO_TransH) {
      const parent = L.listRows(await api(t, 'get_transactions', { where: { SysPK_TransH: head.SysFK_TransHSO_TransH }, limit: 1 }))[0];
      if (parent && parent.Module_TransH === 'SALESORDER') {
        const id = await soId(parent.UserPK_TransH);
        if (id && id !== inv.sales_order_id) change.new_sales_order_id = id;
      }
    }
    const matched = matchLines(mine, src);
    for (const m of mine) {
      const s = matched.get(m.id);
      if (!s) { stats.unmatched += 1; continue; }
      const joNo = String(s.UserPK_TransH || '').trim();
      if (!/^(NS)?JO-|^NSJO-|^RFQC-/i.test(joNo)) continue;
      const jo = await joId(joNo);
      if (!jo) { stats.joNotInT1s += 1; unknownJo.set(joNo, inv.invoice_no); continue; }
      if (jo.id !== m.job_order_id) change.lines.push({ line_id: m.id, old_job_order_id: m.job_order_id, new_job_order_id: jo.id, jo_no: joNo });
    }
    if (change.new_sales_order_id || change.lines.length) {
      changes.push(change);
      stats.invoicesChanged += 1;
      if (change.new_sales_order_id) stats.headerFix += 1;
      stats.lineFix += change.lines.length;
      if (samples.length < 8) samples.push(`${inv.invoice_no}: ${change.new_sales_order_id ? `SO ${inv.sales_order_id} -> ${change.new_sales_order_id}; ` : ''}${change.lines.map((l) => `line ${l.line_id} -> ${l.jo_no}`).join(', ')}`);
    }
  }
  console.log(`\n${JSON.stringify(stats)}`);
  samples.forEach((s) => console.log(`  ${s}`));
  if (unknownJo.size) console.log(`JO numbers the source names that T1S does not hold (${unknownJo.size}): ${[...unknownJo.keys()].slice(0, 15).join(', ')}${unknownJo.size > 15 ? ' ...' : ''}`);
  if (!APPLY || !changes.length) { await pool.end(); return; }

  const dir = '/root/match2026';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const backup = `${dir}/relink-invoice-lines-${Date.now()}.json`;
  fs.writeFileSync(backup, JSON.stringify(changes));
  console.log(`Backup: ${backup}`);
  let h = 0; let l = 0;
  for (const c of changes) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (c.new_sales_order_id) {
        const [r] = await conn.query('UPDATE sales_invoices SET sales_order_id = ? WHERE id = ?', [c.new_sales_order_id, c.invoice_id]); h += r.affectedRows;
      }
      for (const x of c.lines) {
        const [r] = await conn.query('UPDATE sales_invoice_lines SET job_order_id = ? WHERE id = ?', [x.new_job_order_id, x.line_id]); l += r.affectedRows;
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); console.error(`${c.invoice_no}: ${e.message}`); } finally { conn.release(); }
  }
  console.log(`Applied: ${h} invoice headers, ${l} lines.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
