// Installation Planner > Work Phases (asked 2026-11-11): a project's timeline is split into the kinds of
// work done on it, day by day -- e.g. JO-1231-3-3 (room number signage), Nov 11 to 14: Assembling
// Nov 11-13, Installation Nov 12-14. Phases may overlap; each crew slot then says which phase it works.
//
//   installation_work_types       each category's kinds of work (Assembling, Installation, ...), with a
//                                 colour (the block's colour on the Day view / day report) and an order:
//                                 a phase may not START before an earlier-ordered phase on the project starts
//   installation_project_phases   the project's phases: a work type over [date_from, date_to], inside the
//                                 project's timeline, one of each work type per project
//   installation_crew_slots.phase_id   the phase the slot works; required once the project has phases,
//                                 and the slot's day must fall in it. Older slots keep NULL.
//
// Every existing category is given Assembling (1) and Installation (2) -- untick / delete them on
// Installation Categories where they do not apply.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-installation-work-phases.js
require('dotenv').config();
const pool = require('../db');

const DEFAULT_TYPES = [['Assembling', '#ffff00', 1], ['Installation', '#f4b183', 2]];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS installation_work_types (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     category_id BIGINT NOT NULL,
     name VARCHAR(100) NOT NULL,
     color VARCHAR(7) NOT NULL DEFAULT '#b4c7e7',
     sort_order INT NOT NULL DEFAULT 0,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY uq_installation_work_type (category_id, name),
     CONSTRAINT fk_installation_work_type_category FOREIGN KEY (category_id) REFERENCES installation_categories (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log('  installation_work_types ready');

  await pool.query(`CREATE TABLE IF NOT EXISTS installation_project_phases (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     project_id BIGINT NOT NULL,
     work_type_id BIGINT NOT NULL,
     date_from DATE NOT NULL,
     date_to DATE NOT NULL,
     note VARCHAR(500) NULL,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY uq_installation_project_phase (project_id, work_type_id),
     CONSTRAINT fk_installation_phase_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE,
     CONSTRAINT fk_installation_phase_work_type FOREIGN KEY (work_type_id) REFERENCES installation_work_types (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log('  installation_project_phases ready');

  const crewCols = (await pool.query('SHOW COLUMNS FROM installation_crew_slots'))[0].map((c) => c.Field);
  if (!crewCols.includes('phase_id')) {
    await pool.query(`ALTER TABLE installation_crew_slots
      ADD COLUMN phase_id BIGINT NULL AFTER project_id,
      ADD KEY idx_installation_crew_phase (phase_id),
      ADD CONSTRAINT fk_installation_crew_phase FOREIGN KEY (phase_id) REFERENCES installation_project_phases (id) ON DELETE SET NULL`);
    console.log('  installation_crew_slots: added phase_id');
  } else console.log('  installation_crew_slots already has phase_id');

  const [cats] = await pool.query('SELECT id, name FROM installation_categories');
  for (const c of cats) {
    const [[has]] = await pool.query('SELECT COUNT(*) AS n FROM installation_work_types WHERE category_id = ?', [c.id]);
    if (has.n) { console.log(`  ${c.name}: already has ${has.n} work type(s)`); continue; }
    await pool.query('INSERT INTO installation_work_types (category_id, name, color, sort_order) VALUES ?',
      [DEFAULT_TYPES.map(([name, color, order]) => [c.id, name, color, order])]);
    console.log(`  ${c.name}: given Assembling, Installation`);
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
