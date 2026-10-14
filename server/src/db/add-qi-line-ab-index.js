// An Assembly Build's Quality Inspections (2026-10-14: AB Related Records) are found through
// quality_inspection_lines.assembly_build_id, which had no index -- 148k rows scanned on every AB
// opened. Online index build (InnoDB); idempotent.
//   node src/db/add-qi-line-ab-index.js
// Droplet and office replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [have] = await pool.query("SHOW INDEX FROM quality_inspection_lines WHERE Key_name = 'idx_qil_assembly_build_id'");
  if (have.length) console.log('idx_qil_assembly_build_id already there');
  else {
    await pool.query('CREATE INDEX idx_qil_assembly_build_id ON quality_inspection_lines (assembly_build_id)');
    console.log('idx_qil_assembly_build_id created');
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
