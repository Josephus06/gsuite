// Fills in estimates.approved_by_id -- the supervisor who approved the estimate -- where it is
// blank. 70,726 of the 70,840 estimates on production carry no approver, so the field reads empty
// on almost every estimate ever raised.
//
// TWO SOURCES, and the order matters because the first is evidence and the second is inference.
//
// 1. THIS SYSTEM'S OWN AUDIT LOG. An estimate approved here has an audit row recording the status
//    move out of pending_supervisor_approval and the user who made it. That is who approved it,
//    recorded at the time, so it is applied first and never overwritten by the source. It covers
//    the handful approved here before the transition started writing the column (8 on the
//    droplet); everything approved since already has it.
//
// 2. THE SOURCE SYSTEM'S ApprovedBy_TransH, matched by name. The migrated estimates never passed
//    through the approval flow here -- import-sales.js creates them already 'approved' and sets no
//    approver -- so their only record of who signed them off is the source, which carries the
//    approver as a NAME rather than an id. Names are matched to `employees` on letters and digits
//    only, so "Cindy Marie Deniay_SM" matches whatever spacing and punctuation either side uses.
//
// WHAT IT REFUSES TO GUESS, and these stay blank on purpose:
//   * a name matching NO employee -- Mariannilyn L. Lamis (976), Moldy Molde (924),
//     Lindy Caseris (6), Neil Yu (1). Former staff who were never migrated into employees; there
//     is no id to point at.
//   * a name matching MORE THAN ONE employee -- "Cindy Marie Deniay" (1,337) is either
//     Cindy Marie Deniay_AYALA (80) or Cindy Marie Deniay_SM (119). The source records the person
//     once where this system splits them per branch, so it cannot say which. Filling in the wrong
//     supervisor is worse than filling in none.
//
// The approver map is built from the .live-cache year files rather than re-fetching: a full sales
// history pull takes hours over the remote link, and the cached rows carry the same field. Build
// it once where the cache lives, then apply it anywhere:
//
//   node src/db/backfill-estimate-approved-by.js --build-map=approvers.json
//   node src/db/backfill-estimate-approved-by.js --map=approvers.json --dry-run
//   node src/db/backfill-estimate-approved-by.js --map=approvers.json
//
// Without --map it does the audit-log half only. Idempotent: it only ever fills a NULL.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const argVal = (n) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : null;
};
const BUILD_MAP = argVal('build-map');
const MAP_FILE = argVal('map');
const CACHE_DIR = path.join(__dirname, '..', '..', '.live-cache');

// Letters and digits only: the same person is "Cindy Marie Deniay_SM" in one place and
// "Cindy Marie  Deniay_SM" in another, and a middle initial comes and goes.
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function buildMap(outFile) {
  if (!fs.existsSync(CACHE_DIR)) throw new Error(`No .live-cache at ${CACHE_DIR} -- run this where the sales import cache lives.`);
  const files = fs.readdirSync(CACHE_DIR).filter((f) => /^get_sales_orders_\d{4}-01-01_\d{4}-12-31\.json$/.test(f));
  if (!files.length) throw new Error('No whole-year get_sales_orders cache files found.');
  const byEstimate = new Map();
  let rows = 0;
  for (const f of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.data || []);
    for (const r of arr) {
      rows += 1;
      const est = r.sl_upk;
      const approver = String(r.ApprovedBy_TransH || '').trim();
      if (est && approver) byEstimate.set(est, approver);
    }
  }
  fs.writeFileSync(outFile, JSON.stringify([...byEstimate]));
  console.log(`Read ${files.length} year file(s), ${rows.toLocaleString()} source rows.`);
  console.log(`Wrote ${byEstimate.size.toLocaleString()} estimate -> approver pairs to ${outFile}.`);
}

