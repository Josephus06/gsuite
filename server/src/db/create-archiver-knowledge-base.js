// Archiver > Knowledge Base: reference material, filed two levels deep.
//
//   Products              <- section, seeded and fixed
//     LFP  DPOD  SIGNAGE  CNC        <- topics, seeded
//   Equipment / Machine   <- section, seeded and fixed
//     LFP  DPOD  SIGNAGE  CNC        <- topics, seeded
//   Technical Problem     <- section, seeded and fixed
//     (whatever people add)          <- topics, created as problems come up
//
// Two levels and no more. A tree of arbitrary depth is how a shared drive becomes unnavigable:
// somebody files a manual four folders down and nobody finds it again. Section then topic then
// files is shallow enough that everything is two clicks from the front page.
//
// SECTIONS ARE SEEDED AND FLAGGED is_system. Topics are freely added, renamed and removed, but the
// three sections are the shape of the thing and deleting one would strand everything beneath it.
// Technical Problem starts empty by design -- its topics ARE the problems, and inventing them up
// front would just be guessing.
//
// Files follow the same two-path rule as Archiver > Files: small ones live in the database so the
// office box can still read them with the internet down, large ones go to object storage. Sharing
// the rule rather than inventing a second one means one place to reason about, and the storage
// columns are deliberately identical to archive_file_versions.
//
//   node src/db/create-archiver-knowledge-base.js --dry-run
//   node src/db/create-archiver-knowledge-base.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const TABLES = [
  ['kb_sections', `
CREATE TABLE kb_sections (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(60) NOT NULL,
    description VARCHAR(500) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uq_kb_sections_slug (slug)
)`],

  ['kb_topics', `
CREATE TABLE kb_topics (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    section_id BIGINT NOT NULL,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(1000) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id BIGINT NULL,
    updated_at DATETIME NULL,
    INDEX idx_kb_topics_section (section_id, sort_order),
    UNIQUE KEY uq_kb_topic_name (section_id, name)
)`],

  // size_bytes is BIGINT from the outset. archive_file_versions shipped it as INT and had to be
  // widened once a 150GB file appeared; there is no reason to repeat that.
  ['kb_files', `
CREATE TABLE kb_files (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    topic_id BIGINT NOT NULL,
    title VARCHAR(200) NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(120) NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    checksum_sha256 CHAR(64) NULL,
    storage VARCHAR(10) NOT NULL DEFAULT 'db',
    file_data LONGBLOB NULL,
    storage_key VARCHAR(500) NULL,
    storage_bucket VARCHAR(150) NULL,
    storage_etag VARCHAR(120) NULL,
    upload_id VARCHAR(500) NULL,
    upload_status VARCHAR(20) NOT NULL DEFAULT 'complete',
    note VARCHAR(500) NULL,
    uploaded_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_kb_files_topic (topic_id, created_at),
    INDEX idx_kb_files_upload_status (upload_status)
)`],
];

// The three sections, and the topics that are known up front. Technical Problem gets none:
// its topics are the problems themselves, and pre-inventing them would be guessing.
const SEED = [
  { name: 'Products', slug: 'products', sort: 1,
    description: 'Product specifications, catalogues and sample references',
    topics: ['LFP', 'DPOD', 'SIGNAGE', 'CNC'] },
  { name: 'Equipment / Machine', slug: 'equipment', sort: 2,
    description: 'Machine manuals, settings, maintenance and spare parts',
    topics: ['LFP', 'DPOD', 'SIGNAGE', 'CNC'] },
  { name: 'Technical Problem', slug: 'technical-problem', sort: 3,
    description: 'Problems and their fixes, added as they come up',
    topics: [] },
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
  if (!(await tableExists('kb_sections'))) {
    console.log(`Would seed ${SEED.length} sections and their topics.`);
    await pool.end();
    return;
  }

  for (const s of SEED) {
    let [[section]] = await pool.query('SELECT id FROM kb_sections WHERE slug = ?', [s.slug]);
    if (section) console.log(`Section "${s.name}" already exists (id ${section.id}).`);
    else if (DRY_RUN) { console.log(`Would seed section "${s.name}" with ${s.topics.length} topic(s).`); continue; }
    else {
      const [r] = await pool.query(
        'INSERT INTO kb_sections (name, slug, description, sort_order, is_system) VALUES (?,?,?,?,TRUE)',
        [s.name, s.slug, s.description, s.sort],
      );
      section = { id: r.insertId };
      console.log(`Seeded section "${s.name}" (id ${section.id}).`);
    }

    for (const [i, topicName] of s.topics.entries()) {
      const [[t]] = await pool.query('SELECT id FROM kb_topics WHERE section_id = ? AND name = ?', [section.id, topicName]);
      if (t) { console.log(`  ok    ${topicName}`); continue; }
      if (DRY_RUN) { console.log(`  +     would seed ${topicName}`); continue; }
      await pool.query('INSERT INTO kb_topics (section_id, name, sort_order) VALUES (?,?,?)', [section.id, topicName, i + 1]);
      console.log(`  +     ${topicName}`);
    }
    if (!s.topics.length) console.log('  (no topics -- added as problems come up)');
  }

  // The page row already exists from restructure-archiver-modules.js. Reported rather than
  // re-created, so a missing one is visible instead of silently absent.
  const [[page]] = await pool.query("SELECT id, name FROM pages WHERE route = '/archiver/knowledge-base'");
  console.log(`\nPage /archiver/knowledge-base: ${page ? `registered (id ${page.id})` : 'MISSING -- run restructure-archiver-modules.js'}`);

  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
