// Feed videos (asked 2026-10-13): up to 5 GB each. NOT in the database, unlike feed photos -- a
// 5 GB row would choke replication -- but as files on the cloud server's disk (lib/feedVideos.js),
// with this table holding who uploaded what, how much of it has arrived, and which post shows it.
//
//   status 'uploading' -> 'ready' once every byte is in; post_id is set when a post uses it.
//
//   node src/db/add-feed-videos.js
// Safe to re-run. Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_videos (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      post_id BIGINT NULL,
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes BIGINT NOT NULL,
      received_bytes BIGINT NOT NULL DEFAULT 0,
      storage_name VARCHAR(64) NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'uploading',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      UNIQUE KEY uq_feed_videos_storage (storage_name),
      KEY idx_feed_videos_post (post_id),
      KEY idx_feed_videos_user_status (user_id, status)
    ) DEFAULT CHARSET=utf8mb4`);
  console.log('feed_videos ready.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
