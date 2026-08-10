// Creates the four tables behind the company newsfeed on /dashboard.
//
// Audience model: a post is 'public' (everyone), 'department' (anyone sharing the author's
// users.user_group_id -- ARTIST/SALES/ADMIN/ACCOUNTING/PURCHASING/LOGISTICS/PRODUCTION) or
// 'private' (author only). The feed query resolves this server-side; the client never gets
// rows it isn't allowed to see, so hiding a post is not a UI concern.
//
// Images ride inline as data URLs in a MEDIUMTEXT, matching how users.avatar_data already
// stores photos in this schema -- no upload directory to provision or back up separately.
// MEDIUMTEXT caps at 16 MB; the client downscales before sending.
//
// Safe to run repeatedly, and safe to run while a year migration is in flight: every table
// here is new, so it touches nothing the importers write to.
const pool = require('../db');

const REACTIONS = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];
const REACTION_ENUM = REACTIONS.map((r) => `'${r}'`).join(',');

const TABLES = [
  ['feed_posts', `
    CREATE TABLE feed_posts (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id       BIGINT NOT NULL,
      body          TEXT,
      image_data    MEDIUMTEXT NULL,
      audience      ENUM('public','department','private') NOT NULL DEFAULT 'public',
      -- Snapshotted from the author at post time so a later transfer between departments
      -- doesn't retroactively move who can read an old 'department' post.
      audience_group_id BIGINT NULL,
      is_deleted    TINYINT(1) NOT NULL DEFAULT 0,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      edited_at     DATETIME NULL,
      INDEX idx_feed_posts_created (is_deleted, created_at DESC, id DESC),
      INDEX idx_feed_posts_user (user_id),
      CONSTRAINT fk_feed_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],

  // One row per (post, user): reacting again with a different type UPDATEs in place, which is
  // why the unique key is on the pair and not on the triple with `type`.
  ['feed_post_reactions', `
    CREATE TABLE feed_post_reactions (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      post_id    BIGINT NOT NULL,
      user_id    BIGINT NOT NULL,
      type       ENUM(${REACTION_ENUM}) NOT NULL DEFAULT 'like',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_feed_post_reaction (post_id, user_id),
      INDEX idx_fpr_post (post_id),
      CONSTRAINT fk_fpr_post FOREIGN KEY (post_id) REFERENCES feed_posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_fpr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],

  // parent_comment_id gives one level of replies (FB collapses deeper nesting to one level too).
  ['feed_comments', `
    CREATE TABLE feed_comments (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      post_id           BIGINT NOT NULL,
      parent_comment_id BIGINT NULL,
      user_id           BIGINT NOT NULL,
      body              TEXT NOT NULL,
      is_deleted        TINYINT(1) NOT NULL DEFAULT 0,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      edited_at         DATETIME NULL,
      INDEX idx_fc_post (post_id, is_deleted, created_at),
      INDEX idx_fc_parent (parent_comment_id),
      CONSTRAINT fk_fc_post FOREIGN KEY (post_id) REFERENCES feed_posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_fc_parent FOREIGN KEY (parent_comment_id) REFERENCES feed_comments(id) ON DELETE CASCADE,
      CONSTRAINT fk_fc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],

  ['feed_comment_reactions', `
    CREATE TABLE feed_comment_reactions (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      comment_id BIGINT NOT NULL,
      user_id    BIGINT NOT NULL,
      type       ENUM(${REACTION_ENUM}) NOT NULL DEFAULT 'like',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_feed_comment_reaction (comment_id, user_id),
      INDEX idx_fcr_comment (comment_id),
      CONSTRAINT fk_fcr_comment FOREIGN KEY (comment_id) REFERENCES feed_comments(id) ON DELETE CASCADE,
      CONSTRAINT fk_fcr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
];

async function tableExists(name) {
  const [r] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return r.length > 0;
}

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Local DB: ${db}`);

  let created = 0;
  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) {
      console.log(`  = ${name} already exists, skipping`);
      continue;
    }
    await pool.query(ddl);
    console.log(`  + created ${name}`);
    created++;
  }

  console.log(created ? `\nDone. ${created} table(s) created.` : '\nDone. Nothing to do.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
