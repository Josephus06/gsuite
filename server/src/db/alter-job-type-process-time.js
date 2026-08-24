// Per-job-type time study on a process link.
//
// `processes.minutes_per_unit` is the process's own study -- how long "CNC - Cutting Digital
// Plotter - Roll to Roll" takes per unit in general. But the same process costs a different
// amount of time depending on the job it is run for: on the real system's Job Type screen the
// same process shows 1.63 minutes under one job and 0.12 under another. That number belongs to
// the (job type, process) pair, not to the process, so it is stored on the link row.
//
// NULL means "inherit" rather than "zero": a link nobody has timed yet should fall back to the
// process's own study, and a job type that genuinely takes no time must be able to say 0
// without that being indistinguishable from never having been set.
const pool = require('../db');

async function colExists(table, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return rows.length > 0;
}

(async () => {
  try {
    if (await colExists('job_type_processes', 'minutes_per_unit')) {
      console.log('job_type_processes.minutes_per_unit exists');
    } else {
      await pool.query('ALTER TABLE job_type_processes ADD COLUMN minutes_per_unit DECIMAL(10,4) NULL');
      console.log('Added job_type_processes.minutes_per_unit');
    }
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
