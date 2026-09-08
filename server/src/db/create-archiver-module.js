// One-off migration: creates the Archiver -- a vault for the credentials behind the company's
// subscriptions, licences and accounts.
//
// Three things make this different from every other table in this app, and all three are why the
// module exists rather than people keeping a spreadsheet:
//
//  1. SECRETS ARE ENCRYPTED AT REST (AES-256-GCM, see lib/archiverCrypto.js). The database is
//     dumped for backups and those dumps travel; a plaintext password column would mean every
//     copy of the backup is a copy of every credential. Encrypted, a leaked dump is inert without
//     the key, which lives in the environment and never in the database.
//
//  2. REVEALING A SECRET IS AN EVENT, NOT A READ. Nothing returns a decrypted secret in a list.
//     A reveal needs a fresh emailed code, and every reveal -- and every failed attempt -- is
//     written to archive_access_logs. A vault whose whole value is "who saw this, and when"
//     cannot treat that as optional.
//
//  3. ACCESS IS PER ENTRY, NOT PER PAGE. Page permissions say who may use the Archiver at all;
//     archive_entry_shares say which entries a given person may open. Someone with no share on an
//     entry does not see that it exists.
//
// THE ENCRYPTION KEY MUST BE IDENTICAL ON THE DROPLET AND THE OFFICE BOX. They are master-master
// replicated, so a row encrypted on one arrives on the other; different keys mean half the vault
// fails to decrypt depending on which server happened to serve the write. Exactly the same
// reasoning as JWT_SECRET, and the same failure mode -- intermittent and baffling. Railway holds
// its own separate data, so its key may differ, but it must never be restored from a dump of the
// pair without its key coming too.
//
//   node src/db/create-archiver-module.js --dry-run
//   node src/db/create-archiver-module.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  { route: '/archiver', name: 'Archiver', module: 'Archiver' },
];

const TABLES = [
  // Folders, so a few hundred credentials stay navigable. Flat, not nested -- a tree invites
  // people to file things three levels deep and then lose them.
  ['archive_categories', `
CREATE TABLE archive_categories (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(500) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uq_archive_categories_name (name)
)`],

  // One credential. Everything here is safe to list EXCEPT secret_ciphertext, which is never
  // selected by any list query -- see routes/archiver.js.
  //
  // secret_ciphertext / secret_iv / secret_tag are the three parts AES-256-GCM needs. The tag is
  // what makes the ciphertext tamper-evident: edit a byte of it in the database and decryption
  // fails loudly rather than returning quiet rubbish.
  //
  // key_version exists so the key can be rotated later without a flag day -- rows re-encrypt on
  // next write and old rows stay readable meanwhile.
  ['archive_entries', `
CREATE TABLE archive_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    entry_no VARCHAR(40) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    entry_type VARCHAR(30) NOT NULL DEFAULT 'subscription',
    category_id BIGINT NULL,
    vendor VARCHAR(200) NULL,
    url VARCHAR(500) NULL,
    username VARCHAR(255) NULL,
    secret_ciphertext BLOB NULL,
    secret_iv VARBINARY(16) NULL,
    secret_tag VARBINARY(16) NULL,
    key_version INT NOT NULL DEFAULT 1,
    has_secret BOOLEAN NOT NULL DEFAULT FALSE,
    notes VARCHAR(2000) NULL,
    account_reference VARCHAR(200) NULL,
    renews_on DATE NULL,
    expires_on DATE NULL,
    cost DECIMAL(16,2) NULL,
    billing_cycle VARCHAR(30) NULL,
    owner_user_id BIGINT NULL,
    department_id BIGINT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id BIGINT NULL,
    updated_at DATETIME NULL,
    secret_updated_at DATETIME NULL,
    INDEX idx_archive_entries_owner (owner_user_id),
    INDEX idx_archive_entries_category (category_id),
    INDEX idx_archive_entries_status (status),
    INDEX idx_archive_entries_renews (renews_on)
)`],

  // Who may open which entry. The owner is implicit and always allowed; these are the others.
  // can_reveal is separate from mere visibility: a colleague may need to know the subscription
  // exists and when it renews without being handed its password.
  ['archive_entry_shares', `
CREATE TABLE archive_entry_shares (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    entry_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    can_reveal BOOLEAN NOT NULL DEFAULT TRUE,
    can_edit BOOLEAN NOT NULL DEFAULT FALSE,
    granted_by_user_id BIGINT NULL,
    granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_archive_share (entry_id, user_id),
    INDEX idx_archive_shares_user (user_id)
)`],

  // A step-up challenge. Codes are stored HASHED, never in the clear: this table is the one place
  // an attacker with read access to the database could otherwise mint their own reveal.
  //
  // consumed_at makes a code single-use. attempts caps guessing -- six digits is a million
  // combinations, which is plenty against a human and nothing against a script.
  ['archive_verifications', `
CREATE TABLE archive_verifications (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    entry_id BIGINT NOT NULL,
    purpose VARCHAR(30) NOT NULL DEFAULT 'reveal',
    code_hash VARCHAR(255) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    sent_to VARCHAR(255) NULL,
    attempts INT NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_archive_verif_lookup (user_id, entry_id, consumed_at),
    INDEX idx_archive_verif_expiry (expires_at)
)`],

  // The reason the vault is worth having. Every reveal, every failed code, every share change.
  // Append-only by convention -- there is no route that edits or deletes a row here.
  ['archive_access_logs', `
CREATE TABLE archive_access_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    entry_id BIGINT NULL,
    user_id BIGINT NULL,
    action VARCHAR(40) NOT NULL,
    outcome VARCHAR(20) NOT NULL DEFAULT 'success',
    detail VARCHAR(500) NULL,
    ip_address VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_archive_logs_entry (entry_id, created_at),
    INDEX idx_archive_logs_user (user_id, created_at),
    INDEX idx_archive_logs_action (action)
)`],
];

