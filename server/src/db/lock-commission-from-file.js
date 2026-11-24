// Lock Commission months from a Commission Summary workbook (asked 2026-11-24).
//
//   node src/db/lock-commission-from-file.js <workbook.xlsx> [--year=2026] [--source="..."] [--apply]
//
// Reads every person block on every sheet of a Commission Summary extract (the team's working copy
// is fine: columns are found by their header text, a CP # column may or may not be there, formulas
// are read by their saved result) and locks each month that has a Confirmed Commission, with the
// figures on the sheet -- Weighted Sales, %, Estimated, passing-JO total, Expected, Confirmed. The
// Commission report then shows those instead of recomputing them (lib/commissionReport.js
// applyMonthLock); Released stays live.
//
// Dry run by default: prints, per person, each month to be locked against what the system computes
// for it today, and the Unpaid it will show (locked Confirmed - live Released). --apply writes.
// Re-runnable: a month already locked is overwritten with the file's figures.
// Run on ONE replicating box (the droplet); Railway separately.
const path = require('path');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { buildCommissionReport } = require('../lib/commissionReport');

const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const YEAR = Number((args.find((a) => a.startsWith('--year=')) || '--year=2026').split('=')[1]);
const SOURCE = (args.find((a) => a.startsWith('--source=')) || '').slice('--source='.length)
  || (FILE ? path.basename(FILE) : '');

