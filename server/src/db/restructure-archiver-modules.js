// Turns the Archiver from a single page into a section with three modules:
//
//   Archiver > Credentials       (what /archiver already was)
//            > Files
//            > Knowledge Base
//
// The existing `/archiver` page row is RENAMED rather than replaced. Its id stays the same, so
// every user_page_permissions row still points at it and nobody loses the access they were
// granted yesterday -- deleting and re-inserting would silently revoke the lot.
//
// Splitting into three page rows is the point, not a side effect: permissions become per module,
// so someone can be given Files without being given the credentials vault. One page row for the
// whole section would have made "can use the Archiver" mean "can see every password in it".
//
//   node src/db/restructure-archiver-modules.js --dry-run
//   node src/db/restructure-archiver-modules.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const OLD_ROUTE = '/archiver';
const RENAMED = { route: '/archiver/credentials', name: 'Credentials', module: 'Archiver' };

const NEW_PAGES = [
  { route: '/archiver/files', name: 'Files', module: 'Archiver' },
  { route: '/archiver/knowledge-base', name: 'Knowledge Base', module: 'Archiver' },
];

async function pageColumns() {
  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  return new Set(cols.map((c) => c.Field));
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const has = await pageColumns();

  // --- Rename the existing page, preserving its id and therefore its grants ------------------
  const [[old]] = await pool.query('SELECT id, name FROM pages WHERE route = ?', [OLD_ROUTE]);
  const [[already]] = await pool.query('SELECT id FROM pages WHERE route = ?', [RENAMED.route]);

  if (already) {
    console.log(`Page ${RENAMED.route} already exists (id ${already.id}) -- nothing to rename.`);
  } else if (!old) {
    console.log(`Neither ${OLD_ROUTE} nor ${RENAMED.route} is registered. Run create-archiver-module.js first.`);
  } else {
    const [[grants]] = await pool.query('SELECT COUNT(*) n FROM user_page_permissions WHERE page_id = ?', [old.id]);
    if (DRY_RUN) {
      console.log(`Would rename ${OLD_ROUTE} -> ${RENAMED.route} ("${RENAMED.name}"), keeping id ${old.id} and its ${grants.n} permission row(s).`);
    } else {
      await pool.query('UPDATE pages SET route = ?, name = ? WHERE id = ?', [RENAMED.route, RENAMED.name, old.id]);
      console.log(`Renamed ${OLD_ROUTE} -> ${RENAMED.route} ("${RENAMED.name}"), id ${old.id} kept with its ${grants.n} permission row(s).`);
    }
  }

  // --- The two new modules --------------------------------------------------------------------
  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");

  for (const p of NEW_PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) console.log(`\nPage ${p.route} already registered (id ${page.id}).`);
    else if (DRY_RUN) console.log(`\nWould register ${p.route} as "${p.name}".`);
    else {
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

  // Anyone who had the old Archiver page keeps Credentials, and ONLY Credentials. Files is a
  // separate grant on purpose -- inheriting it would hand the whole section to everyone who was
  // ever given the vault, which is the opposite of why this was split up.
  console.log('\nNote: existing users keep their Credentials access. Files and Knowledge Base are');
  console.log('separate permissions and must be granted deliberately at Users & Permissions.');

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