const SEED_CATEGORIES = [
  ['Software Subscription', 'SaaS and recurring software accounts'],
  ['Software Licence', 'Perpetual licences and product keys'],
  ['Domain & Hosting', 'Registrars, DNS, servers and hosting panels'],
  ['Email & Communications', 'Mail, messaging and telephony accounts'],
  ['Government & Compliance', 'BIR, SSS, PhilHealth, Pag-IBIG and similar portals'],
  ['Banking & Finance', 'Banking portals and payment gateways'],
  ['Utilities', 'Electricity, water, internet and telecom accounts'],
  ['Equipment & Devices', 'Router, NAS, CCTV and device admin logins'],
  ['Social & Marketing', 'Social platforms and advertising accounts'],
  ['Other', 'Anything that does not fit the categories above'],
];

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) console.log(`Table ${name} already exists.`);
    else if (DRY_RUN) console.log(`Would create table ${name}.`);
    else { await pool.query(ddl); console.log(`Created table ${name}.`); }
  }

  console.log('');
  if (await tableExists('archive_categories')) {
    for (const [name, description] of SEED_CATEGORIES) {
      const [[found]] = await pool.query('SELECT id FROM archive_categories WHERE name = ?', [name]);
      if (found) { console.log(`  ok    ${name}`); continue; }
      if (DRY_RUN) { console.log(`  +     would seed ${name}`); continue; }
      await pool.query('INSERT INTO archive_categories (name, description) VALUES (?, ?)', [name, description]);
      console.log(`  +     ${name}`);
    }
  } else if (DRY_RUN) {
    console.log(`  ~ would seed ${SEED_CATEGORIES.length} categories.`);
  }

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

  // The key is deliberately NOT generated here. A migration that invents a key and prints it
  // guarantees the key ends up in a terminal scrollback, and on a replicated pair it guarantees
  // the two boxes get different ones.
  console.log('\n--- ARCHIVER_KEY ---');
  if (process.env.ARCHIVER_KEY) {
    console.log('ARCHIVER_KEY is set in this environment. Secrets can be stored.');
  } else {
    console.log('ARCHIVER_KEY is NOT set. The Archiver will refuse to store or reveal secrets');
    console.log('until it is. Generate ONE key and put the SAME value in the .env of the droplet');
    console.log('and the office box (they replicate to each other, so a mismatch makes half the');
    console.log('vault undecryptable). Railway keeps its own data and may have its own key.');
    console.log('');
    console.log('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
