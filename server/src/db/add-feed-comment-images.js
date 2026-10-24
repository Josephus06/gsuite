// A newsfeed comment can carry one photo (asked 2026-10-24), as on Facebook. Stored inline as a data
// URL like a post's photos (feed_post_images) and served by GET /api/feed/comment-images/:commentId.
//
// Idempotent:  node src/db/add-feed-comment-images.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[has]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feed_comments' AND COLUMN_NAME = 'image_data'");
  if (!has.n) {
    await pool.query('ALTER TABLE feed_comments ADD COLUMN image_data MEDIUMTEXT NULL AFTER body');
    console.log('  feed_comments.image_data added');
  } else console.log('  feed_comments.image_data already there');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
