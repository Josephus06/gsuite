// Lets one newsfeed post carry several photos instead of exactly one.
//
// feed_posts.image_data holds a single data URL, so "add another photo" had nowhere to go.
// This adds the child table that replaces it and copies the existing photos across.
//
//   feed_post_images(post_id, position, image_data)
//
// A child table rather than a JSON array or image_data_2, image_data_3: photos are a list
// whose length nobody knows in advance, one row each is what that is, and it means a page of
// posts fetches its photos in one indexed query instead of reading a widening row.
//
// feed_posts.image_data is deliberately LEFT IN PLACE and simply stops being read. The
// backfill copies rather than moves, so this migration is reversible by reverting the code:
// nothing is destroyed here, and the column can be dropped in its own change once the new
// table has been carrying traffic for a while. It costs disk, not correctness -- no code
// reads it after this, so the two cannot drift apart in any way a user would see.
//
// Idempotent; safe to re-run and safe to run against a live database.
const pool = require('../db');

async function tableExists(name) {
  const [r] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return r.length > 0;
}

const CREATE_SQL = `
  CREATE TABLE feed_post_images (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    post_id    BIGINT NOT NULL,
    -- 0-based, and the order the author arranged them in, not the order they were uploaded.
    position   INT NOT NULL DEFAULT 0,
    image_data MEDIUMTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Covers the only read there is: every photo for a page of posts, already in order.
    INDEX idx_fpi_post (post_id, position),
    CONSTRAINT fk_fpi_post FOREIGN KEY (post_id) REFERENCES feed_posts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// NOT EXISTS rather than a "migrated" flag: re-running must not give a post a second copy of
// its own photo, and the child table already knows which posts it has.
const BACKFILL_SQL = `
  INSERT INTO feed_post_images (post_id, position, image_data)
  SELECT p.id, 0, p.image_data
    FROM feed_posts p
   WHERE p.image_data IS NOT NULL AND p.image_data <> ''
     AND NOT EXISTS (SELECT 1 FROM feed_post_images i WHERE i.post_id = p.id)`;

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Local DB: ${db}`);

  if (await tableExists('feed_post_images')) {
    console.log('  = feed_post_images already exists, skipping create');
  } else {
    await pool.query(CREATE_SQL);
    console.log('  + created feed_post_images');
  }

  const [[before]] = await pool.query(
    "SELECT COUNT(*) AS n FROM feed_posts WHERE image_data IS NOT NULL AND image_data <> ''"
  );
  const [result] = await pool.query(BACKFILL_SQL);
  console.log(`  + copied ${result.affectedRows} of ${before.n} existing post photo(s) across`);

  const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM feed_post_images');
  console.log(`  = feed_post_images now holds ${after.n} row(s)`);

  // Every post that had a photo must have one here, or the feed would quietly lose images.
  const [[missed]] = await pool.query(`
    SELECT COUNT(*) AS n FROM feed_posts p
     WHERE p.image_data IS NOT NULL AND p.image_data <> ''
       AND NOT EXISTS (SELECT 1 FROM feed_post_images i WHERE i.post_id = p.id)`);
  if (missed.n > 0) throw new Error(`${missed.n} post(s) with a photo did not get a row -- not safe to deploy`);
  console.log('  = every post that had a photo has one in the new table');

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