async function main() {
  if (BUILD_MAP) return buildMap(BUILD_MAP);

  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM estimates WHERE approved_by_id IS NULL');
  console.log(`${before.n.toLocaleString()} estimate(s) have no approver.\n`);

  // ---- 1. this system's own audit log ----
  const [audited] = await pool.query(
    `SELECT e.id, MIN(u.employee_id) AS employee_id, COUNT(DISTINCT u.employee_id) AS approvers
       FROM estimates e
       JOIN audit_logs al ON al.auditable_type = 'Estimate' AND al.auditable_id = e.id
                          AND al.field_name = 'status' AND al.new_value = 'pending_customer_approval'
       JOIN users u ON u.id = al.set_by_user_id
      WHERE e.approved_by_id IS NULL AND u.employee_id IS NOT NULL
      GROUP BY e.id`,
  );
  // An estimate sent round the loop twice could carry two different approvers; the first one is
  // the supervisor who approved it, so take the earliest rather than an arbitrary one.
  let fromAudit = 0;
  for (const row of audited) {
    if (row.approvers > 1) {
      const [[first]] = await pool.query(
        `SELECT u.employee_id FROM audit_logs al JOIN users u ON u.id = al.set_by_user_id
          WHERE al.auditable_type = 'Estimate' AND al.auditable_id = ? AND al.field_name = 'status'
            AND al.new_value = 'pending_customer_approval' AND u.employee_id IS NOT NULL
          ORDER BY al.id LIMIT 1`, [row.id],
      );
      row.employee_id = first?.employee_id ?? row.employee_id;
    }
    if (!DRY_RUN) {
      await pool.query('UPDATE estimates SET approved_by_id = ? WHERE id = ? AND approved_by_id IS NULL', [row.employee_id, row.id]);
    }
    fromAudit += 1;
  }
  console.log(`From this system's audit log: ${fromAudit.toLocaleString()} estimate(s)${DRY_RUN ? ' would be' : ''} filled.`);

  // ---- 2. the source system's ApprovedBy, by name ----
  if (!MAP_FILE) {
    console.log('\nNo --map given, so the migrated estimates are left alone. Build one with --build-map.');
    await pool.end();
    return;
  }
  const byEstimate = new Map(JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')));

  const [employees] = await pool.query('SELECT id, first_name, last_name FROM employees');
  const byName = new Map();
  for (const e of employees) {
    const k = key(`${e.first_name} ${e.last_name}`);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e.id);
  }

  const [pending] = await pool.query('SELECT id, estimate_no FROM estimates WHERE approved_by_id IS NULL');
  const stats = { filled: 0, noSource: 0, noEmployee: new Map(), ambiguous: new Map() };
  const updates = [];
  for (const e of pending) {
    const name = byEstimate.get(e.estimate_no);
    if (!name) { stats.noSource += 1; continue; }
    const k = key(name);
    const ids = byName.get(k) || [];
    if (ids.length === 1) { updates.push([ids[0], e.id]); continue; }
    if (ids.length > 1) { stats.ambiguous.set(name, (stats.ambiguous.get(name) || 0) + 1); continue; }
    // No exact match. The source sometimes records the bare name where this system splits the
    // person per branch -- "Cindy Marie Deniay" against Cindy Marie Deniay_AYALA and
    // Cindy Marie Deniay_SM. That is ambiguity, not a missing employee, and saying so is the
    // difference between "add this person" and "the source cannot tell us which branch".
    const prefixed = [...byName.keys()].filter((ek) => ek.startsWith(k));
    if (prefixed.length > 1) { stats.ambiguous.set(name, (stats.ambiguous.get(name) || 0) + 1); continue; }
    stats.noEmployee.set(name, (stats.noEmployee.get(name) || 0) + 1);
  }

  if (!DRY_RUN) {
    // One statement per 500 rows rather than per row: 66k round trips over the Railway proxy is
    // minutes of latency for work the database does in seconds.
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
      const params = chunk.flatMap(([emp, id]) => [id, emp]);
      await pool.query(
        `UPDATE estimates SET approved_by_id = CASE id ${cases} END
          WHERE id IN (${chunk.map(() => '?').join(',')}) AND approved_by_id IS NULL`,
        [...params, ...chunk.map(([, id]) => id)],
      );
    }
  }
  stats.filled = updates.length;

  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c.toLocaleString()})`).join(', ');
  const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  console.log(`From the source system:     ${stats.filled.toLocaleString()} estimate(s)${DRY_RUN ? ' would be' : ''} filled.`);
  console.log('\nLeft blank on purpose:');
  console.log(`  ${stats.noSource.toLocaleString()} not in the source, or the source records no approver`);
  console.log(`  ${sum(stats.noEmployee).toLocaleString()} name matches no employee: ${top(stats.noEmployee) || 'none'}`);
  console.log(`  ${sum(stats.ambiguous).toLocaleString()} name matches more than one employee: ${top(stats.ambiguous) || 'none'}`);

  const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM estimates WHERE approved_by_id IS NULL');
  console.log(`\nEstimates with no approver: ${before.n.toLocaleString()} -> ${after.n.toLocaleString()}${DRY_RUN ? ' (unchanged -- dry run)' : ''}`);
  await pool.end();
}

main().catch((err) => { console.error('Backfill failed:', err.message); process.exit(1); });
