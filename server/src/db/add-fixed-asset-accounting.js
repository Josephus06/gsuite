// Adds the fixed-asset ACCOUNTING lifecycle on top of the custody register created by
// create-assets-module.js. Same asset record throughout: custody answers "where is reference 1542
// and who has it", this answers "what is it worth and what has it cost us". A second register
// would be two sets of books about one machine.
//
// Covers acquisition (capitalization) -> depreciation -> disposal, plus the roll-forward report.
// Impairment and revaluation are deliberately NOT here.
//
// The chart of accounts already carries the whole structure, paired by code -- 17x00 is a cost
// account and 17x01 its accumulated-depreciation contra (17200 Building / 17201 Accumulated
// Depreciation - Building, and so on). asset_classes below is seeded straight from those pairs, so
// the module posts into the accounts the accountants already use rather than inventing any.
//
// Land is seeded non-depreciable: it has a cost account and, correctly, no contra.
//
//   node src/db/add-fixed-asset-accounting.js --dry-run
//   node src/db/add-fixed-asset-accounting.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  { route: '/asset-classes', name: 'Asset Classes', module: 'Assets' },
  { route: '/asset-depreciation', name: 'Asset Depreciation', module: 'Assets' },
  { route: '/asset-disposals', name: 'Asset Disposals', module: 'Assets' },
  { route: '/reports/fixed-asset-roll-forward', name: 'Fixed Asset Roll Forward', module: 'Assets' },
];

const TABLES = [
  // An asset class is the bridge between a physical thing and the ledger: it names the three
  // accounts every posting for that class uses, so an individual asset never carries account ids
  // and a class re-mapped later moves all of its assets at once.
  ['asset_classes', `
CREATE TABLE asset_classes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    cost_account_id BIGINT NULL,
    accumulated_depreciation_account_id BIGINT NULL,
    depreciation_expense_account_id BIGINT NULL,
    is_depreciable BOOLEAN NOT NULL DEFAULT TRUE,
    default_useful_life_months INT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uq_asset_classes_name (name)
)`],

  // One row, ever. The capitalisation threshold is a policy, not a per-document choice: an asset
  // at or above it is capitalised and depreciated, one below it is expensed on purchase and the
  // custody register still tracks it. Keeping it here rather than hard-coded is the difference
  // between accounting changing a policy and a developer changing a constant.
  ['asset_settings', `
CREATE TABLE asset_settings (
    id INT PRIMARY KEY,
    capitalization_threshold DECIMAL(18,2) NOT NULL DEFAULT 10000.00,
    default_useful_life_months INT NOT NULL DEFAULT 60,
    gain_loss_account_id BIGINT NULL,
    updated_at DATETIME NULL,
    updated_by_user_id BIGINT NULL
)`],

  // The cost ledger. Capitalised cost is the SUM of these lines, never a column -- because the
  // article's rule is that everything needed to put the asset in place is capitalised (freight,
  // installation), and a single figure cannot show an auditor what it was made of. Improvements
  // after the asset is in service land here too, and the depreciation engine picks them up
  // prospectively over remaining life.
  ['asset_cost_lines', `
CREATE TABLE asset_cost_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    asset_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    cost_type VARCHAR(30) NOT NULL DEFAULT 'purchase',
    description VARCHAR(500) NULL,
    amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    incurred_date DATE NULL,
    source_type VARCHAR(50) NULL,
    source_id BIGINT NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_acl_asset (asset_id)
)`],

  // A depreciation run is the DOCUMENT the ledger derives from. This ERP computes GL from source
  // documents rather than storing journals, so depreciation cannot be a calculated column -- there
  // has to be something dated, numbered and postable for the Trial Balance to read.
  //
  // One posted run per month, enforced in the route: two runs for August would depreciate every
  // asset twice, and nothing downstream would notice.
  ['asset_depreciation_runs', `
CREATE TABLE asset_depreciation_runs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    run_no VARCHAR(40) UNIQUE NOT NULL,
    period_month DATE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    total_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    asset_count INT NOT NULL DEFAULT 0,
    memo VARCHAR(1000) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_by_user_id BIGINT NULL,
    posted_at DATETIME NULL,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    void_reason VARCHAR(500) NULL,
    INDEX idx_adr_period (period_month),
    INDEX idx_adr_status (status)
)`],

  // Per-asset detail for one run. The account codes are SNAPSHOTTED onto the line: re-pointing a
  // class next year must not silently restate what last year's Trial Balance said.
  ['asset_depreciation_lines', `
CREATE TABLE asset_depreciation_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    run_id BIGINT NOT NULL,
    line_no INT NOT NULL,
    asset_id BIGINT NOT NULL,
    asset_class_id BIGINT NULL,
    depreciable_base DECIMAL(18,2) NOT NULL DEFAULT 0,
    opening_accumulated DECIMAL(18,2) NOT NULL DEFAULT 0,
    amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    closing_accumulated DECIMAL(18,2) NOT NULL DEFAULT 0,
    remaining_life_months INT NULL,
    expense_account_id BIGINT NULL,
    expense_account_code VARCHAR(20) NULL,
    accumulated_account_id BIGINT NULL,
    accumulated_account_code VARCHAR(20) NULL,
    INDEX idx_adl_run (run_id),
    INDEX idx_adl_asset (asset_id),
    UNIQUE KEY uq_adl_run_asset (run_id, asset_id)
)`],

  // Disposal, whether sold, scrapped, donated or written off. Cost and accumulated depreciation
  // are frozen onto the document at posting, because the entry removes exactly those amounts and
  // the gain or loss is whatever is left against the proceeds.
  ['asset_disposals', `
CREATE TABLE asset_disposals (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    disposal_no VARCHAR(40) UNIQUE NOT NULL,
    asset_id BIGINT NOT NULL,
    disposal_date DATE NOT NULL,
    disposal_type VARCHAR(30) NOT NULL DEFAULT 'sale',
    proceeds DECIMAL(18,2) NOT NULL DEFAULT 0,
    proceeds_account_id BIGINT NULL,
    cost_at_disposal DECIMAL(18,2) NOT NULL DEFAULT 0,
    accumulated_at_disposal DECIMAL(18,2) NOT NULL DEFAULT 0,
    net_book_value DECIMAL(18,2) NOT NULL DEFAULT 0,
    gain_loss DECIMAL(18,2) NOT NULL DEFAULT 0,
    gain_loss_account_id BIGINT NULL,
    cost_account_id BIGINT NULL,
    accumulated_account_id BIGINT NULL,
    buyer_name VARCHAR(255) NULL,
    reason VARCHAR(500) NULL,
    memo VARCHAR(1000) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_by_user_id BIGINT NULL,
    posted_at DATETIME NULL,
    voided_by_user_id BIGINT NULL,
    voided_at DATETIME NULL,
    void_reason VARCHAR(500) NULL,
    INDEX idx_adisp_asset (asset_id),
    INDEX idx_adisp_date (disposal_date),
    INDEX idx_adisp_status (status)
)`],
];

