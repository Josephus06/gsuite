// Bring the Railway sandbox's schema up to the droplet's (asked 2026-10-19). Railway redeploys the
// code by itself, but migrations are run by hand on the droplet only, so the sandbox kept running new
// code on an old schema: on 2026-10-19 its login failed on users.can_edit_approved_po, and it was
// 25 tables, 91 columns, 18 indexes and 13 pages behind.
//
// Run from a machine that has BOTH server/.env.railway and SSH to the droplet (this PC). The droplet
// is read over SSH, read-only (information_schema / SHOW CREATE TABLE / pages); Railway is compared to
// it and what is MISSING there is added, using the droplet's own definitions:
//
//   tables    the droplet's SHOW CREATE TABLE, as CREATE TABLE IF NOT EXISTS
//   columns   ALTER TABLE ... ADD COLUMN with the droplet's type, nullability, default and extra
//   indexes   ALTER TABLE ... ADD [UNIQUE] INDEX, same name and columns
//   pages     pages rows (name, route, order); Railway's System Admins get every right on each
//
// Only ever ADDS. Nothing on Railway is dropped, altered or overwritten, and no other data is copied
// (app_settings stays empty there: its doc_no_slots belongs to the replicated boxes, not the sandbox).
// A column whose type differs is WIDENED to the droplet's when that loses nothing -- an enum that
// only gains values (sales_orders.status + 'partially_billed'), a decimal that only grows in integer
// digits and scale (purchase_order_lines.rate 14,4 -> 18,6). Any other difference is reported only.
//
//   node src/db/sync-railway-schema.js            # report what Railway is missing
//   node src/db/sync-railway-schema.js --apply    # add it
//   DROPLET_SSH=root@<host> node src/db/sync-railway-schema.js   # another source box
const { execFileSync } = require('child_process');
const path = require('path');
const mysql = require('mysql2/promise');

const SERVER_DIR = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(SERVER_DIR, '.env') });
require('dotenv').config({ path: path.join(SERVER_DIR, '.env.railway'), override: true });

const APPLY = process.argv.includes('--apply');
const SSH = process.env.DROPLET_SSH || 'root@146.190.103.165';
const SRC_DB = process.env.DROPLET_DB || 'gsuite_erp';
const MY_CNF = '/root/.my.gsuite.cnf';

