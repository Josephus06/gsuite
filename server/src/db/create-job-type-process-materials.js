// Which materials a process may draw on, per job type.
//
// The restriction genuinely belongs to the PAIR, not to either side alone: "Signage-Cutting
// Laser-6.0mm" run for SIGN-PLAQUE(SO) may only use the acrylics that plaque is made of,
// while the same process under a different job type draws on a different stock list. So the
// row hangs off job_type_processes.id -- that link row IS the (job type, process) pair --
// rather than off process_id or job_type_id.
//
// ON DELETE CASCADE: taking a process off a job type takes its material list with it.
// Keeping orphaned rows would silently restore the old list if the process were re-added.
//
// Note the two older tables this deliberately does NOT use: process_materials (keyed on
// process alone) and job_type_materials (keyed on job type alone). Both are empty and
// referenced by no code, and neither can express the pair.
const pool = require('../db');

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

(async () => {
  try {
    if (await tableExists('job_type_process_materials')) {
      console.log('job_type_process_materials exists');
    } else {
      await pool.query(`
        CREATE TABLE job_type_process_materials (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          job_type_process_id BIGINT NOT NULL,
          inventory_id BIGINT NOT NULL,
          is_default TINYINT(1) DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_jtpm (job_type_process_id, inventory_id),
          KEY idx_jtpm_inventory (inventory_id),
          CONSTRAINT fk_jtpm_link FOREIGN KEY (job_type_process_id)
            REFERENCES job_type_processes (id) ON DELETE CASCADE,
          CONSTRAINT fk_jtpm_inventory FOREIGN KEY (inventory_id)
            REFERENCES inventories (id)
        )
      `);
      console.log('Created job_type_process_materials');
    }
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
