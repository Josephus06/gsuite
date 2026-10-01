// Fill the Sales Order header details the migration never carried, from the source.
//
// SO-72237 on the source shows Prepared By, Approved By, Production Lead Time, Price Validity,
// Order Confirmation, PO #, Memo and Credit Term; on T1S every one was blank -- and not just
// there: of ~900 migrated orders a month, 0-4 had a Prepared By. The importer read the list
// endpoint, which does not carry them. The columns all exist; this fills them.
//
//   source field (get_transactions SALESORDER)  ->  sales_orders column
//   PreparedBy_TransH (a name)                   ->  prepared_by_id (employee)
//   ApprovedBy_TransH (a name)                   ->  approved_by_id (employee)
//   Memo_TransH                                  ->  memo
//   Leadtime_TransH                              ->  production_lead_time
//   PriceValidity_TransH                         ->  price_validity
//   OrderConfirmation_TransH                     ->  order_confirmation_type
//   PONo_TransH                                  ->  order_confirmation_ref   (shown as PO #)
//   Term_TransH                                  ->  credit_term
//   RefNo_TransH                                 ->  ref_no
//
// --lines also fills each line's Job Location (job_location_id) from the source line's location:
// the same paged query brings the lines (transaction_transactionledgerjobs), each naming its
// location by source key, translated through get_locations. Heavier pages, so optional.
//
// FILL-ONLY: a column is written only where T1S has it empty, so nothing entered or edited in T1S
// since go-live is overwritten. Each UPDATE re-checks the column is still empty. Re-runnable.
//
//   node src/db/backfill-so-header-details.js                        # dry run, all orders
//   node src/db/backfill-so-header-details.js --apply
//   node src/db/backfill-so-header-details.js --lines --from=2026-01-01 [--apply]
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const LINES = process.argv.includes('--lines');
const argVal = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const FROM = argVal('from', '2000-01-01');
const TO = argVal('to', '2100-12-31');
const PAGE = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').toString().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const clean = (s, n) => { const v = (s == null ? '' : String(s)).trim(); return v ? v.slice(0, n) : null; };
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}
async function api(token, ep, payload, attempts = 5) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000 + a * 30000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: ctl.signal });
      const j = await r.json(); clearTimeout(timer); return j;
    } catch (e) { clearTimeout(timer); last = e; await sleep(2000 * (a + 1)); }
  }
  throw last;
}