// One read-only query on the droplet, raw (-r) so a value may span lines. Each row's columns are
// tab-separated; callers that need structure ask MySQL for JSON instead. The SQL goes in on stdin, so
// no shell ever has to quote it.
function droplet(sql) {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=20', SSH, `mysql --defaults-file=${MY_CNF} ${SRC_DB} -N -B -r`],
    { input: `${sql};\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const dropletJson = (sql) => JSON.parse(droplet(sql).trim() || '[]');
const key = (...p) => p.join('.').toLowerCase();

// Is changing Railway's column type FROM -> TO lossless? Enum: every old value is kept. Decimal: no
// fewer integer digits and no fewer decimal places (and not signed where it was unsigned).
const enumValues = (t) => (String(t).match(/'((?:[^']|'')*)'/g) || []).map((v) => v.slice(1, -1));
function isWidening(from, to) {
  const a = String(from).toLowerCase(); const b = String(to).toLowerCase();
  if (a.startsWith('enum(') && b.startsWith('enum(')) {
    const have = new Set(enumValues(b));
    return enumValues(a).every((v) => have.has(v));
  }
  const da = a.match(/^decimal\((\d+),(\d+)\)/); const db = b.match(/^decimal\((\d+),(\d+)\)/);
  if (da && db) {
    const [pa, sa] = [Number(da[1]), Number(da[2])]; const [pb, sb] = [Number(db[1]), Number(db[2])];
    return sb >= sa && (pb - sb) >= (pa - sa) && !(a.includes('unsigned') && !b.includes('unsigned'));
  }
  return false;
}

(async () => {
  console.log(`Source: ${SSH} ${SRC_DB}   Target: ${process.env.DB_HOST} ${process.env.DB_NAME}   ${APPLY ? 'APPLYING' : 'REPORT ONLY'}\n`);
  const rw = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 30000,
  });

  const srcCols = dropletJson(`SELECT JSON_ARRAYAGG(JSON_OBJECT('t', TABLE_NAME, 'c', COLUMN_NAME, 'type', COLUMN_TYPE,
      'nullable', IS_NULLABLE, 'def', COLUMN_DEFAULT, 'extra', EXTRA, 'pos', ORDINAL_POSITION))
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
  const srcIdx = dropletJson(`SELECT JSON_ARRAYAGG(JSON_OBJECT('t', t, 'i', i, 'u', u, 'cols', cols)) FROM (
      SELECT TABLE_NAME t, INDEX_NAME i, MIN(NON_UNIQUE) u, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME <> 'PRIMARY'
       GROUP BY TABLE_NAME, INDEX_NAME) x`);
  const srcPages = dropletJson(`SELECT JSON_ARRAYAGG(JSON_OBJECT('route', route, 'name', name, 'sort', COALESCE(sort_order, 0), 'active', is_active)) FROM pages`);

  const [dstCols] = await rw.query('SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
  const [dstIdx] = await rw.query("SELECT TABLE_NAME t, INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME <> 'PRIMARY' GROUP BY 1, 2");
  const [dstPages] = await rw.query('SELECT route FROM pages');

  const dstTables = new Set(dstCols.map((r) => r.t.toLowerCase()));
  const dstColMap = new Map(dstCols.map((r) => [key(r.t, r.c), r.type]));
  const dstIdxSet = new Set(dstIdx.map((r) => key(r.t, r.i)));
  const dstRoutes = new Set(dstPages.map((r) => r.route));

  const missingTables = [...new Set(srcCols.map((r) => r.t))].filter((t) => !dstTables.has(t.toLowerCase())).sort();
  const missingCols = srcCols.filter((r) => dstTables.has(r.t.toLowerCase()) && !dstColMap.has(key(r.t, r.c)))
    .sort((a, b) => a.t.localeCompare(b.t) || a.pos - b.pos);
  const typeDiffs = srcCols.filter((r) => dstColMap.has(key(r.t, r.c)) && String(dstColMap.get(key(r.t, r.c))).toLowerCase() !== String(r.type).toLowerCase());
  const missingIdx = srcIdx.filter((r) => dstTables.has(r.t.toLowerCase()) && !dstIdxSet.has(key(r.t, r.i)));
  const missingPages = srcPages.filter((p) => !dstRoutes.has(p.route));

  console.log(`Missing tables : ${missingTables.length}${missingTables.length ? `  ${missingTables.join(', ')}` : ''}`);
  console.log(`Missing columns: ${missingCols.length}`);
  const byTable = {};
  for (const c of missingCols) (byTable[c.t] = byTable[c.t] || []).push(c.c);
  for (const [t, cs] of Object.entries(byTable)) console.log(`   ${t}: ${cs.join(', ')}`);
  console.log(`Missing indexes: ${missingIdx.length}`);
  for (const i of missingIdx) console.log(`   ${i.t}.${i.i} (${i.cols})`);
  console.log(`Missing pages  : ${missingPages.length}`);
  for (const p of missingPages) console.log(`   ${p.route} -- ${p.name}`);
  const widen = typeDiffs.filter((r) => isWidening(dstColMap.get(key(r.t, r.c)), r.type));
  const otherDiffs = typeDiffs.filter((r) => !widen.includes(r));
  console.log(`Columns to widen: ${widen.length}`);
  widen.forEach((r) => console.log(`   ${r.t}.${r.c}: ${dstColMap.get(key(r.t, r.c))} -> ${r.type}`));
  if (otherDiffs.length) {
    console.log(`\nOther column type differences (reported, NOT changed): ${otherDiffs.length}`);
    otherDiffs.slice(0, 30).forEach((r) => console.log(`   ${r.t}.${r.c}: droplet ${r.type}, Railway ${dstColMap.get(key(r.t, r.c))}`));
  }

  const statements = [];
  for (const t of missingTables) {
    const out = droplet(`SHOW CREATE TABLE \`${t}\``);
    const ddl = out.slice(out.indexOf('\t') + 1).trim();
    statements.push(ddl.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '));
  }
  const colDef = (c) => {
    let def = `${c.type} ${c.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`;
    if (c.def !== null && c.def !== undefined) {
      const expr = /DEFAULT_GENERATED/i.test(c.extra || '') || /^(CURRENT_TIMESTAMP|now\(\))/i.test(c.def);
      def += ` DEFAULT ${expr ? c.def : rw.escape(c.def)}`;
    }
    const extra = String(c.extra || '').replace(/DEFAULT_GENERATED/i, '').trim();
    if (extra) def += ` ${extra}`;
    return def;
  };
  for (const c of missingCols) statements.push(`ALTER TABLE \`${c.t}\` ADD COLUMN \`${c.c}\` ${colDef(c)}`);
  for (const c of widen) statements.push(`ALTER TABLE \`${c.t}\` MODIFY COLUMN \`${c.c}\` ${colDef(c)}`);
  for (const i of missingIdx) {
    statements.push(`ALTER TABLE \`${i.t}\` ADD ${Number(i.u) ? 'INDEX' : 'UNIQUE INDEX'} \`${i.i}\` (${String(i.cols).split(',').map((x) => `\`${x}\``).join(', ')})`);
  }

  if (!APPLY) {
    console.log(`\n${statements.length} schema statement(s) and ${missingPages.length} page(s) would be added. Run with --apply.`);
    await rw.end();
    return;
  }

  let ok = 0; let failed = 0;
  await rw.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const s of statements) {
    try { await rw.query(s); ok += 1; } catch (e) { failed += 1; console.log(`FAILED: ${s.slice(0, 120).replace(/\s+/g, ' ')} -> ${e.code} ${e.message.slice(0, 160)}`); }
  }
  await rw.query('SET FOREIGN_KEY_CHECKS = 1');

  if (missingPages.length) {
    const [permCols] = await rw.query('SHOW COLUMNS FROM user_page_permissions');
    const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
    const [admins] = await rw.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = 1");
    for (const p of missingPages) {
      const [ins] = await rw.query('INSERT INTO pages (name, route, sort_order, is_active) VALUES (?, ?, ?, ?)', [p.name, p.route, Number(p.sort), Number(p.active)]);
      for (const a of admins) {
        await rw.query(`INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')}) VALUES (?, ?, ${flags.map(() => 'TRUE').join(', ')})`, [a.id, ins.insertId]);
      }
    }
    console.log(`Pages added: ${missingPages.length} (every right given to ${admins.length} System Admin(s)).`);
  }
  console.log(`\nSchema statements: ${ok} applied, ${failed} failed.`);
  await rw.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
