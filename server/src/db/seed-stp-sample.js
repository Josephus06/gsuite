// STP sample data -- 2 reps, 4 territories, 6 accounts (5 real customers on credit terms + 1 named
// prospect), a few logged visits and rep capacities, then a scoring run so the screens have
// something to show. Every row it writes carries the marker [STP SAMPLE] in its notes, and
// --remove deletes exactly those rows and nothing else.
//
// The reps are two EXISTING active account officers (no users are created). The customers are
// real ones with credit-term invoices, chosen across sizes so the scores vary; any customer already
// planned in that fiscal year is skipped.
//
//   node src/db/seed-stp-sample.js --dry-run
//   node src/db/seed-stp-sample.js [--fy=2026] [--as-of=2026-08-21]   (as-of: score date, default today)
//   node src/db/seed-stp-sample.js --remove
// Needs create-stp-module.js first. Droplet and office replicate: run on ONE of them.
require('dotenv').config();
const pool = require('../db');
const { businessToday } = require('../lib/crmCadence');
const { INVOICE_CUSTOMER, INVOICE_JOINS, recalculateScores } = require('../lib/stpScoringData');

const MARK = '[STP SAMPLE]';
const DRY_RUN = process.argv.includes('--dry-run');
const REMOVE = process.argv.includes('--remove');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const FY = Number(arg('fy')) || Number(businessToday().slice(0, 4));
const AS_OF = arg('as-of') || businessToday();

// Targets are worked out from the accounts' potential (TARGET_SHARE of it); a territory with only a
// prospect gets its fixed target.
const TERRITORIES = [
  { name: 'Cebu City North', rep: 0, coverage: 'Banilad, Talamban, Lahug', status: 'Active' },
  { name: 'Cebu City South', rep: 1, coverage: 'Pardo, Labangon, Punta Princesa', status: 'Active' },
  { name: 'Mandaue & Lapu-Lapu', rep: 0, coverage: 'Mandaue City, Lapu-Lapu City, Mactan', status: 'Planned' },
  { name: 'Talisay & Minglanilla', rep: 1, coverage: 'Talisay City, Minglanilla', status: 'Under review', target: 90000 },
];
const TARGET_SHARE = 0.75;
// [territory index, segment, cadence, days since last visit or null]. Annual potential is the
// customer's real 12-month purchases plus 40% headroom, rounded up to ₱50,000.
const ACCOUNTS = [
  [0, 'Corporate', 'Weekly', 3],
  [0, 'SME', 'Every 2 weeks', 9],
  [1, 'Government', 'Every 2 weeks', 9],
  [1, 'Retail', 'Monthly', 40],
  [2, 'Education', 'Monthly', 18],
];
const potentialOf = (volume) => Math.max(50000, Math.ceil((Number(volume) * 1.4) / 50000) * 50000);
const PROSPECT = { territory: 3, name: `Sample Prospect F ${MARK}`, segment: 'SME', potential: 150000, cadence: 'Monthly' };

const daysAgo = (n) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function remove() {
  const like = `%${MARK}%`;
  const [accounts] = await pool.query('SELECT id FROM stp_accounts WHERE notes LIKE ?', [like]);
  const [territories] = await pool.query('SELECT id, name FROM stp_territories WHERE notes LIKE ?', [like]);
  const [caps] = await pool.query('SELECT id FROM stp_rep_capacity WHERE notes LIKE ?', [like]);
  console.log(`Sample rows: ${accounts.length} accounts (with their visits and scores), ${territories.length} territories, ${caps.length} capacities.`);
  if (DRY_RUN) return;
  if (accounts.length) await pool.query('DELETE FROM stp_accounts WHERE id IN (?)', [accounts.map((a) => a.id)]);
  for (const t of territories) {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stp_accounts WHERE territory_id = ?', [t.id]);
    if (n) { console.log(`  ! kept territory "${t.name}": ${n} real account(s) were added to it since`); continue; }
    await pool.query('DELETE FROM stp_territories WHERE id = ?', [t.id]);
  }
  if (caps.length) await pool.query('DELETE FROM stp_rep_capacity WHERE id IN (?)', [caps.map((c) => c.id)]);
  console.log('Removed.');
}

