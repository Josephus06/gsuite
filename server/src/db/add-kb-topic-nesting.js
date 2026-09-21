// Lets a Knowledge Base card hold cards of its own.
//
// The base was two fixed levels: a section (Products, Equipment / Machine, Technical Problem)
// holding cards (LFP, DPOD, SIGNAGE, CNC), and a card holding files. That is enough until the
// first person wants "LFP > Printheads > Roland" -- at which point the only options are a flat
// card called "LFP Printheads Roland" or a new section for every machine, and both are how a
// knowledge base stops being navigable.
//
// One nullable self-reference gives arbitrary depth. A card with parent_topic_id NULL is a card
// on the section's front page, exactly as today; a card with a parent is a card inside another.
// Nothing about the existing nine rows changes -- they all become roots by virtue of the column
// defaulting to NULL.
//
// NO FOREIGN KEY, matching the rest of this schema: the archiver tables carry indexes only, so a
// partial load cannot wedge on a missing parent. The cost is that nothing in the database stops an
// orphan or a cycle, so the ROUTE enforces both -- a card cannot be moved inside its own
// descendant, and a card with children refuses to delete.
//
// ALGORITHM=INSTANT with no AFTER clause. Appending a column is metadata-only; positioning it
// rebuilds the whole table behind an exclusive lock, which is a strange price to pay for the
// column order in a DESCRIBE.
//
// IDEMPOTENT: safe to re-run; an existing column and index are reported and skipped.
//
//   node src/db/add-kb-topic-nesting.js [--dry-run]
const pool = require('../db');

const DRY = process.argv.includes('--dry-run');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}
async function indexExists(table, name) {
  const [rows] = await pool.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
  return rows.length > 0;
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY ? '   (DRY RUN -- nothing will be written)' : ''}`);

    const hasCol = await colExists('kb_topics', 'parent_topic_id');
    const hasIdx = await indexExists('kb_topics', 'idx_kb_topics_parent');

    if (hasCol) {
      console.log('  kb_topics.parent_topic_id exists -- skipped');
    } else if (DRY) {
      console.log('  WOULD add kb_topics.parent_topic_id BIGINT NULL');
    } else {
      const ddl = 'ALTER TABLE kb_topics ADD COLUMN parent_topic_id BIGINT NULL';
      try {
        await pool.query(`${ddl}, ALGORITHM=INSTANT`);
      } catch (err) {
        if (err.errno !== 1064) throw err;
        console.log('  (this MySQL has no ALGORITHM=INSTANT; adding it the ordinary way)');
        await pool.query(ddl);
      }
      console.log('  Added kb_topics.parent_topic_id');
    }

    if (hasIdx) {
      console.log('  kb_topics.idx_kb_topics_parent exists -- skipped');
    } else if (DRY) {
      console.log('  WOULD add index idx_kb_topics_parent (parent_topic_id)');
    } else {
      // Every page load asks "what are this card's children" and "what are this section's roots".
      // Both read this column, and without an index both become a table scan per card drawn.
      await pool.query('ALTER TABLE kb_topics ADD INDEX idx_kb_topics_parent (parent_topic_id)');
      console.log('  Added index idx_kb_topics_parent');
    }

    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(${hasCol || !DRY ? 'parent_topic_id IS NULL' : '1'}) AS roots
         FROM kb_topics WHERE is_active = TRUE`
    );
    console.log(`\n${counts.total} active cards, ${counts.roots} of them at the top of a section.`);
    console.log('Existing cards are unaffected: a NULL parent is what "on the section front page" means.');
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