// New columns on the existing register. Everything here is nullable or defaulted, so the rows the
// custody module already created stay valid and simply read as "not capitalised".
const COLUMNS = [
  ['assets', 'asset_class_id', 'BIGINT NULL AFTER asset_item_id'],
  ['assets', 'is_capitalized', 'BOOLEAN NOT NULL DEFAULT FALSE AFTER asset_class_id'],
  ['assets', 'salvage_value', 'DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER acquisition_cost'],
  ['assets', 'useful_life_months', 'INT NULL AFTER salvage_value'],
  ['assets', 'in_service_date', 'DATE NULL AFTER useful_life_months'],
  ['assets', 'depreciation_method', "VARCHAR(30) NOT NULL DEFAULT 'straight_line' AFTER in_service_date"],
];

const INDEXES = [
  ['assets', 'idx_assets_class', '(asset_class_id)'],
  ['assets', 'idx_assets_capitalized', '(is_capitalized, in_service_date)'],
];

// Seeded from the account codes already in the chart of accounts. Anything whose pair is missing is
// skipped with a warning rather than seeded pointing at nothing -- a class with a null cost account
// would fail at posting time, long after anyone remembers running this.
const CLASS_SEED = [
  { name: 'Land', cost: '17100', accum: null, depreciable: false, life: null },
  { name: 'Building', cost: '17200', accum: '17201', depreciable: true, life: 300 },
  { name: 'Building Improvement', cost: '17300', accum: '17301', depreciable: true, life: 120 },
  { name: 'Office Equipment', cost: '17400', accum: '17401', depreciable: true, life: 60 },
  { name: 'Furniture & Fixtures', cost: '17500', accum: '17501', depreciable: true, life: 60 },
  { name: 'Leasehold Improvements', cost: '17600', accum: '17601', depreciable: true, life: 60 },
  { name: 'Machineries & Equipment', cost: '17700', accum: '17701', depreciable: true, life: 120 },
  { name: 'Tools', cost: '17800', accum: '17801', depreciable: true, life: 36 },
  { name: 'Transportation Equipment', cost: '17900', accum: '17901', depreciable: true, life: 60 },
];

