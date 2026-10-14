// Feed posts for chosen people (asked 2026-10-14: "set a group of users who can only see a post,
// not just per department"). A fourth audience, 'custom': only the people listed here (and the
// author) see the post.
//
// Appending a value to the END of an ENUM is a metadata-only change in MySQL 8 -- no table rebuild.
//   node src/db/add-feed-custom-audience.js
// Safe to re-run. Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [[col]] = await pool.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feed_posts' AND COLUMN_NAME = 'audience'`);
  if (String(col.t).includes("'custom'")) console.log('feed_posts.audience already has custom');
  else {
    await pool.query("ALTER TABLE feed_posts MODIFY audience ENUM('public','department','private','custom') NOT NULL DEFAULT 'public'");
    console.log('feed_posts.audience: custom added');
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_post_audience_users (
      post_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      PRIMARY KEY (post_id, user_id),
      KEY idx_fpau_user (user_id)
    )`);
  console.log('feed_post_audience_users ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
