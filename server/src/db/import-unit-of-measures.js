// Master Lists > Unit of Measures (asked 2026-10-12): the source's Purchase Units and Unit Titles,
// brought across with the page that shows them (routes/unitOfMeasures.js).
//
// The source keeps all three kinds in one table (get_unit_of_measures), told apart by Module_UOM:
//   UNIT  28  plain units -- PC, LMTR, ROLL ...          -> units_of_measure (code, title), as now
//   PU    57  Purchase Units -- code (Name_UOM), purchase unit, base unit (Unit_UOM), length/width
//             flags                                       -> purchase_units
//   UOM  246  Unit Titles -- title (UnitTitle_UOM), purchase / stock / sale / base unit, length,
//             width, conversion, pieces                   -> unit_titles
//
// Units are stored by CODE (the text the source uses, e.g. 'ROLL'), as units_of_measure.code holds
// them; every plain unit a Purchase Unit or Unit Title names is made sure of in units_of_measure
// first (7 were missing: METER, TIN, IN, FT, BOT, LITER, BTL-LTR).
//
// Keyed on the source's own id (live_pk), so a re-run updates rather than duplicates. Titles and
// codes are NOT unique: the source itself has KG twice among its Purchase Units and
// ROLL-LINCH-1299.21 five times among its Unit Titles, and they are kept as it has them.
//
// Also registers the page (/unit-of-measures) and gives System Admins view / add / edit.
//
// Dry run unless --apply. Droplet and office replicate: run on ONE of them. Railway: its own run.
//   node src/db/import-unit-of-measures.js
//   node src/db/import-unit-of-measures.js --apply
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const ROUTE = '/unit-of-measures';
const PAGE_NAME = 'Unit of Measures';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const flag = (v) => (v === 1 || v === '1' || v === true ? 1 : 0);
const txt = (v, n) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, n));