async function seed() {
  const [[already]] = await pool.query('SELECT COUNT(*) AS n FROM stp_territories WHERE notes LIKE ?', [`%${MARK}%`]);
  if (already.n) { console.log('Sample data is already there. Run with --remove first to re-seed.'); return; }

  const [reps] = await pool.query(
    `SELECT id, display_name FROM users WHERE is_active = TRUE AND is_account_officer = TRUE
      ORDER BY last_login_at IS NULL, last_login_at DESC LIMIT 2`);
  if (reps.length < 2) throw new Error('Need two active account officers (users.is_account_officer) to act as the sample reps.');
  console.log(`Reps: ${reps.map((r) => r.display_name).join(', ')}`);

  // Customers on credit terms, ranked by 12-month volume, picked across the range.
  const [ranked] = await pool.query(
    `SELECT ${INVOICE_CUSTOMER} AS customer_id, c.name, SUM(si.net_of_tax) AS volume
       FROM sales_invoices si ${INVOICE_JOINS} JOIN customers c ON c.id = ${INVOICE_CUSTOMER}
      WHERE si.status <> 'cancelled' AND si.date_created > DATE_SUB(?, INTERVAL 12 MONTH) AND si.date_created <= ?
        AND ${INVOICE_CUSTOMER} NOT IN (SELECT customer_id FROM stp_accounts WHERE fiscal_year = ? AND customer_id IS NOT NULL)
      GROUP BY ${INVOICE_CUSTOMER}, c.name
     HAVING MAX(si.date_due > si.date_created) = 1
      ORDER BY volume DESC`, [AS_OF, AS_OF, FY]);
  const picks = [0, 4, 15, 40, 90].map((i) => ranked[Math.min(i, ranked.length - 1)]).filter(Boolean);
  const customers = [...new Map(picks.map((p) => [p.customer_id, p])).values()];
  if (customers.length < ACCOUNTS.length) throw new Error(`Found only ${customers.length} credit-term customers invoiced in the 12 months to ${AS_OF}.`);

  console.log(`FY ${FY}: 4 territories, ${customers.length + 1} accounts:`);
  ACCOUNTS.forEach(([ti], i) => console.log(`  ${TERRITORIES[ti].name}: ${customers[i].name} (12-month ₱${Math.round(customers[i].volume).toLocaleString()})`));
  console.log(`  ${TERRITORIES[PROSPECT.territory].name}: ${PROSPECT.name} (prospect)`);
  if (DRY_RUN) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tIds = [];
    for (const [ti, t] of TERRITORIES.entries()) {
      const potential = ACCOUNTS.reduce((sum, [at], i) => sum + (at === ti ? potentialOf(customers[i].volume) : 0), 0);
      const target = t.target ?? Math.round((potential * TARGET_SHARE) / 10000) * 10000;
      const [r] = await conn.query(
        `INSERT INTO stp_territories (fiscal_year, name, rep_user_id, coverage_area, target_amount, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [FY, t.name, reps[t.rep].id, t.coverage, target, t.status, `Sample territory ${MARK}`]);
      tIds.push(r.insertId);
    }
    for (const [i, [ti, segment, cadence, visited]] of ACCOUNTS.entries()) {
      const potential = potentialOf(customers[i].volume);
      const [r] = await conn.query(
        `INSERT INTO stp_accounts (territory_id, fiscal_year, customer_id, segment, annual_potential, visit_cadence, last_visit_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [tIds[ti], FY, customers[i].customer_id, segment, potential, cadence, visited == null ? null : daysAgo(visited), `Sample account ${MARK}`]);
      if (visited != null) {
        await conn.query('INSERT INTO stp_visits (account_id, rep_user_id, visit_date, notes) VALUES (?, ?, ?, ?)',
          [r.insertId, reps[TERRITORIES[ti].rep].id, daysAgo(visited), `Sample visit ${MARK}`]);
      }
    }
    await conn.query(
      `INSERT INTO stp_accounts (territory_id, fiscal_year, prospect_name, segment, annual_potential, visit_cadence, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tIds[PROSPECT.territory], FY, PROSPECT.name, PROSPECT.segment, PROSPECT.potential, PROSPECT.cadence, `Sample prospect ${MARK}`]);
    for (const [i, cap] of [[0, 40], [1, 35]]) {
      await conn.query(
        'INSERT IGNORE INTO stp_rep_capacity (rep_user_id, fiscal_year, account_capacity, notes) VALUES (?, ?, ?, ?)',
        [reps[i].id, FY, cap, `Sample capacity ${MARK}`]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  console.log(`Seeded. Scoring as of ${AS_OF}...`);
  console.log(await recalculateScores({ asOf: AS_OF }));
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- nothing will be written.\n' : '');
  if (REMOVE) await remove(); else await seed();
  await pool.end();
}

main().catch(async (err) => { console.error(err.message || err); await pool.end(); process.exit(1); });
