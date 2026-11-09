// Production > Installation Planner (asked 2026-11-09): the PLANNER app's Project module and its
// planner dashboard calendar, brought into T1S for the installation crews.
//
// An installation project is one site job: a title, a timeline (date from / to), the installation Job
// Order it does (optional), a category, the team (planner = who created it, driver, installers,
// subcon suppliers, safety officer), the vehicles from Assets > Fleet, a permit, a BOM, a status and a
// progress %. The planner dashboard shows the counts and every project on a calendar across its dates.
//
//   installation_categories            the kinds of installation (Signage, Billboard, ...)
//   installation_checklist_items       each category's quality checklist
//   installation_projects              the projects
//   installation_project_installers    employees on the crew
//   installation_project_subcons       suppliers subcontracted
//   installation_project_vehicles      fleet vehicles (assets.id)
//   installation_project_files         the project picture, permit and BOM PDF (one of each)
//   installation_project_checks        checklist items ticked on THIS project -- in PLANNER the tick
//                                      sat on the category's item itself, so ticking it on one project
//                                      ticked it on every project of that category
//   installation_bom_items             the BOM lines: Not Ready / Ready / Done
//   installation_crew_slots            Crew & Vehicle Schedule: installer / subcon / driver / vehicle x day x time
//   installation_project_subcon_employees  subcons = employees with Position Code SUBCON
//   installation_reschedule_requests   calendar drags waiting on / decided by the SBU
//   installation_progress_updates      "+N%" updates with a note and a photo
//
//   pages /installation-planner     "Installation Planner"  View the dashboard + projects; Add; Edit;
//                                   Update (progress, checklist, BOM); Delete
//         /installation-categories  "Installation Categories" -- categories and their checklists
//   System Admins get every right on both. Grant the planners from Users & Permissions after.
//
// Idempotent. Droplet, office and SM replicate: run on ONE box (the droplet).
//   node src/db/add-installation-planner.js
require('dotenv').config();
const pool = require('../db');

const PAGES = [
  ['/installation-planner', 'Installation Planner'],
  ['/installation-categories', 'Installation Categories'],
];