const NOW = new Date();
const CURRENT = NOW.getFullYear() * 12 + (NOW.getMonth() + 1);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HEADERS = {
  weighted_sales: 'weighted sales',
  performance_pct: '%',
  estimated_commission: 'estimated commission',
  passing_gp_total: "total amount of jo's with passing rate",
  expected_commission: 'expected commission',
  confirmed_commission: 'confirmed commission',
  released_commission: 'released commission',
  unpaid_commission: 'unpaid commission',
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/_sm$/, '').replace(/[^a-z]/g, '');
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt = (n) => (n == null ? '' : r2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function cellNumber(cell) {
  let v = cell.value;
  if (v && typeof v === 'object') v = v.result !== undefined ? v.result : null;
  if (v == null || v === '' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// [{ sheet, row, name, months: [{ month, weighted_sales, ..., unpaid_commission }] }]
function readBlocks(wb) {
  const blocks = [];
  wb.eachSheet((ws) => {
    for (let r = 1; r <= ws.rowCount; r += 1) {
      if (ws.getRow(r).getCell(1).text.trim() !== 'Month' || ws.getRow(r - 1).getCell(1).text.trim() === 'Month') continue;
      // The name row sits just above the first header row: label in A, the name in the last filled of B..D.
      const nameRow = ws.getRow(r - 1);
      const name = ['D', 'C', 'B'].map((c) => nameRow.getCell(c).text.trim()).find(Boolean);
      const cols = {};
      for (const hr of [ws.getRow(r), ws.getRow(r + 1)]) {
        hr.eachCell((c, col) => {
          const t = c.text.trim().toLowerCase();
          for (const [k, h] of Object.entries(HEADERS)) if (t === h && !cols[k]) cols[k] = col;
        });
      }
      if (!cols.confirmed_commission) continue;
      const months = [];
      for (let mr = r + 2; mr <= ws.rowCount; mr += 1) {
        const row = ws.getRow(mr);
        const m = MONTHS.indexOf(row.getCell(1).text.trim());
        if (m < 0) break;
        const rec = { month: m + 1 };
        for (const k of Object.keys(HEADERS)) rec[k] = cols[k] ? cellNumber(row.getCell(cols[k])) : null;
        months.push(rec);
      }
      blocks.push({ sheet: ws.name, row: r - 1, name, months });
    }
  });
  return blocks;
}

async function main() {
  if (!FILE) { console.error('Usage: node src/db/lock-commission-from-file.js <workbook.xlsx> [--year=2026] [--apply]'); process.exit(2); }
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db} | year ${YEAR} | source "${SOURCE}"${APPLY ? '' : ' -- DRY RUN (add --apply to write)'}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const blocks = readBlocks(wb);

  // The summary lists people with an active user account (commissionSummaryWorkbook placePeople), so
  // those are matched first; any other active employee only when no user-holder has the name.
  const [emps] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name,
            EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.is_active = TRUE) AS has_user
       FROM employees e WHERE e.is_active = TRUE`);
  const byName = new Map();
  for (const pass of [1, 0]) {
    const seen = new Map();
    for (const e of emps.filter((x) => Number(x.has_user) === pass)) {
      const k = norm(e.name);
      seen.set(k, seen.has(k) ? null : e); // null = ambiguous
    }
    for (const [k, e] of seen) if (!byName.has(k)) byName.set(k, e);
  }

  let toLock = 0; const problems = [];
  for (const b of blocks) {
    const emp = byName.get(norm(b.name));
    if (!emp) { problems.push(`${b.sheet}!${b.row} "${b.name}": ${emp === null ? 'matches more than one employee' : 'no active employee by that name'}`); continue; }
    // A month still running (this month or later) is never locked: it is not finished, so it was
    // not handed over for release, whatever the sheet shows for it.
    const lockable = b.months.filter((m) => m.confirmed_commission != null && YEAR * 12 + m.month < CURRENT);
    const report = await buildCommissionReport(emp.id, YEAR);
    console.log(`\n${b.sheet} | ${b.name} -> employee ${emp.id} ${emp.name} | ${lockable.length} month(s) to lock`);
    let fileUnpaid = 0; let lockedUnpaid = 0; let liveUnpaid = 0;
    for (const row of report.rows) {
      const f = lockable.find((m) => m.month === row.month);
      const released = Number(row.released_commission) || 0;
      // Live Unpaid as the summary shows it: no CP -> no Confirmed.
      const hasCp = (row.payables || []).length > 0;
      const liveConfirmed = hasCp ? row.confirmed_commission : 0;
      liveUnpaid += liveConfirmed - released;
      if (!f) { lockedUnpaid += liveConfirmed - released; continue; }
      fileUnpaid += Number(f.unpaid_commission) || 0;
      lockedUnpaid += (hasCp ? f.confirmed_commission : 0) - released;
      const moved = Math.abs(r2(f.confirmed_commission) - r2(row.confirmed_commission)) >= 0.01;
      console.log(`  ${MONTHS[row.month - 1].padEnd(9)} file Confirmed ${fmt(f.confirmed_commission).padStart(10)} | system now ${fmt(row.confirmed_commission).padStart(10)}${moved ? ' *' : '  '}`
        + ` | Released ${fmt(released).padStart(10)} | Unpaid locked ${fmt(f.confirmed_commission - released).padStart(10)} (file ${fmt(f.unpaid_commission)})`
        + (hasCp ? '' : ' | NO CP now: hidden until one is raised'));
      toLock += 1;
      if (APPLY) {
        await pool.query(
          `INSERT INTO commission_month_locks
             (employee_id, year, month, weighted_sales, performance_pct, estimated_commission, passing_gp_total,
              expected_commission, confirmed_commission, live_confirmed_at_lock, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE weighted_sales = VALUES(weighted_sales), performance_pct = VALUES(performance_pct),
             estimated_commission = VALUES(estimated_commission), passing_gp_total = VALUES(passing_gp_total),
             expected_commission = VALUES(expected_commission), confirmed_commission = VALUES(confirmed_commission),
             live_confirmed_at_lock = VALUES(live_confirmed_at_lock), source = VALUES(source), locked_at = CURRENT_TIMESTAMP`,
          [emp.id, YEAR, row.month, r2(f.weighted_sales ?? row.weighted_sales), r2(f.performance_pct ?? row.performance_pct),
            r2(f.estimated_commission ?? 0), r2(f.passing_gp_total ?? 0), r2(f.expected_commission ?? 0),
            r2(f.confirmed_commission), r2(row.confirmed_commission), SOURCE]
        );
      }
    }
    console.log(`  TOTAL Unpaid: file ${fmt(fileUnpaid)} | after lock ${fmt(lockedUnpaid)} | system now ${fmt(liveUnpaid)}`);
  }

  console.log(`\n${blocks.length} block(s) read, ${toLock} month(s) ${APPLY ? 'locked' : 'would be locked'}.`);
  if (problems.length) { console.log('\nNOT LOCKED -- fix the name and re-run:'); problems.forEach((p) => console.log(`  ! ${p}`)); }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
