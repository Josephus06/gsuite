// Migrates Commission Payables (CP-####) from live into the local module. Values are stored
// VERBATIM from live (not recomputed) -- the local Commission report's per-JO GP rates diverge from
// live's migrated data, so recomputing would give different numbers; a migration must reproduce
// what live actually shows. Header 5 figures come off the list row; the per-month COMMISSIONS
// lines and the paid amount come from the detail (get_commission_payable {pk}).
//
// Employee is matched to a local employee by name (all live payees exist locally); the payable's
// department is taken from that employee's local department (avoids the live "Sales-4"/"Marketing"
// vs local "Sales - 4"/"Maketing" spelling mismatch). Office location is fuzzy-matched, else Head
// Office. Idempotent: skips a CP-# already present.
//
//   node src/db/import-commission-payables.js --dry-run
//   node src/db/import-commission-payables.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY_RUN = process.argv.includes('--dry-run');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Number(num(v).toFixed(2));
const day = (v) => (v || '').toString().slice(0, 10);
const monthStart = (v) => `${day(v).slice(0, 7)}-01`;
const norm = (s) => (s == null ? '' : String(s).toLowerCase().replace(/[^a-z0-9ñ]/g, ''));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapStatus(live) {
  const s = (live || '').toUpperCase();
  if (s.includes('VOID') || s.includes('CANCEL')) return 'void';
  if (s.includes('UNPAID')) return 'unpaid';   // must precede PAID -- "UNPAID" contains "PAID"
  if (s.includes('PARTIAL')) return 'partial';
  if (s.includes('PAID')) return 'paid';
  return 'unpaid';
}

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message}`);
  return b.data.token;
}
async function apiOnce(token, ep, payload, ms = 40000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
}
async function api(token, ep, payload) {
  let last; for (let a = 0; a < 4; a += 1) { try { return await apiOnce(token, ep, payload); } catch (e) { last = e; await sleep(1200 * (a + 1)); } }
  throw last;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Commission Payables${DRY_RUN ? ' | DRY RUN' : ''}\n`);

  const [emps] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS nm, department_id FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e]));
  const [locs] = await pool.query('SELECT id, location_name FROM locations');
  const locByName = new Map(locs.map((l) => [norm(l.location_name), l.id]));
  const [[headOffice]] = await pool.query("SELECT id FROM locations WHERE location_name = 'Head Office' LIMIT 1");
  const [[exp]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '30611'");
  const [[pay]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '24200'");
  const [have] = await pool.query('SELECT commission_payable_no FROM commission_payables');
  const haveNo = new Set(have.map((r) => r.commission_payable_no));

  const token = await login();
  const all = [];
  for (let off = 0; off < 5000; off += 100) {
    const b = listRows(await api(token, 'get_commission_payables', { searchKey: '', limit: 100, offset: off }));
    if (!b.length) break; all.push(...b); if (b.length < 100) break;
  }
  const targets = all.filter((r) => !haveNo.has(r.UserPK_TransH));
  console.log(`Found ${all.length} live payable(s); ${targets.length} to import.\n`);

  let created = 0; let lineCount = 0; let empMissing = 0; let failed = 0;
  for (const h of targets) {
    const emp = empByName.get(norm(h.Name_Empl));
    if (!emp) { console.warn(`  [skip] ${h.UserPK_TransH}: employee not found (${h.Name_Empl})`); empMissing += 1; continue; }
    const officeLocationId = locByName.get(norm(h.LocationName_TransH)) || headOffice?.id || null;

    // Detail: per-month lines + the payable-side GL paid amount.
    let detail;
    try { detail = listRows(await api(token, 'get_commission_payable', { pk: h.SysPK_TransH }))[0]; }
    catch (e) { console.error(`  [error] ${h.UserPK_TransH}: detail fetch ${e.message}`); failed += 1; continue; }
    const rawLines = detail?.transaction_commissionpayables || [];
    const lines = rawLines.map((l) => ({
      line_month: monthStart(l.Date_ComPay), quota: money(l.Quota_ComPay), weighted: money(l.Weighted_ComPay),
      passing_jos: money(l.PassingJos_ComPay), expected: money(l.Expected_ComPay), confirmed: money(l.Confirmed_ComPay),
      released: money(l.Released_ComPay), commission: money(l.Commission_ComPay),
    })).sort((a, b) => a.line_month.localeCompare(b.line_month));

    // Paid amount from the Commission Payable (24200) GL entry.
    let amountPaid = 0;
    for (const g of (detail?.transaction_transactionledgerentries || [])) {
      if (g.transactionledgerentry_coa?.UserPK_COA === '24200' || num(g.CRAmount_LdgrEntries) > 0) amountPaid += num(g.PaidAmount_LdgrEntries);
    }

    const periodFrom = lines.length ? lines[0].line_month : monthStart(h.DeliveryDate_TransH || h.DateCreated_TransH);
    const periodTo = lines.length ? lines[lines.length - 1].line_month : periodFrom;
    const status = mapStatus(h.Status_TransH);

    if (DRY_RUN) {
      console.log(`  ${h.UserPK_TransH} | ${day(h.DateCreated_TransH)} | ${h.Name_Empl} | ${status} | ${periodFrom.slice(0, 7)} | expected ${money(h.TotalAmount_TransH)} commissionable ${money(h.AmountDueFixed_TransH)} paid ${money(amountPaid)} | ${lines.length} line(s)`);
      created += 1; lineCount += lines.length; continue;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO commission_payables
           (commission_payable_no, date_created, employee_id, office_location_id, department_id, period_from, period_to,
            quota, weighted_sales, passing_jos, expected_commission, commissionable_amount,
            expense_account_id, payable_account_id, memo, status, amount_paid, created_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        [h.UserPK_TransH, day(h.DateCreated_TransH), emp.id, officeLocationId, emp.department_id, periodFrom, periodTo,
         money(h.SubTotal_TransH), money(h.AppliedPayments_TransH), money(h.UnappliedPayments_TransH),
         money(h.TotalAmount_TransH), money(h.AmountDueFixed_TransH), exp?.id || null, pay?.id || null, null, status, money(amountPaid)]
      );
      const cpId = r.insertId;
      for (const l of lines) {
        await conn.query(
          `INSERT INTO commission_payable_lines (commission_payable_id, line_month, quota, weighted, passing_jos, expected, confirmed, released, commission)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [cpId, l.line_month, l.quota, l.weighted, l.passing_jos, l.expected, l.confirmed, l.released, l.commission]
        );
        lineCount += 1;
      }
      await conn.commit();
      haveNo.add(h.UserPK_TransH); created += 1;
    } catch (e) { await conn.rollback(); console.error(`  [error] ${h.UserPK_TransH}: ${e.message}`); failed += 1; }
    finally { conn.release(); }
  }

  console.log(`\nDone. ${created} payable(s), ${lineCount} line(s). Employee-missing skips: ${empMissing}. Failures: ${failed}.`);
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