const TABLES = [
  `CREATE TABLE IF NOT EXISTS installation_categories (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(150) NOT NULL,
     description TEXT NULL,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY uq_installation_categories_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_checklist_items (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     category_id BIGINT NOT NULL,
     item VARCHAR(255) NOT NULL,
     sort_order INT NOT NULL DEFAULT 0,
     is_required TINYINT(1) NOT NULL DEFAULT 0,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_installation_checklist_items (category_id, sort_order),
     CONSTRAINT fk_installation_checklist_category FOREIGN KEY (category_id) REFERENCES installation_categories (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_projects (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     project_no VARCHAR(20) NOT NULL,
     title VARCHAR(255) NOT NULL,
     description TEXT NULL,
     site_address VARCHAR(300) NULL,
     job_order_id BIGINT NULL,
     category_id BIGINT NULL,
     date_from DATE NULL,
     date_to DATE NULL,
     status ENUM('pending', 'ongoing', 'on-hold', 'done', 'cancelled') NOT NULL DEFAULT 'pending',
     progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
     needs_permit TINYINT(1) NOT NULL DEFAULT 0,
     needs_safety_officer TINYINT(1) NOT NULL DEFAULT 0,
     safety_officer_employee_id BIGINT NULL,
     driver_employee_id BIGINT NULL,
     planner_user_id BIGINT NULL,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY uq_installation_projects_no (project_no),
     KEY idx_installation_projects_dates (date_from, date_to),
     KEY idx_installation_projects_status (status),
     KEY idx_installation_projects_jo (job_order_id),
     CONSTRAINT fk_installation_project_category FOREIGN KEY (category_id) REFERENCES installation_categories (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_project_installers (
     project_id BIGINT NOT NULL,
     employee_id BIGINT NOT NULL,
     PRIMARY KEY (project_id, employee_id),
     CONSTRAINT fk_installation_installer_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_project_subcons (
     project_id BIGINT NOT NULL,
     supplier_id BIGINT NOT NULL,
     PRIMARY KEY (project_id, supplier_id),
     CONSTRAINT fk_installation_subcon_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_project_vehicles (
     project_id BIGINT NOT NULL,
     asset_id BIGINT NOT NULL,
     PRIMARY KEY (project_id, asset_id),
     CONSTRAINT fk_installation_vehicle_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_project_files (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     project_id BIGINT NOT NULL,
     kind ENUM('image', 'permit', 'bom') NOT NULL,
     file_name VARCHAR(255) NOT NULL,
     mime_type VARCHAR(100) NOT NULL,
     size_bytes INT NOT NULL,
     file_data LONGBLOB NOT NULL,
     uploaded_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY uq_installation_project_file (project_id, kind),
     CONSTRAINT fk_installation_file_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_project_checks (
     project_id BIGINT NOT NULL,
     checklist_item_id BIGINT NOT NULL,
     checked_by_user_id BIGINT NULL,
     checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (project_id, checklist_item_id),
     CONSTRAINT fk_installation_check_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE,
     CONSTRAINT fk_installation_check_item FOREIGN KEY (checklist_item_id) REFERENCES installation_checklist_items (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_bom_items (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     project_id BIGINT NOT NULL,
     section VARCHAR(120) NULL,
     item TEXT NOT NULL,
     qty VARCHAR(60) NULL,
     status ENUM('not_ready', 'ready', 'done') NOT NULL DEFAULT 'not_ready',
     done_at DATETIME NULL,
     updated_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_installation_bom_items (project_id, status),
     CONSTRAINT fk_installation_bom_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Installer Schedule (asked 2026-11-09): which installer works on the project on which day, from
  // what time to what time. One installer may be on two projects the same day (JO-123 8:00-11:30,
  // JO-321 1:00-4:30) but never on two at once -- the route refuses an overlapping slot.
  `CREATE TABLE IF NOT EXISTS installation_crew_slots (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     project_id BIGINT NOT NULL,
     employee_id BIGINT NOT NULL,
     work_date DATE NOT NULL,
     start_time TIME NOT NULL,
     end_time TIME NOT NULL,
     note VARCHAR(500) NULL,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_installation_crew_employee_day (employee_id, work_date),
     KEY idx_installation_crew_project (project_id, work_date),
     CONSTRAINT fk_installation_crew_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Reschedule requests (asked 2026-11-09): the planner drags a project's bar on the calendar to new
  // dates, gives a reason (Lookups > Reasons, type Reschedule) and forwards it to the SBU; the project's
  // dates change only when the SBU approves. The reason's name is copied so a later rename of the
  // lookup does not reword a decided request.
  `CREATE TABLE IF NOT EXISTS installation_reschedule_requests (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     project_id BIGINT NOT NULL,
     old_date_from DATE NULL,
     old_date_to DATE NULL,
     new_date_from DATE NOT NULL,
     new_date_to DATE NOT NULL,
     reason_id BIGINT NULL,
     reason_name VARCHAR(150) NOT NULL,
     remarks VARCHAR(1000) NULL,
     status ENUM('for_approval', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'for_approval',
     requested_by_user_id BIGINT NULL,
     requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     decided_by_user_id BIGINT NULL,
     decided_at DATETIME NULL,
     decision_note VARCHAR(1000) NULL,
     KEY idx_installation_reschedule_project (project_id, status),
     KEY idx_installation_reschedule_status (status),
     CONSTRAINT fk_installation_reschedule_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Subcons as employees (asked 2026-11-09): the project's subcontractors are employees whose Position
  // Code is SUBCON, booked by time like installers. installation_project_subcons (suppliers) is kept for
  // the projects that already named supplier subcons; nothing new is written there.
  `CREATE TABLE IF NOT EXISTS installation_project_subcon_employees (
     project_id BIGINT NOT NULL,
     employee_id BIGINT NOT NULL,
     PRIMARY KEY (project_id, employee_id),
     CONSTRAINT fk_installation_subcon_emp_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS installation_progress_updates (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     project_id BIGINT NOT NULL,
     percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
     note TEXT NULL,
     photo_name VARCHAR(255) NULL,
     photo_mime VARCHAR(100) NULL,
     photo_data LONGBLOB NULL,
     created_by_user_id BIGINT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_installation_progress_updates (project_id, created_at),
     CONSTRAINT fk_installation_update_project FOREIGN KEY (project_id) REFERENCES installation_projects (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  for (const ddl of TABLES) {
    await pool.query(ddl);
    console.log(`  ${/EXISTS (\w+)/.exec(ddl)[1]} ready`);
  }

  // The schedule takes four kinds of slot (asked 2026-11-09): installer, subcon and driver (an employee)
  // and vehicle (an Assets > Fleet asset). `role` says which; a vehicle slot has asset_id instead of
  // employee_id. Existing slots are installers -- the column's default.
  const crewCols = (await pool.query('SHOW COLUMNS FROM installation_crew_slots'))[0].map((c) => c.Field);
  if (!crewCols.includes('role')) {
    await pool.query(`ALTER TABLE installation_crew_slots
      ADD COLUMN role ENUM('installer', 'subcon', 'driver', 'vehicle') NOT NULL DEFAULT 'installer' AFTER project_id,
      ADD COLUMN asset_id BIGINT NULL AFTER employee_id,
      MODIFY employee_id BIGINT NULL,
      ADD KEY idx_installation_crew_asset_day (asset_id, work_date)`);
    console.log('  installation_crew_slots: added role and asset_id (vehicles)');
  } else console.log('  installation_crew_slots already has role / asset_id');

  // Lookups > Reasons gets a 'Reschedule' type for the reasons a project is moved. Appended to the end of
  // the ENUM, so existing rows keep their values.
  const [[rt]] = await pool.query("SHOW COLUMNS FROM reasons LIKE 'reason_type'");
  if (rt && !/'Reschedule'/.test(rt.Type)) {
    const values = rt.Type.replace(/^enum\(|\)$/g, '');
    await pool.query(`ALTER TABLE reasons MODIFY reason_type ENUM(${values}, 'Reschedule') NOT NULL`);
    console.log("  reasons.reason_type: added 'Reschedule'");
  } else if (rt) console.log("  reasons.reason_type already has 'Reschedule'");

  const [permCols] = await pool.query('SHOW COLUMNS FROM user_page_permissions');
  const flags = permCols.map((c) => c.Field).filter((f) => /^can_/.test(f));
  const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  for (const [route, name] of PAGES) {
    const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    let pageId = existing?.id;
    if (!pageId) {
      const [r] = await pool.query('INSERT INTO pages (route, name, is_active) VALUES (?, ?, TRUE)', [route, name]);
      pageId = r.insertId;
      console.log(`  registered ${route} (id ${pageId})`);
    } else console.log(`  page ${route} already registered (id ${pageId})`);
    for (const a of admins) {
      const [[p]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [a.id, pageId]);
      if (p) await pool.query(`UPDATE user_page_permissions SET ${flags.map((f) => `${f} = TRUE`).join(', ')} WHERE id = ?`, [p.id]);
      else await pool.query(`INSERT INTO user_page_permissions (user_id, page_id, ${flags.join(', ')}) VALUES (?, ?, ${flags.map(() => 'TRUE').join(', ')})`, [a.id, pageId]);
    }
    console.log(`  ${name}: ${admins.length} System Admin(s) given every right`);
  }
  console.log('  Planners / installers: grant "Installation Planner" (and "Installation Categories") in User Permissions.');
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