// Column -> how to read it off the source header. Employees are resolved by name.
const TEXT = [
  ['memo', 'Memo_TransH', 65000], ['production_lead_time', 'Leadtime_TransH', 100], ['price_validity', 'PriceValidity_TransH', 100],
  ['order_confirmation_type', 'OrderConfirmation_TransH', 100], ['order_confirmation_ref', 'PONo_TransH', 100],
  ['credit_term', 'Term_TransH', 100], ['ref_no', 'RefNo_TransH', 100],
];

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'DRY RUN'}  window ${FROM}..${TO}${LINES ? '  +lines' : ''}`);

  // Column widths here, so a long source value is cut to fit rather than failing the row.
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME c, CHARACTER_MAXIMUM_LENGTH len FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_orders'");
  const width = new Map(cols.map((c) => [c.c, Number(c.len) || null]));
  const text = TEXT.filter(([col]) => width.has(col)).map(([col, f, n]) => [col, f, Math.min(n, width.get(col) || n)]);

  const [emps] = await pool.query("SELECT id, first_name, last_name, is_active FROM employees");
  const empByName = new Map();
  // Active records win a name clash (a deactivated duplicate must not be picked).
  for (const e of [...emps].sort((a, b) => a.is_active - b.is_active)) empByName.set(norm(`${e.first_name} ${e.last_name}`), e.id);
  const [users] = await pool.query('SELECT display_name, employee_id FROM users WHERE employee_id IS NOT NULL');
  for (const u of users) if (!empByName.has(norm(u.display_name))) empByName.set(norm(u.display_name), u.employee_id);

  const [locals] = await pool.query(
    `SELECT id, sales_order_no, prepared_by_id, approved_by_id, ${text.map(([c]) => c).join(', ')}
       FROM sales_orders WHERE date_created BETWEEN ? AND ?`, [FROM, TO]);
  const byNo = new Map(locals.map((s) => [s.sales_order_no, s]));
  console.log(`Local orders in window: ${locals.length}`);

  const token = await login();
  // Source location key -> local location id, for the line Job Locations.
  const locByPk = new Map();
  const srcLinesBySo = new Map();
  if (LINES) {
    const [locs] = await pool.query('SELECT id, location_name FROM locations');
    const localByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
    for (const l of listRows(await api(token, 'get_locations', { searchKey: '', limit: 1000, offset: 0 }))) {
      locByPk.set(l.SysPK_Loc, { name: l.Name_Loc, id: localByName.get(norm(l.Name_Loc)) || null });
    }
    console.log(`Source locations: ${locByPk.size}, matched locally: ${[...locByPk.values()].filter((x) => x.id).length}`);
  }
  const fills = {}; const unknownPeople = new Map(); let seen = 0; let touched = 0;
  const ops = [];
  for (let off = 0; off < 200000; off += PAGE) {
    const page = listRows(await api(token, 'get_transactions', { where: { Module_TransH: 'SALESORDER' }, ...(LINES ? { include: ['transaction_transactionledgerjobs'] } : {}), limit: PAGE, offset: off }));
    if (!page.length) break;
    for (const h of page) {
      const so = byNo.get(h.UserPK_TransH);
      if (!so) continue;
      seen += 1;
      if (LINES) {
        const jobs = (h.transaction_transactionledgerjobs || []).filter((j) => j.Module_LdgrJob !== 'GENENTRY')
          .sort((a, b) => Number(a.ID_LdgrJob) - Number(b.ID_LdgrJob));
        if (jobs.length) srcLinesBySo.set(so.id, jobs);
      }
      const set = {};
      for (const [field, src] of [['prepared_by_id', 'PreparedBy_TransH'], ['approved_by_id', 'ApprovedBy_TransH']]) {
        if (so[field] || !clean(h[src], 200)) continue;
        const id = empByName.get(norm(h[src]));
        if (id) set[field] = id; else unknownPeople.set(h[src], (unknownPeople.get(h[src]) || 0) + 1);
      }
      for (const [col, src, n] of text) {
        if (so[col] != null && String(so[col]).trim() !== '') continue;
        const v = clean(h[src], n);
        if (v) set[col] = v;
      }
      if (!Object.keys(set).length) continue;
      touched += 1;
      for (const k of Object.keys(set)) fills[k] = (fills[k] || 0) + 1;
      ops.push({ id: so.id, no: so.sales_order_no, set, livePk: h.SysPK_TransH });
    }
    process.stdout.write(`\r  read ${off + page.length} source orders, ${touched} to fill`);
    if (page.length < PAGE) break;
  }
  console.log(`\n\nMatched ${seen} of ${locals.length} local orders. Orders to fill: ${touched}`);
  console.log('Fields to fill:', fills);
  if (unknownPeople.size) {
    console.log(`Prepared/Approved names with no local employee (${unknownPeople.size}; left blank):`);
    [...unknownPeople.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([n, c]) => console.log(`  ${c}x ${n}`));
  }
  const sample = ops.find((o) => o.no === 'SO-72237') || ops[0];
  if (sample) console.log('\nSample:', sample.no, JSON.stringify(sample.set));

  if (APPLY) {
    let done = 0;
    for (const o of ops) {
      const keys = Object.keys(o.set);
      // Re-check emptiness in the WHERE, so a value typed in T1S since the read is never replaced.
      const guard = keys.map((k) => `(${k} IS NULL OR ${k} = '')`).join(' AND ');
      const [r] = await pool.query(`UPDATE sales_orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND ${guard}`,
        [...keys.map((k) => o.set[k]), o.id]);
      done += r.affectedRows;
    }
    console.log(`\nUpdated ${done} order(s).`);
  }

  if (!LINES) return;
  // ---- line Job Location ----------------------------------------------------------------------
  // Paired in order (source by its line id, T1S by line_no); a line is only filled when its
  // description agrees, so a re-ordered or edited order is left alone rather than mis-labelled.
  let lineFills = 0; let skippedDesc = 0; const unknownLoc = new Map();
  for (const [soId, src] of srcLinesBySo) {
    const [mine] = await pool.query(
      'SELECT id, description FROM sales_order_lines WHERE sales_order_id = ? ORDER BY line_no, id', [soId]);
    for (let i = 0; i < mine.length && i < src.length; i += 1) {
      const loc = locByPk.get(src[i].SysFK_Loc_LdgrJob);
      if (!loc) continue;
      if (!loc.id) { unknownLoc.set(loc.name, (unknownLoc.get(loc.name) || 0) + 1); continue; }
      if (norm(mine[i].description).slice(0, 40) !== norm(src[i].Description_LdgrJob).slice(0, 40)) { skippedDesc += 1; continue; }
      if (APPLY) {
        const [r] = await pool.query('UPDATE sales_order_lines SET job_location_id = ? WHERE id = ? AND job_location_id IS NULL', [loc.id, mine[i].id]);
        lineFills += r.affectedRows;
      } else {
        const [[cur]] = await pool.query('SELECT job_location_id FROM sales_order_lines WHERE id = ?', [mine[i].id]);
        if (cur.job_location_id == null) lineFills += 1;
      }
    }
  }
  console.log(`
Line Job Locations ${APPLY ? 'filled' : 'to fill'}: ${lineFills}  (skipped, description differs: ${skippedDesc})`);
  if (unknownLoc.size) console.log('Source locations with no local match:', Object.fromEntries(unknownLoc));
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