const DEPRECIATION_EXPENSE_CODE = '30624'; // Depreciation Expense
const GAIN_LOSS_CODE = '30803'; // Gain/Loss on Sale of Asset

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}
async function columnExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}
async function indexExists(table, name) {
  const [rows] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
  return rows.length > 0;
}
async function accountByCode(code) {
  if (!code) return null;
  const [[r]] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = ?', [code]);
  return r || null;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  if (!(await tableExists('assets'))) {
    console.error('The assets table does not exist. Run src/db/create-assets-module.js first.');
    process.exit(1);
  }

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) console.log(`Table ${name} already exists.`);
    else if (DRY_RUN) console.log(`Would create table ${name}.`);
    else { await pool.query(ddl); console.log(`Created table ${name}.`); }
  }

  console.log('');
  for (const [table, column, definition] of COLUMNS) {
    if (await columnExists(table, column)) console.log(`Column ${table}.${column} already exists.`);
    else if (DRY_RUN) console.log(`Would add column ${table}.${column}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`); console.log(`Added column ${table}.${column}.`); }
  }

  for (const [table, name, cols] of INDEXES) {
    if (await indexExists(table, name)) console.log(`Index ${table}.${name} already exists.`);
    else if (DRY_RUN) console.log(`Would add index ${table}.${name}.`);
    else { await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` ${cols}`); console.log(`Added index ${table}.${name}.`); }
  }

  // ---- Settings row -------------------------------------------------------------------------
  console.log('');
  const gainLoss = await accountByCode(GAIN_LOSS_CODE);
  if (!gainLoss) console.log(`WARNING: account ${GAIN_LOSS_CODE} (Gain/Loss on Sale of Asset) not found -- disposals will need an account chosen manually.`);
  if (!DRY_RUN && (await tableExists('asset_settings'))) {
    const [[existing]] = await pool.query('SELECT id FROM asset_settings WHERE id = 1');
    if (existing) console.log('Settings row already exists.');
    else {
      await pool.query(
        'INSERT INTO asset_settings (id, capitalization_threshold, default_useful_life_months, gain_loss_account_id) VALUES (1, 10000.00, 60, ?)',
        [gainLoss?.id || null],
      );
      console.log(`Seeded settings: capitalisation threshold 10,000.00, default life 60 months, gain/loss account ${gainLoss?.account_code || 'unset'}.`);
    }
  } else if (DRY_RUN) {
    console.log(`Would seed settings: threshold 10,000.00, default life 60 months, gain/loss ${gainLoss?.account_code || 'unset'}.`);
  }

  // ---- Asset classes ------------------------------------------------------------------------
  console.log('');
  const depExpense = await accountByCode(DEPRECIATION_EXPENSE_CODE);
  if (!depExpense) console.log(`WARNING: account ${DEPRECIATION_EXPENSE_CODE} (Depreciation Expense) not found.`);

  for (const c of CLASS_SEED) {
    const cost = await accountByCode(c.cost);
    const accum = c.accum ? await accountByCode(c.accum) : null;

    if (!cost) { console.log(`  skip  ${c.name}: cost account ${c.cost} not in the chart of accounts.`); continue; }
    if (c.depreciable && !accum) { console.log(`  skip  ${c.name}: accumulated depreciation account ${c.accum} not in the chart of accounts.`); continue; }

    if (!(await tableExists('asset_classes'))) { console.log(`  ~ would seed ${c.name}`); continue; }
    const [[found]] = await pool.query('SELECT id FROM asset_classes WHERE name = ?', [c.name]);
    if (found) { console.log(`  ok    ${c.name} already present.`); continue; }
    if (DRY_RUN) { console.log(`  +     would seed ${c.name} -> cost ${c.cost}${accum ? `, accum ${c.accum}` : ' (not depreciated)'}`); continue; }

    await pool.query(
      `INSERT INTO asset_classes (name, cost_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, is_depreciable, default_useful_life_months)
       VALUES (?,?,?,?,?,?)`,
      [c.name, cost.id, accum?.id || null, c.depreciable ? depExpense?.id || null : null, c.depreciable, c.life],
    );
    console.log(`  +     ${c.name} -> cost ${c.cost}${accum ? `, accum ${c.accum}` : ' (not depreciated)'}${c.life ? `, ${c.life} months` : ''}`);
  }

  // ---- Pages --------------------------------------------------------------------------------
  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) console.log(`\nPage ${p.route} already registered (id ${page.id}).`);
    else if (DRY_RUN) console.log(`\nWould register ${p.route} as "${p.name}".`);
    else {
      const [cols] = await pool.query('SHOW COLUMNS FROM pages');
      const has = new Set(cols.map((c) => c.Field));
      const fields = ['route', 'name'];
      const values = [p.route, p.name];
      if (has.has('module')) { fields.push('module'); values.push(p.module); }
      const [result] = await pool.query(
        `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
        values,
      );
      page = { id: result.insertId };
      console.log(`\nRegistered ${p.route} as "${p.name}" (id ${page.id}).`);
    }
    if (!page) continue;
    for (const user of admins) {
      const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]);
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
      if (existing) {
        await pool.query('UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?', [existing.id]);
      } else {
        await pool.query(
          'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)',
          [user.id, page.id],
        );
      }
      console.log(`  + ${user.display_name}: full access.`);
    }
  }

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
