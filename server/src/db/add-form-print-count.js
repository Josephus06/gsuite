// One-off migration (2026-11-23): a Fuel Slip prints ONCE; only a System Admin may reprint it.
// form_requests gets the count and the first print's when / who (routes/forms.js POST /:id/printed).
//
//   node src/db/add-form-print-count.js [--dry-run]
//
// The droplet, office and SM boxes replicate: run on ONE box (the droplet). Railway: run it there too.
// Until it runs, the code treats every form as never printed (no restriction) rather than failing.
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const COLUMNS = [
  ['print_count', 'INT NOT NULL DEFAULT 0'],
  ['first_printed_at', 'DATETIME NULL'],
  ['first_printed_by', 'BIGINT NULL'],
];

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);
  const [cols] = await pool.query('SHOW COLUMNS FROM form_requests');
  const have = new Set(cols.map((c) => c.Field));
  for (const [name, def] of COLUMNS) {
    if (have.has(name)) { console.log(`  = form_requests.${name} already exists`); continue; }
    if (DRY_RUN) { console.log(`  ~ would add form_requests.${name} ${def}`); continue; }
    await pool.query(`ALTER TABLE form_requests ADD COLUMN ${name} ${def}`);
    console.log(`  + added form_requests.${name}`);
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
