// One-off migration: Design > AI Rendering (asked 2026-10-07). A designer uploads a photo of the
// client's site (and, optionally, the client's logo), types what to put there -- "a lighted
// circular signage with this logo above the door" -- and OpenAI's image model paints it into the
// photo (routes/aiRenderings.js). Each result is kept here with what was asked, by whom, for which
// customer and (optionally) estimate.
//
// The pictures are LONGBLOBs, like every other attachment in T1S, so they replicate to the office
// and SM boxes with the rest of the database. Sources are stored once, on the first rendering; a
// variation points back at it (source_rendering_id) instead of copying the photos again.
//
// RUN BEFORE THE CODE REACHES THE BOX: requirePermission faults when the page row is missing.
//
//   node src/db/create-ai-renderings.js --dry-run
//   node src/db/create-ai-renderings.js
// Droplet, office and SM replicate: run on ONE box (the droplet).
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PAGES = [{ route: '/ai-renderings', name: 'AI Rendering', module: 'Design' }];

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ai_renderings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NULL,
  estimate_id INT NULL,
  source_rendering_id INT NULL,
  prompt TEXT NOT NULL,
  quality VARCHAR(10) NOT NULL,
  size VARCHAR(12) NOT NULL,
  model VARCHAR(40) NOT NULL,
  site_image LONGBLOB NULL,
  site_mime VARCHAR(60) NULL,
  logo_image LONGBLOB NULL,
  logo_mime VARCHAR(60) NULL,
  result_image LONGBLOB NOT NULL,
  result_mime VARCHAR(60) NOT NULL,
  result_bytes INT NOT NULL,
  input_tokens INT NULL,
  output_tokens INT NULL,
  estimate_attachment_id INT NULL,
  created_by_user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai_renderings_user_day (created_by_user_id, created_at),
  KEY idx_ai_renderings_customer (customer_id),
  KEY idx_ai_renderings_estimate (estimate_id)
)`;

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const [[exists]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'ai_renderings'");
  if (exists.n) console.log('Table ai_renderings already exists.');
  else if (DRY_RUN) console.log('Would create table ai_renderings.');
  else { await pool.query(TABLE_SQL); console.log('Created table ai_renderings.'); }

  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) console.log(`Page ${p.route} already registered (id ${page.id}).`);
    else if (DRY_RUN) console.log(`Would register ${p.route} as "${p.name}".`);
    else {
      const [cols] = await pool.query('SHOW COLUMNS FROM pages');
      const has = new Set(cols.map((c) => c.Field));
      const fields = ['route', 'name']; const values = [p.route, p.name];
      if (has.has('module')) { fields.push('module'); values.push(p.module); }
      const [result] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
      page = { id: result.insertId };
      console.log(`Registered ${p.route} as "${p.name}" (id ${page.id}).`);
    }
    if (!page) continue;
    for (const user of admins) {
      const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id]);
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
      if (existing) await pool.query('UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?', [existing.id]);
      else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)', [user.id, page.id]);
      console.log(`  + ${user.display_name}: full access.`);
    }
  }
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