async function fetchAll() {
  const lr = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const token = (await lr.json())?.data?.token;
  if (!token) throw new Error('Login to the source failed.');
  const all = [];
  for (let off = 0; off < 20000; off += 200) {
    const r = await fetch(`${SITE}/api/get_unit_of_measures`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ limit: 200, offset: off }),
    });
    const j = await r.json();
    const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
    all.push(...rows);
    if (rows.length < 200) break;
  }
  return all;
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_units (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      code VARCHAR(60) NOT NULL,
      purchase_unit VARCHAR(30) NULL,
      base_unit VARCHAR(30) NULL,
      is_length TINYINT(1) NOT NULL DEFAULT 0,
      is_width TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      live_pk VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_purchase_units_live_pk (live_pk),
      KEY idx_purchase_units_code (code)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unit_titles (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(100) NOT NULL,
      name VARCHAR(60) NULL,
      purchase_unit VARCHAR(30) NULL,
      stock_unit VARCHAR(30) NULL,
      sale_unit VARCHAR(30) NULL,
      base_unit VARCHAR(30) NULL,
      length DECIMAL(18,6) NULL,
      width DECIMAL(18,6) NULL,
      conversion DECIMAL(20,8) NULL,
      is_length TINYINT(1) NOT NULL DEFAULT 0,
      is_width TINYINT(1) NOT NULL DEFAULT 0,
      is_pieces TINYINT(1) NOT NULL DEFAULT 0,
      pieces DECIMAL(18,4) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      live_pk VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_unit_titles_live_pk (live_pk),
      KEY idx_unit_titles_title (title)
    )`);
}

async function registerPage() {
  const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  let pageId = existing?.id;
  if (!pageId) {
    if (!APPLY) { console.log(`Would register ${ROUTE} as "${PAGE_NAME}".`); return; }
    const [r] = await pool.query('INSERT INTO pages (name, route, sort_order, is_active) VALUES (?, ?, 7, TRUE)', [PAGE_NAME, ROUTE]);
    pageId = r.insertId;
    console.log(`Registered ${ROUTE} (id ${pageId}).`);
  } else console.log(`Page ${ROUTE} already registered (id ${pageId}).`);
  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const u of admins) {
    if (!APPLY) { console.log(`  ~ ${u.display_name}: would get view / add / edit.`); continue; }
    const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, pageId]);
    if (p) await pool.query('UPDATE user_page_permissions SET can_view = TRUE, can_add = TRUE, can_edit = TRUE WHERE id = ?', [p.id]);
    else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit) VALUES (?, ?, TRUE, TRUE, TRUE)', [u.id, pageId]);
  }
  if (APPLY) console.log(`  ${admins.length} System Admin(s) given view / add / edit.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(APPLY ? 'APPLYING.\n' : 'DRY RUN -- nothing will be written (pass --apply).\n');
  const all = await fetchAll();
  const units = all.filter((r) => r.Module_UOM === 'UNIT');
  const pus = all.filter((r) => r.Module_UOM === 'PU');
  const titles = all.filter((r) => r.Module_UOM === 'UOM');
  console.log(`Source: ${units.length} units, ${pus.length} purchase units, ${titles.length} unit titles.\n`);

  // 1. Plain units: every one the source lists or a Purchase Unit / Unit Title names.
  const [have] = await pool.query('SELECT code FROM units_of_measure');
  const haveSet = new Set(have.map((u) => String(u.code).trim().toLowerCase()));
  const wanted = new Set(units.map((u) => txt(u.Name_UOM, 20)).filter(Boolean));
  for (const r of [...pus, ...titles]) {
    for (const k of ['PurchaseUnit_UOM', 'StockUnit_UOM', 'SaleUnit_UOM', 'Unit_UOM']) if (txt(r[k], 20)) wanted.add(txt(r[k], 20));
  }
  const missing = [...wanted].filter((c) => !haveSet.has(c.toLowerCase()));
  console.log(`Plain units missing here: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`);

  if (APPLY) {
    for (const c of missing) await pool.query('INSERT INTO units_of_measure (code, title, is_active) VALUES (?, ?, TRUE)', [c, c]);
    await ensureTables();
  }

  // 2. Purchase Units and 3. Unit Titles, upserted by live_pk.
  const [[puTbl]] = await pool.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'purchase_units'");
  const existingPu = new Set();
  const existingUt = new Set();
  if (puTbl.n) {
    (await pool.query('SELECT live_pk FROM purchase_units'))[0].forEach((r) => existingPu.add(r.live_pk));
    (await pool.query('SELECT live_pk FROM unit_titles'))[0].forEach((r) => existingUt.add(r.live_pk));
  }
  let puNew = 0; let puUpd = 0; let utNew = 0; let utUpd = 0;
  for (const r of pus) {
    const vals = [txt(r.Name_UOM, 60) || '', txt(r.PurchaseUnit_UOM, 30), txt(r.Unit_UOM, 30), flag(r.IsLength_UOM), flag(r.IsWidth_UOM), r.SysPK_UOM];
    if (existingPu.has(r.SysPK_UOM)) puUpd += 1; else puNew += 1;
    if (!APPLY) continue;
    await pool.query(
      `INSERT INTO purchase_units (code, purchase_unit, base_unit, is_length, is_width, live_pk) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE code = VALUES(code), purchase_unit = VALUES(purchase_unit), base_unit = VALUES(base_unit),
         is_length = VALUES(is_length), is_width = VALUES(is_width), updated_at = NOW()`, vals);
  }
  for (const r of titles) {
    const vals = [
      txt(r.UnitTitle_UOM, 100) || txt(r.Name_UOM, 100) || '', txt(r.Name_UOM, 60),
      txt(r.PurchaseUnit_UOM, 30), txt(r.StockUnit_UOM, 30), txt(r.SaleUnit_UOM, 30), txt(r.Unit_UOM, 30),
      num(r.Length_UOM), num(r.Width_UOM), num(r.ConversionRate_UOM),
      flag(r.IsLength_UOM), flag(r.IsWidth_UOM), flag(r.IsPieces_UOM), num(r.Pieces_UOM), r.SysPK_UOM,
    ];
    if (existingUt.has(r.SysPK_UOM)) utUpd += 1; else utNew += 1;
    if (!APPLY) continue;
    await pool.query(
      `INSERT INTO unit_titles (title, name, purchase_unit, stock_unit, sale_unit, base_unit, length, width, conversion,
                                is_length, is_width, is_pieces, pieces, live_pk)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), name = VALUES(name), purchase_unit = VALUES(purchase_unit),
         stock_unit = VALUES(stock_unit), sale_unit = VALUES(sale_unit), base_unit = VALUES(base_unit), length = VALUES(length),
         width = VALUES(width), conversion = VALUES(conversion), is_length = VALUES(is_length), is_width = VALUES(is_width),
         is_pieces = VALUES(is_pieces), pieces = VALUES(pieces), updated_at = NOW()`, vals);
  }
  console.log(`Purchase Units: ${APPLY ? '' : 'would '}add ${puNew}, update ${puUpd}.`);
  console.log(`Unit Titles   : ${APPLY ? '' : 'would '}add ${utNew}, update ${utUpd}.\n`);

  await registerPage();
  await pool.end();
}

main().catch(async (err) => { console.error(err.message || err); await pool.end(); process.exit(1); });
