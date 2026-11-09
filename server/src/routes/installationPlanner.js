const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin, userCan } = require('../middleware/auth');
const { sbuCanApproveDepartment } = require('../lib/sbuGroups');
const { insertFor } = require('../lib/approvalNotifications');
const { shrinkFile } = require('../lib/shrinkFile');
const { todayPh, loadVehicles } = require('../lib/fleet');

// Production > Installation Planner (2026-11-09). The PLANNER app's Project module and planner
// dashboard calendar, in T1S; the tables and the reasons are in db/add-installation-planner.js.
//
//   /installation-planner      projects, their team / vehicles / files / checklist / BOM / progress,
//                              the dashboard counts and the calendar
//     can_view    the dashboard, the calendar, the projects
//     can_add     new project               can_edit    change one, its files
//     can_update  progress, checklist ticks, BOM lines and their status
//     can_delete  delete a project or a BOM line
//   /installation-categories   the categories and their quality checklists
//
// As in PLANNER: the planner is whoever created the project; a progress update ADDS its % to the
// project's (capped at 100), 100% marks it Done and the first update moves Pending to Ongoing; a
// project is Due when its end date is today or past and it is not Done or Cancelled.
const router = express.Router();
const ROUTE = '/installation-planner';
const CAT_ROUTE = '/installation-categories';

const STATUSES = ['pending', 'ongoing', 'on-hold', 'done', 'cancelled'];
const BOM_STATUSES = ['not_ready', 'ready', 'done'];
const FILE_KINDS = {
  image: { label: 'Project picture', test: (m) => /^image\//.test(m), error: 'The project picture must be an image.' },
  permit: { label: 'Permit', test: (m) => /^(image\/|application\/pdf)/.test(m), error: 'The permit must be a PDF or an image.' },
  bom: { label: 'BOM', test: (m) => m === 'application/pdf', error: 'The BOM must be a PDF.' },
};
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const idOrNull = (v) => (Number(v) > 0 ? Number(v) : null);
const ids = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => n > 0))];
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const errorOut = (res, status, error) => res.status(status).json({ error });

// Installers are the employees whose Position Code is INSTALLER (asked 2026-11-09). Someone already on
// a project stays allowed there, so editing an older project never drops or blocks its crew.
const IS_INSTALLER = "UPPER(TRIM(COALESCE(e.position_code, ''))) = 'INSTALLER'";
async function notInstallers(conn, employeeIds, projectId) {
  if (!employeeIds.length) return [];
  const [rows] = await conn.query(
    `SELECT e.id, e.first_name, e.last_name FROM employees e
      WHERE e.id IN (?) AND NOT (${IS_INSTALLER})
        AND e.id NOT IN (SELECT employee_id FROM installation_project_installers WHERE project_id = ?)`,
    [employeeIds, projectId || 0]);
  return rows;
}
// Drivers likewise: Position Code DRIVER. The project's current driver stays allowed on an edit.
const IS_DRIVER = "UPPER(TRIM(COALESCE(e.position_code, ''))) = 'DRIVER'";
async function driverProblem(conn, driverId, projectId) {
  if (!driverId) return null;
  const [[e]] = await conn.query(
    `SELECT e.first_name, e.last_name, (${IS_DRIVER}) AS ok,
            EXISTS(SELECT 1 FROM installation_projects p WHERE p.id = ? AND p.driver_employee_id = e.id) AS kept
       FROM employees e WHERE e.id = ?`, [projectId || 0, driverId]);
  if (!e) return 'That driver was not found.';
  return Number(e.ok) || Number(e.kept) ? null
    : `${e.first_name} ${e.last_name} is not a driver -- set their Position Code to DRIVER on the employee record first.`;
}
const notInstallerError = (rows) => `${rows.map((e) => `${e.first_name} ${e.last_name}`).join(', ')} `
  + `${rows.length > 1 ? 'are' : 'is'} not an installer -- set their Position Code to INSTALLER on the employee record first.`;

// Subcons (asked 2026-11-09): employees whose Position Code is SUBCON, booked by time like installers.
// As with installers, someone already a subcon on the project stays allowed there.
const IS_SUBCON = "UPPER(TRIM(COALESCE(e.position_code, ''))) = 'SUBCON'";
async function notSubcons(conn, employeeIds, projectId) {
  if (!employeeIds.length) return [];
  const [rows] = await conn.query(
    `SELECT e.id, e.first_name, e.last_name FROM employees e
      WHERE e.id IN (?) AND NOT (${IS_SUBCON})
        AND e.id NOT IN (SELECT employee_id FROM installation_project_subcon_employees WHERE project_id = ?)`,
    [employeeIds, projectId || 0]);
  return rows;
}
const notSubconError = (rows) => `${rows.map((e) => `${e.first_name} ${e.last_name}`).join(', ')} `
  + `${rows.length > 1 ? 'are' : 'is'} not a subcon -- set their Position Code to SUBCON on the employee record first.`;

// The vehicles are Assets > Fleet's own list (lib/fleet.js loadVehicles -- what that page shows under
// "All vehicles"), named as it names them: make and model (else the asset's brand / model), plate.
async function fleetVehicles(assetId = null) {
  const rows = await loadVehicles(pool, assetId).catch(() => []);
  return rows.map((v) => ({
    id: Number(v.asset_id), plate_no: v.plate_no || null,
    make: v.make || v.brand || null, model: v.model || v.asset_model || null,
    asset_name: v.asset_name || null, reference_no: v.reference_no || null,
  }));
}
async function isFleetVehicle(conn, assetId) {
  return (await fleetVehicles(Number(assetId))).length > 0;
}
const vehicleName = (r) => {
  const name = [r.make, r.model].filter(Boolean).join(' ') || r.asset_name || r.reference_no || `Asset #${r.asset_id}`;
  return r.plate_no ? `${name} (${r.plate_no})` : name;
};

// A JO is installation work when its Job Type is one or any of its processes is one -- the same test
// as Sales > Installation Orders per Month (routes/installationOrdersReport.js).
const INSTAL_JO = `(jt.display_name LIKE '%INSTAL%' OR EXISTS (
    SELECT 1 FROM job_order_processes jop JOIN processes p ON p.id = jop.process_id
     WHERE jop.job_order_id = jo.id AND p.process_name LIKE '%INSTAL%'))`;

// The calendar's search box (asked 2026-11-09): a project (alias p, its JO as jo) matches on its JO #,
// its customer's name (through the JO's SO or NSSO), its project # or its title. Subqueries rather than
// joins, so it drops into any query that already has p and jo.
const PROJECT_SEARCH = `(jo.job_order_no LIKE ? OR p.project_no LIKE ? OR p.title LIKE ?
  OR EXISTS (SELECT 1 FROM sales_orders so2 JOIN customers c2 ON c2.id = so2.customer_id WHERE so2.id = jo.sales_order_id AND c2.name LIKE ?)
  OR EXISTS (SELECT 1 FROM non_standard_sales_orders ns2 JOIN customers c3 ON c3.id = ns2.customer_id WHERE ns2.id = jo.nsso_id AND c3.name LIKE ?))`;
const PROJECT_SEARCH_ARGS = 5;

// A data: URL or bare base64 from the browser's FileReader -> a Buffer.
function decodeUpload(body) {
  const { file_name: fileName, data, mime_type: mimeType } = body || {};
  if (!fileName || !data) return { error: 'file_name and data are required' };
  const buf = Buffer.from(String(data).includes(',') ? String(data).split(',').pop() : String(data), 'base64');
  if (!buf.length) return { error: 'The uploaded file is empty' };
  if (buf.length > MAX_FILE_BYTES) return { error: 'Files must be 10MB or smaller', status: 413 };
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(mimeType || '')) ? String(mimeType).slice(0, 100) : 'application/octet-stream';
  return { buf, fileName: String(fileName).slice(0, 255), mime };
}

async function shrunk(upload) {
  const small = await shrinkFile(upload.buf, upload.fileName);
  return small ? { buf: small.buf, fileName: small.fileName.slice(0, 255), mime: small.mime } : upload;
}

function sendBlob(res, { name, mime, data }) {
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  const inline = /^(application\/pdf|image\/)/.test(mime || '');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(name || 'file').replace(/"/g, '')}"`);
  res.send(data);
}

// IP-2026-0001, numbered per year.
async function nextProjectNo(conn) {
  const prefix = `IP-${todayPh().slice(0, 4)}-`;
  const [[row]] = await conn.query(
    'SELECT MAX(CAST(SUBSTRING(project_no, ?) AS UNSIGNED)) AS n FROM installation_projects WHERE project_no LIKE ?',
    [prefix.length + 1, `${prefix}%`]);
  return `${prefix}${String((Number(row.n) || 0) + 1).padStart(4, '0')}`;
}

async function rightsOf(userId) {
  const admin = await isSystemAdmin(userId);
  const out = { admin };
  for (const a of ['can_add', 'can_edit', 'can_update', 'can_delete']) out[a] = admin || await userCan(userId, ROUTE, a);
  out.can_manage_categories = admin || await userCan(userId, CAT_ROUTE, 'can_view');
  return out;
}

const PROJECT_SELECT = `
  SELECT p.*, c.name AS category_name, jo.job_order_no, jo.description AS job_order_description,
         COALESCE(cs.name, cn.name) AS customer_name,
         u.display_name AS planner_name,
         CONCAT_WS(' ', d.first_name, d.last_name) AS driver_name,
         CONCAT_WS(' ', so.first_name, so.last_name) AS safety_officer_name,
         (SELECT COUNT(*) FROM installation_project_files f WHERE f.project_id = p.id AND f.kind = 'image') AS has_image
    FROM installation_projects p
    LEFT JOIN installation_categories c ON c.id = p.category_id
    LEFT JOIN job_orders jo ON jo.id = p.job_order_id
    LEFT JOIN sales_orders s ON s.id = jo.sales_order_id
    LEFT JOIN customers cs ON cs.id = s.customer_id
    LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
    LEFT JOIN customers cn ON cn.id = ns.customer_id
    LEFT JOIN users u ON u.id = p.planner_user_id
    LEFT JOIN employees d ON d.id = p.driver_employee_id
    LEFT JOIN employees so ON so.id = p.safety_officer_employee_id`;

async function projectOr404(req, res) {
  const [[p]] = await pool.query('SELECT * FROM installation_projects WHERE id = ?', [req.params.id]);
  if (!p) errorOut(res, 404, 'Project not found');
  return p || null;
}

// ---------------------------------------------------------------- lookups

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [categories] = await pool.query('SELECT id, name, is_active FROM installation_categories ORDER BY name');
    const [employees] = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.employee_code, e.position_title, dp.name AS department_name,
              (${IS_INSTALLER}) AS is_installer, (${IS_DRIVER}) AS is_driver, (${IS_SUBCON}) AS is_subcon
         FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id
        WHERE e.is_active = 1 ORDER BY e.first_name, e.last_name`);
    for (const e of employees) { e.is_installer = !!Number(e.is_installer); e.is_driver = !!Number(e.is_driver); e.is_subcon = !!Number(e.is_subcon); }
    const [suppliers] = await pool.query('SELECT id, supplier_code, name FROM suppliers ORDER BY name').catch(() => [[]]);
    // Assets > Fleet's vehicles: assets with vehicle details or a vehicle class / item.
    // Assets > Fleet (Vehicles), exactly: the same list as that page's "All vehicles" (lib/fleet.js).
    const vehicles = await fleetVehicles();
    res.json({ categories, employees, suppliers, vehicles, statuses: STATUSES, rights: await rightsOf(req.user.id), today: todayPh() });
  } catch (err) { next(err); }
});

// The installation Job Orders to pick from (newest first), each with the project already doing it.
router.get('/job-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [INSTAL_JO, "COALESCE(jo.status, '') <> 'cancelled'"];
    const params = [];
    if (req.query.search) {
      where.push('(jo.job_order_no LIKE ? OR jo.description LIKE ? OR cs.name LIKE ? OR cn.name LIKE ? OR s.sales_order_no LIKE ? OR ns.nsso_no LIKE ?)');
      params.push(...Array(6).fill(`%${req.query.search}%`));
    }
    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.delivery_date, jo.status, jt.display_name AS job_type,
              COALESCE(s.sales_order_no, ns.nsso_no) AS order_no, COALESCE(cs.name, cn.name) AS customer_name,
              jl.location_name AS location,
              (SELECT GROUP_CONCAT(ip.project_no SEPARATOR ', ') FROM installation_projects ip WHERE ip.job_order_id = jo.id) AS project_nos
         FROM job_orders jo
         LEFT JOIN job_types jt ON jt.id = jo.job_type_id
         LEFT JOIN sales_orders s ON s.id = jo.sales_order_id
         LEFT JOIN customers cs ON cs.id = s.customer_id
         LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
         LEFT JOIN customers cn ON cn.id = ns.customer_id
         LEFT JOIN locations jl ON jl.id = jo.job_location_id
        WHERE ${where.join(' AND ')}
        ORDER BY jo.id DESC LIMIT 200`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- dashboard + calendar

router.get('/dashboard', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const today = todayPh();
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(status = 'ongoing') AS ongoing, SUM(status = 'pending') AS pending,
              SUM(status = 'on-hold') AS on_hold, SUM(status = 'done') AS done,
              SUM(status NOT IN ('done', 'cancelled') AND date_to IS NOT NULL AND date_to <= ?) AS due
         FROM installation_projects`, [today]);
    const out = {};
    for (const k of ['total', 'ongoing', 'pending', 'on_hold', 'done', 'due']) out[k] = Number(c[k]) || 0;
    res.json(out);
  } catch (err) { next(err); }
});

// Every project whose dates touch [from, to]; one without an end date sits on its start date.
router.get('/events', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) return errorOut(res, 400, 'from and to (YYYY-MM-DD) are required');
    const where = [`((p.date_from IS NOT NULL AND p.date_from <= ? AND COALESCE(p.date_to, p.date_from) >= ?)
                    OR (rr.id IS NOT NULL AND rr.new_date_from <= ? AND rr.new_date_to >= ?))`];
    const params = [to, from, to, from];
    if (STATUSES.includes(req.query.status)) { where.push('p.status = ?'); params.push(req.query.status); }
    // One person's projects -- an installer or subcon on it, its driver, or booked on its schedule --
    // or one vehicle's: on the project, or booked on its schedule.
    if (idOrNull(req.query.employee_id)) {
      const eid = Number(req.query.employee_id);
      where.push(`(p.driver_employee_id = ?
                   OR EXISTS (SELECT 1 FROM installation_project_installers i WHERE i.project_id = p.id AND i.employee_id = ?)
                   OR EXISTS (SELECT 1 FROM installation_project_subcon_employees se WHERE se.project_id = p.id AND se.employee_id = ?)
                   OR EXISTS (SELECT 1 FROM installation_crew_slots s WHERE s.project_id = p.id AND s.employee_id = ?))`);
      params.push(eid, eid, eid, eid);
    }
    if (idOrNull(req.query.asset_id)) {
      const aid = Number(req.query.asset_id);
      where.push(`(EXISTS (SELECT 1 FROM installation_project_vehicles pv WHERE pv.project_id = p.id AND pv.asset_id = ?)
                   OR EXISTS (SELECT 1 FROM installation_crew_slots s WHERE s.project_id = p.id AND s.asset_id = ?))`);
      params.push(aid, aid);
    }
    if (String(req.query.search || '').trim()) {
      where.push(PROJECT_SEARCH);
      params.push(...Array(PROJECT_SEARCH_ARGS).fill(`%${String(req.query.search).trim()}%`));
    }
    const [rows] = await pool.query(
      `SELECT p.id, p.project_no, p.title, p.status, p.progress, p.date_from, COALESCE(p.date_to, p.date_from) AS date_to,
              c.name AS category_name, jo.job_order_no,
              rr.id AS pending_id, rr.new_date_from AS pending_from, rr.new_date_to AS pending_to, rr.reason_name AS pending_reason
         FROM installation_projects p
         LEFT JOIN installation_categories c ON c.id = p.category_id
         LEFT JOIN job_orders jo ON jo.id = p.job_order_id
         LEFT JOIN installation_reschedule_requests rr ON rr.project_id = p.id AND rr.status = 'for_approval'
        WHERE ${where.join(' AND ')}
        ORDER BY p.date_from, p.id`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- projects

router.get('/projects', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (STATUSES.includes(req.query.status)) { where.push('p.status = ?'); params.push(req.query.status); }
    if (req.query.due === '1') { where.push("p.status NOT IN ('done', 'cancelled') AND p.date_to IS NOT NULL AND p.date_to <= ?"); params.push(todayPh()); }
    if (req.query.search) {
      where.push('(p.project_no LIKE ? OR p.title LIKE ? OR p.description LIKE ? OR jo.job_order_no LIKE ? OR cs.name LIKE ? OR cn.name LIKE ?)');
      params.push(...Array(6).fill(`%${req.query.search}%`));
    }
    const [rows] = await pool.query(
      `${PROJECT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT 1000`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/projects/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[p]] = await pool.query(`${PROJECT_SELECT} WHERE p.id = ?`, [req.params.id]);
    if (!p) return errorOut(res, 404, 'Project not found');
    const id = p.id;
    const [[installers], [subconSuppliers], [vehicles], [files], [checklist], [bom], [updates], [crew], [reschedules], [subcons]] = await Promise.all([
      pool.query(
        `SELECT e.id, e.first_name, e.last_name FROM installation_project_installers x JOIN employees e ON e.id = x.employee_id
          WHERE x.project_id = ? ORDER BY e.first_name, e.last_name`, [id]),
      pool.query(
        `SELECT s.id, s.name FROM installation_project_subcons x JOIN suppliers s ON s.id = x.supplier_id
          WHERE x.project_id = ? ORDER BY s.name`, [id]).catch(() => [[]]),
      pool.query(
        `SELECT a.id, v.plate_no, COALESCE(v.make, a.brand) AS make, COALESCE(v.model, a.model) AS model, ai.display_name AS asset_name, a.reference_no
           FROM installation_project_vehicles x JOIN assets a ON a.id = x.asset_id
           LEFT JOIN vehicle_details v ON v.asset_id = a.id LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
          WHERE x.project_id = ?`, [id]).catch(() => [[]]),
      pool.query('SELECT kind, file_name, mime_type, size_bytes, created_at FROM installation_project_files WHERE project_id = ?', [id]),
      pool.query(
        `SELECT i.id, i.item, i.sort_order, i.is_required, k.checked_at, u.display_name AS checked_by_name
           FROM installation_checklist_items i
           LEFT JOIN installation_project_checks k ON k.checklist_item_id = i.id AND k.project_id = ?
           LEFT JOIN users u ON u.id = k.checked_by_user_id
          WHERE i.category_id = ? AND (i.is_active = 1 OR k.checked_at IS NOT NULL)
          ORDER BY i.sort_order, i.id`, [id, p.category_id || 0]),
      pool.query(
        `SELECT b.*, u.display_name AS updated_by_name FROM installation_bom_items b
           LEFT JOIN users u ON u.id = b.updated_by_user_id WHERE b.project_id = ? ORDER BY b.id`, [id]),
      pool.query(
        `SELECT g.id, g.percent, g.note, g.created_at, g.photo_name IS NOT NULL AS has_photo, u.display_name AS created_by_name
           FROM installation_progress_updates g LEFT JOIN users u ON u.id = g.created_by_user_id
          WHERE g.project_id = ? ORDER BY g.created_at DESC, g.id DESC`, [id]),
      pool.query(`${CREW_SELECT} WHERE s.project_id = ? ORDER BY s.work_date, s.start_time, e.first_name`, [id]),
      pool.query(`${RESCHEDULE_SELECT} WHERE r.project_id = ? ORDER BY r.requested_at DESC, r.id DESC`, [id]),
      pool.query(
        `SELECT e.id, e.first_name, e.last_name FROM installation_project_subcon_employees x JOIN employees e ON e.id = x.employee_id
          WHERE x.project_id = ? ORDER BY e.first_name, e.last_name`, [id]),
    ]);
    res.json({
      ...p, installers, subcons, subcon_suppliers: subconSuppliers, vehicles, checklist, bom_items: bom, updates, crew_slots: crew,
      reschedules: await withActions(reschedules, req.user.id),
      files: Object.fromEntries(files.map((f) => [f.kind, f])),
      rights: await rightsOf(req.user.id),
    });
  } catch (err) { next(err); }
});

function readProject(body) {
  const title = trunc(body.title, 255);
  if (!title) return { error: 'Enter the project title.' };
  if (!idOrNull(body.category_id)) return { error: 'Choose the project category.' };
  const dateFrom = body.date_from || null;
  const dateTo = body.date_to || null;
  if (dateFrom && !isDate(dateFrom)) return { error: 'Timeline From is not a date.' };
  if (dateTo && !isDate(dateTo)) return { error: 'Timeline To is not a date.' };
  if (dateFrom && dateTo && dateTo < dateFrom) return { error: 'Timeline To must be on or after Timeline From.' };
  if (dateTo && !dateFrom) return { error: 'Enter Timeline From as well.' };
  const status = STATUSES.includes(body.status) ? body.status : 'pending';
  const progress = body.progress === '' || body.progress == null ? 0 : Number(body.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) return { error: 'Progress must be a whole number from 0 to 100.' };
  const needsSafety = bool(body.needs_safety_officer);
  if (needsSafety && !idOrNull(body.safety_officer_employee_id)) return { error: 'Choose the safety officer, or untick Assign Safety Officer.' };
  return {
    values: {
      title,
      description: trunc(body.description, 5000),
      site_address: trunc(body.site_address, 300),
      job_order_id: idOrNull(body.job_order_id),
      category_id: Number(body.category_id),
      date_from: dateFrom,
      date_to: dateTo,
      status,
      progress,
      needs_permit: bool(body.needs_permit) ? 1 : 0,
      needs_safety_officer: needsSafety ? 1 : 0,
      safety_officer_employee_id: needsSafety ? Number(body.safety_officer_employee_id) : null,
      driver_employee_id: idOrNull(body.driver_employee_id),
    },
    installers: ids(body.installers),
    subcons: ids(body.subcons),
    vehicles: ids(body.vehicles),
  };
}

async function syncTeam(conn, projectId, r) {
  const sets = [
    ['installation_project_installers', 'employee_id', r.installers],
    ['installation_project_subcon_employees', 'employee_id', r.subcons],
    ['installation_project_vehicles', 'asset_id', r.vehicles],
  ];
  for (const [table, col, list] of sets) {
    await conn.query(`DELETE FROM ${table} WHERE project_id = ?`, [projectId]);
    if (list.length) await conn.query(`INSERT INTO ${table} (project_id, ${col}) VALUES ?`, [list.map((v) => [projectId, v])]);
  }
}

router.post('/projects', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const r = readProject(req.body || {});
  if (r.error) return errorOut(res, 400, r.error);
  const conn = await pool.getConnection();
  try {
    const bad = await notInstallers(conn, r.installers, null);
    if (bad.length) return errorOut(res, 400, notInstallerError(bad));
    const badSub = await notSubcons(conn, r.subcons, null);
    if (badSub.length) return errorOut(res, 400, notSubconError(badSub));
    const noDriver = await driverProblem(conn, r.values.driver_employee_id, null);
    if (noDriver) return errorOut(res, 400, noDriver);
    await conn.beginTransaction();
    let id;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const [ins] = await conn.query('INSERT INTO installation_projects SET ?', [{
          ...r.values, project_no: await nextProjectNo(conn), planner_user_id: req.user.id, created_by_user_id: req.user.id,
        }]);
        id = ins.insertId;
        break;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY' || attempt >= 3) throw e; // two saved at once: take the next number
      }
    }
    await syncTeam(conn, id, r);
    await conn.commit();
    res.status(201).json({ id });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/projects/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const r = readProject(req.body || {});
  if (r.error) return errorOut(res, 400, r.error);
  const conn = await pool.getConnection();
  try {
    const [[p]] = await conn.query('SELECT id FROM installation_projects WHERE id = ?', [req.params.id]);
    if (!p) return errorOut(res, 404, 'Project not found');
    const bad = await notInstallers(conn, r.installers, p.id);
    if (bad.length) return errorOut(res, 400, notInstallerError(bad));
    const badSub = await notSubcons(conn, r.subcons, p.id);
    if (badSub.length) return errorOut(res, 400, notSubconError(badSub));
    const noDriver = await driverProblem(conn, r.values.driver_employee_id, p.id);
    if (noDriver) return errorOut(res, 400, noDriver);
    // An installer, subcon or vehicle still on the schedule stays on the project until its slots go.
    const keep = { installer: r.installers, subcon: r.subcons, vehicle: r.vehicles };
    const stillBooked = [];
    for (const [role, list] of Object.entries(keep)) {
      const col = role === 'vehicle' ? 'asset_id' : 'employee_id';
      const [rows] = await conn.query(
        `${CREW_SELECT} WHERE s.project_id = ? AND s.role = ? ${list.length ? `AND s.${col} NOT IN (?)` : ''}`,
        list.length ? [p.id, role, list] : [p.id, role]);
      const counts = new Map();
      for (const x of rows) {
        const name = role === 'vehicle' ? vehicleName(x) : `${x.first_name} ${x.last_name}`;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      for (const [name, n] of counts) stillBooked.push(`${name} (${n} ${role} slot${n > 1 ? 's' : ''})`);
    }
    if (stillBooked.length) {
      return errorOut(res, 409, `${stillBooked.join(', ')} still on the Crew & Vehicle Schedule -- remove those slots on the project page first, or keep them on the project.`);
    }
    await conn.beginTransaction();
    await conn.query('UPDATE installation_projects SET ? WHERE id = ?', [r.values, p.id]);
    await syncTeam(conn, p.id, r);
    await conn.commit();
    res.json({ id: p.id });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.delete('/projects/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const p = await projectOr404(req, res);
    if (!p) return;
    await pool.query('DELETE FROM installation_projects WHERE id = ?', [p.id]); // everything under it cascades
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- files: picture, permit, BOM PDF

router.get('/projects/:id/files/:kind', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[f]] = await pool.query(
      'SELECT file_name, mime_type, file_data FROM installation_project_files WHERE project_id = ? AND kind = ?',
      [req.params.id, req.params.kind]);
    if (!f) return errorOut(res, 404, 'No such file on this project');
    sendBlob(res, { name: f.file_name, mime: f.mime_type, data: f.file_data });
  } catch (err) { next(err); }
});

// Adding a project uploads its files right after it is saved, so can_add may attach as well as can_edit.
async function mayAttach(userId) {
  return (await userCan(userId, ROUTE, 'can_edit')) || userCan(userId, ROUTE, 'can_add');
}

router.post('/projects/:id/files/:kind', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const kind = FILE_KINDS[req.params.kind];
    if (!kind) return errorOut(res, 400, 'Unknown file kind');
    if (!(await mayAttach(req.user.id))) return errorOut(res, 403, 'You do not have permission to perform this action');
    const p = await projectOr404(req, res);
    if (!p) return;
    let up = decodeUpload(req.body);
    if (up.error) return errorOut(res, up.status || 400, up.error);
    if (!kind.test(up.mime)) return errorOut(res, 400, kind.error);
    if (req.params.kind !== 'bom') up = await shrunk(up);
    await pool.query(
      `INSERT INTO installation_project_files (project_id, kind, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE file_name = VALUES(file_name), mime_type = VALUES(mime_type), size_bytes = VALUES(size_bytes),
                               file_data = VALUES(file_data), uploaded_by_user_id = VALUES(uploaded_by_user_id), created_at = NOW()`,
      [p.id, req.params.kind, up.fileName, up.mime, up.buf.length, up.buf, req.user.id]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/projects/:id/files/:kind', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM installation_project_files WHERE project_id = ? AND kind = ?', [req.params.id, req.params.kind]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- quality checklist

router.post('/projects/:id/checks/:itemId', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  try {
    const p = await projectOr404(req, res);
    if (!p) return;
    const [[item]] = await pool.query('SELECT id FROM installation_checklist_items WHERE id = ? AND category_id = ?', [req.params.itemId, p.category_id || 0]);
    if (!item) return errorOut(res, 404, "That item is not on this project's checklist");
    await pool.query(
      'INSERT IGNORE INTO installation_project_checks (project_id, checklist_item_id, checked_by_user_id) VALUES (?, ?, ?)',
      [p.id, item.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/projects/:id/checks/:itemId', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM installation_project_checks WHERE project_id = ? AND checklist_item_id = ?', [req.params.id, req.params.itemId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- BOM

// PLANNER's cutting-list parser (ProjectBomItemController::parseBomPdfIntoItems), run over the text of
// the BOM -- copied from the PDF and pasted in. A line with a quantity (12pcs, 3.5 sqft, 15m) is an item;
// a section word without one starts a section; a line without a quantity is held as the name of the
// item whose quantity comes on the next line.
const QTY = /\b\d+(?:\.\d+)?\s*(sqft|sq ft|pcs|pc|m)\b/i;
const SECTION_WORDS = ['CUTTING LIST', 'SCREWS', 'WIRINGS', 'LIGHTINGS', 'ELECTRICAL ASSEMBLY', 'POWER SUPPLY'];
const NOISY = new Set(['FRONT COVER', 'BACK COVER', 'GFX MATERIALS SUBCONTRACTOR', 'CUTTING CUTTING']);

function parseBomText(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  let section = 'CUTTING LIST';
  let pending = null;
  const push = (item, qty) => out.push({ section, item: item.slice(0, 2000), qty: qty ? qty.slice(0, 60) : null });
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.includes('PROJECT NAME') || upper.includes('ORDER NO') || upper.includes('PREPARED BY')
      || (upper.includes('PARTS') && upper.includes('MATERIALS'))
      || ['OWNER :', 'LOCATION :', 'J.O NO :'].includes(upper) || upper.startsWith('SALES :')) continue;
    const m = QTY.exec(line);
    const qty = m ? m[0].trim() : null;
    const sectionHit = SECTION_WORDS.find((w) => upper.includes(w));
    if (sectionHit && !qty) { section = sectionHit; pending = null; continue; }
    const startsWith = SECTION_WORDS.find((w) => upper.startsWith(`${w} `));
    if (startsWith && qty) {
      section = startsWith;
      if (pending) { push(pending, qty); pending = null; continue; }
      const clean = line.slice(startsWith.length).replace(QTY, '').trim();
      push(clean || line, qty);
      continue;
    }
    if (qty) {
      if (pending) { push(pending, qty); pending = null; continue; }
      push(line.replace(QTY, '').trim() || line, qty);
      continue;
    }
    if (!NOISY.has(upper) && line.length >= 6) pending = pending ? `${pending} ${line}` : line;
  }
  if (pending) push(pending, null);
  return out;
}

router.post('/projects/:id/bom-items', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  try {
    const p = await projectOr404(req, res);
    if (!p) return;
    const item = trunc(req.body?.item, 2000);
    if (!item) return errorOut(res, 400, 'Type the BOM item.');
    const status = BOM_STATUSES.includes(req.body?.status) ? req.body.status : 'not_ready';
    await pool.query(
      `INSERT INTO installation_bom_items (project_id, section, item, qty, status, done_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ${status === 'done' ? 'NOW()' : 'NULL'}, ?)`,
      [p.id, trunc(req.body?.section, 120) || 'MANUAL', item, trunc(req.body?.qty, 60), status, req.user.id]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// Pasted BOM text -> lines. ?preview=1 only shows what it would add.
router.post('/projects/:id/bom-items/import', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  try {
    const p = await projectOr404(req, res);
    if (!p) return;
    const rows = parseBomText(req.body?.text);
    if (req.query.preview === '1') return res.json({ rows });
    if (!rows.length) return errorOut(res, 400, 'No BOM lines were found in that text.');
    if (bool(req.body?.replace)) await pool.query('DELETE FROM installation_bom_items WHERE project_id = ?', [p.id]);
    await pool.query(
      'INSERT INTO installation_bom_items (project_id, section, item, qty, status, updated_by_user_id) VALUES ?',
      [rows.map((r) => [p.id, r.section, r.item, r.qty, 'not_ready', req.user.id])]);
    res.status(201).json({ added: rows.length });
  } catch (err) { next(err); }
});

router.patch('/projects/:id/bom-items/:itemId', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!BOM_STATUSES.includes(status)) return errorOut(res, 400, 'Unknown status');
    const [r] = await pool.query(
      `UPDATE installation_bom_items SET status = ?, done_at = ${status === 'done' ? 'COALESCE(done_at, NOW())' : 'NULL'}, updated_by_user_id = ?
        WHERE id = ? AND project_id = ?`, [status, req.user.id, req.params.itemId, req.params.id]);
    if (!r.affectedRows) return errorOut(res, 404, 'BOM item not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/projects/:id/bom-items/:itemId', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM installation_bom_items WHERE id = ? AND project_id = ?', [req.params.itemId, req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- crew & vehicle schedule (slots)

// Who -- or which vehicle -- is on which project, on which day, from what time to what time. Four
// roles (2026-11-09): installer, subcon and driver are employees (Position Code INSTALLER / SUBCON /
// DRIVER), vehicle is an Assets > Fleet asset. One person or vehicle may be on two projects the same day
// (JO-123 8:00-11:30, JO-321 1:00-4:30) but not on two at once: a slot that overlaps one of theirs on any
// project -- other than a cancelled one -- is refused, naming it. A person is one person whatever the
// role, so an overlap is checked across all of their slots.
const SLOT_ROLES = ['installer', 'subcon', 'driver', 'vehicle'];
const ROLE_LABEL = { installer: 'installer', subcon: 'subcon', driver: 'driver', vehicle: 'vehicle' };
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const hm = (t) => String(t).slice(0, 5);
const ampm = (t) => { const [h, m] = hm(t).split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const CREW_SELECT = `
  SELECT s.id, s.project_id, s.role, s.employee_id, s.asset_id, s.work_date, s.start_time, s.end_time, s.note,
         e.first_name, e.last_name, p.project_no, p.title AS project_title, p.status AS project_status,
         jo.job_order_no, vd.plate_no, COALESCE(vd.make, va.brand) AS make, COALESCE(vd.model, va.model) AS model, vai.display_name AS asset_name, va.reference_no
    FROM installation_crew_slots s
    JOIN installation_projects p ON p.id = s.project_id
    LEFT JOIN employees e ON e.id = s.employee_id
    LEFT JOIN job_orders jo ON jo.id = p.job_order_id
    LEFT JOIN assets va ON va.id = s.asset_id
    LEFT JOIN asset_items vai ON vai.id = va.asset_item_id
    LEFT JOIN vehicle_details vd ON vd.asset_id = s.asset_id`;

// Every slot in [from, to] (the Crew calendar), optionally one installer's.
router.get('/crew', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) return errorOut(res, 400, 'from and to (YYYY-MM-DD) are required');
    const where = ['s.work_date BETWEEN ? AND ?', "p.status <> 'cancelled'"];
    const params = [from, to];
    if (SLOT_ROLES.includes(req.query.role)) { where.push('s.role = ?'); params.push(req.query.role); }
    if (idOrNull(req.query.employee_id)) { where.push('s.employee_id = ?'); params.push(Number(req.query.employee_id)); }
    if (idOrNull(req.query.asset_id)) { where.push('s.asset_id = ?'); params.push(Number(req.query.asset_id)); }
    if (String(req.query.search || '').trim()) {
      where.push(PROJECT_SEARCH);
      params.push(...Array(PROJECT_SEARCH_ARGS).fill(`%${String(req.query.search).trim()}%`));
    }
    const [rows] = await pool.query(`${CREW_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.work_date, s.start_time, e.first_name`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

function readSlot(body, project) {
  const role = SLOT_ROLES.includes(body.role) ? body.role : 'installer';
  const employeeId = role === 'vehicle' ? null : idOrNull(body.employee_id);
  const assetId = role === 'vehicle' ? idOrNull(body.asset_id) : null;
  if (role === 'vehicle' ? !assetId : !employeeId) return { error: `Choose the ${ROLE_LABEL[role]}.` };
  if (!isDate(body.work_date)) return { error: 'Choose the day.' };
  if (!TIME.test(body.start_time || '') || !TIME.test(body.end_time || '')) return { error: 'Enter the start and end time.' };
  const start = hm(body.start_time);
  const end = hm(body.end_time);
  if (end <= start) return { error: 'The end time must be after the start time.' };
  const from = project.date_from ? String(project.date_from).slice(0, 10) : null;
  const to = project.date_to ? String(project.date_to).slice(0, 10) : from;
  if (!from) return { error: "Set the project's Timeline From / To first -- the crew and vehicles are scheduled on its days." };
  if (body.work_date < from || body.work_date > to) return { error: `Pick a day within the project's timeline (${from} to ${to}).` };
  return { values: { role, employee_id: employeeId, asset_id: assetId, work_date: body.work_date, start_time: start, end_time: end, note: trunc(body.note, 500) } };
}

// Saves a slot (new, or slotId) after checking the installer is free then. Locks that installer's day
// so two planners booking them at once cannot both get in.
async function saveSlot(req, res, slotId) {
  const conn = await pool.getConnection();
  try {
    const [[p]] = await conn.query('SELECT id, date_from, date_to, status FROM installation_projects WHERE id = ?', [req.params.id]);
    if (!p) return errorOut(res, 404, 'Project not found');
    if (p.status === 'cancelled') return errorOut(res, 409, 'This project is cancelled.');
    const r = readSlot(req.body || {}, p);
    if (r.error) return errorOut(res, 400, r.error);
    const v = r.values;
    if (v.role === 'installer') {
      const bad = await notInstallers(conn, [v.employee_id], p.id);
      if (bad.length) return errorOut(res, 400, notInstallerError(bad));
    } else if (v.role === 'subcon') {
      const bad = await notSubcons(conn, [v.employee_id], p.id);
      if (bad.length) return errorOut(res, 400, notSubconError(bad));
    } else if (v.role === 'driver') {
      const noDriver = await driverProblem(conn, v.employee_id, p.id);
      if (noDriver) return errorOut(res, 400, noDriver);
    } else if (!(await isFleetVehicle(conn, v.asset_id))) {
      return errorOut(res, 400, 'That is not one of the vehicles in Assets > Fleet.');
    }
    await conn.beginTransaction();
    if (slotId) {
      const [[mine]] = await conn.query('SELECT id FROM installation_crew_slots WHERE id = ? AND project_id = ? FOR UPDATE', [slotId, p.id]);
      if (!mine) { await conn.rollback(); return errorOut(res, 404, 'Schedule slot not found'); }
    }
    const who = v.role === 'vehicle' ? 's.asset_id = ?' : 's.employee_id = ?';
    const [clash] = await conn.query(
      `${CREW_SELECT}
        WHERE ${who} AND s.work_date = ? AND s.start_time < ? AND s.end_time > ?
          AND p.status <> 'cancelled' AND s.id <> ?
        ORDER BY s.start_time FOR UPDATE OF s`,
      [v.role === 'vehicle' ? v.asset_id : v.employee_id, v.work_date, v.end_time, v.start_time, slotId || 0]);
    if (clash.length) {
      await conn.rollback();
      const c = clash[0];
      const where = c.project_id === p.id ? 'this project' : `${c.project_no}${c.job_order_no ? ` (${c.job_order_no})` : ''}`;
      const name = v.role === 'vehicle' ? vehicleName(c) : `${c.first_name} ${c.last_name}`;
      const as = v.role !== 'vehicle' && c.role !== v.role ? ` as ${ROLE_LABEL[c.role]}` : '';
      return errorOut(res, 409, `${name} is already on ${where}${as} from ${ampm(c.start_time)} to ${ampm(c.end_time)} that day.`);
    }
    if (slotId) await conn.query('UPDATE installation_crew_slots SET ? WHERE id = ?', [v, slotId]);
    else await conn.query('INSERT INTO installation_crew_slots SET ?', [{ ...v, project_id: p.id, created_by_user_id: req.user.id }]);
    // Scheduled on the project = on the project: an installer / subcon joins its crew, a vehicle its
    // vehicles, and a driver becomes its driver when it has none yet.
    if (v.role === 'installer') await conn.query('INSERT IGNORE INTO installation_project_installers (project_id, employee_id) VALUES (?, ?)', [p.id, v.employee_id]);
    else if (v.role === 'subcon') await conn.query('INSERT IGNORE INTO installation_project_subcon_employees (project_id, employee_id) VALUES (?, ?)', [p.id, v.employee_id]);
    else if (v.role === 'vehicle') await conn.query('INSERT IGNORE INTO installation_project_vehicles (project_id, asset_id) VALUES (?, ?)', [p.id, v.asset_id]);
    else await conn.query('UPDATE installation_projects SET driver_employee_id = ? WHERE id = ? AND driver_employee_id IS NULL', [v.employee_id, p.id]);
    await conn.commit();
    res.status(slotId ? 200 : 201).json({ ok: true });
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally { conn.release(); }
}

router.post('/projects/:id/crew', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try { await saveSlot(req, res, null); } catch (err) { next(err); }
});

router.put('/projects/:id/crew/:slotId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try { await saveSlot(req, res, Number(req.params.slotId)); } catch (err) { next(err); }
});

router.delete('/projects/:id/crew/:slotId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM installation_crew_slots WHERE id = ? AND project_id = ?', [req.params.slotId, req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- reschedule requests (SBU approval)

// The planner drags a project's bar to new dates on the calendar, gives a reason (Lookups > Reasons,
// type Reschedule) and forwards it to the SBU; the project's Timeline From / To change only when the
// SBU approves. One request waits per project at a time.
//
// Who decides: the SBU over the Job Order's sales division (lib/sbuGroups.js, the same scope that
// approves that division's orders); any SBU when the project has no JO or its order has no division;
// a System Admin always.
const RESCHEDULE_SELECT = `
  SELECT r.*, p.project_no, p.title AS project_title, p.status AS project_status, jo.job_order_no,
         rq.display_name AS requested_by_name, dc.display_name AS decided_by_name,
         COALESCE(s.sales_division_id, ns.sales_division_id) AS department_id
    FROM installation_reschedule_requests r
    JOIN installation_projects p ON p.id = r.project_id
    LEFT JOIN job_orders jo ON jo.id = p.job_order_id
    LEFT JOIN sales_orders s ON s.id = jo.sales_order_id
    LEFT JOIN non_standard_sales_orders ns ON ns.id = jo.nsso_id
    LEFT JOIN users rq ON rq.id = r.requested_by_user_id
    LEFT JOIN users dc ON dc.id = r.decided_by_user_id`;

async function canDecideReschedule(userId, departmentId) {
  if (await isSystemAdmin(userId)) return true;
  const [[u]] = await pool.query('SELECT is_sales_business_unit FROM users WHERE id = ? AND is_active = 1', [userId]);
  if (!u?.is_sales_business_unit) return false;
  if (departmentId == null) return true;
  return sbuCanApproveDepartment(userId, departmentId);
}

// The SBUs who may decide a request -- told when one is forwarded.
async function deciders(departmentId) {
  const [sbus] = await pool.query("SELECT id FROM users WHERE is_sales_business_unit = 1 AND is_active = 1 AND (account_type IS NULL OR account_type <> 'System Admin')");
  const out = [];
  for (const u of sbus) if (departmentId == null || await sbuCanApproveDepartment(u.id, departmentId)) out.push(u.id);
  return out;
}

const dayText = (d) => (d ? String(d).slice(0, 10) : '—');
const rangeText = (f, t) => (f ? `${dayText(f)}${t && dayText(t) !== dayText(f) ? ` to ${dayText(t)}` : ''}` : 'no dates');

// Each with may_decide / may_cancel for the viewer.
async function withActions(rows, userId) {
  const admin = await isSystemAdmin(userId);
  const out = [];
  for (const r of rows) {
    const open = r.status === 'for_approval';
    out.push({
      ...r,
      may_decide: open && await canDecideReschedule(userId, r.department_id),
      may_cancel: open && (admin || Number(r.requested_by_user_id) === Number(userId)),
    });
  }
  return out;
}

router.get('/reschedule-reasons', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM reasons WHERE is_active = 1 AND reason_type = 'Reschedule' ORDER BY name")
      .catch(() => [[]]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/reschedules', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const status = ['for_approval', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : 'for_approval';
    const [rows] = await pool.query(`${RESCHEDULE_SELECT} WHERE r.status = ? ORDER BY r.requested_at DESC LIMIT 200`, [status]);
    res.json(await withActions(rows, req.user.id));
  } catch (err) { next(err); }
});

router.post('/projects/:id/reschedules', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const p = await projectOr404(req, res);
    if (!p) return;
    if (['done', 'cancelled'].includes(p.status)) return errorOut(res, 409, `This project is ${p.status} -- it is not rescheduled.`);
    const { new_date_from: from, new_date_to: to } = req.body || {};
    if (!isDate(from) || !isDate(to)) return errorOut(res, 400, 'The new dates are missing.');
    if (to < from) return errorOut(res, 400, 'The new end date is before the new start date.');
    if (from === dayText(p.date_from) && to === dayText(p.date_to || p.date_from)) return errorOut(res, 400, 'Those are the dates it already has.');
    const reasonId = idOrNull(req.body?.reason_id);
    if (!reasonId) return errorOut(res, 400, 'Choose the reason for the reschedule.');
    const [[reason]] = await pool.query("SELECT id, name FROM reasons WHERE id = ? AND is_active = 1 AND reason_type = 'Reschedule'", [reasonId]);
    if (!reason) return errorOut(res, 400, 'That reason is not one of the Reschedule reasons in Lookups.');
    const [[open]] = await pool.query("SELECT id FROM installation_reschedule_requests WHERE project_id = ? AND status = 'for_approval'", [p.id]);
    if (open) return errorOut(res, 409, 'A reschedule of this project is already waiting for the SBU -- cancel it first to ask for different dates.');
    const [ins] = await pool.query(
      `INSERT INTO installation_reschedule_requests
         (project_id, old_date_from, old_date_to, new_date_from, new_date_to, reason_id, reason_name, remarks, requested_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.date_from, p.date_to || p.date_from, from, to, reason.id, reason.name, trunc(req.body?.remarks, 1000), req.user.id]);
    const [[row]] = await pool.query(`${RESCHEDULE_SELECT} WHERE r.id = ?`, [ins.insertId]);
    insertFor(await deciders(row.department_id), {
      type: 'installation_reschedule',
      title: `Reschedule for approval: ${p.project_no}${row.job_order_no ? ` (${row.job_order_no})` : ''}`,
      message: `${rangeText(p.date_from, p.date_to)} -> ${rangeText(from, to)} · ${reason.name}`,
      relatedType: 'installation_project', relatedId: p.id,
    }, req.user.id).catch(() => {});
    res.status(201).json({ id: ins.insertId });
  } catch (err) { next(err); }
});

async function decide(req, res, verdict) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[r]] = await conn.query(`${RESCHEDULE_SELECT} WHERE r.id = ? FOR UPDATE OF r`, [req.params.rid]);
    if (!r) { await conn.rollback(); return errorOut(res, 404, 'Reschedule request not found'); }
    if (r.status !== 'for_approval') { await conn.rollback(); return errorOut(res, 409, `This request was already ${r.status.replace('_', ' ')}.`); }
    const admin = await isSystemAdmin(req.user.id);
    if (verdict === 'cancelled') {
      if (!admin && Number(r.requested_by_user_id) !== Number(req.user.id)) { await conn.rollback(); return errorOut(res, 403, 'Only whoever asked for it can cancel this request.'); }
    } else if (!(await canDecideReschedule(req.user.id, r.department_id))) {
      await conn.rollback(); return errorOut(res, 403, "Only the SBU over this job's sales division can approve or reject its reschedule.");
    }
    const note = trunc(req.body?.note, 1000);
    if (verdict === 'rejected' && !note) { await conn.rollback(); return errorOut(res, 400, 'Say why it is rejected.'); }
    await conn.query(
      'UPDATE installation_reschedule_requests SET status = ?, decided_by_user_id = ?, decided_at = NOW(), decision_note = ? WHERE id = ?',
      [verdict, req.user.id, note, r.id]);
    if (verdict === 'approved') {
      await conn.query('UPDATE installation_projects SET date_from = ?, date_to = ? WHERE id = ?', [r.new_date_from, r.new_date_to, r.project_id]);
    }
    await conn.commit();
    if (verdict !== 'cancelled') {
      insertFor([r.requested_by_user_id], {
        type: 'installation_reschedule',
        title: `Reschedule ${verdict}: ${r.project_no}${r.job_order_no ? ` (${r.job_order_no})` : ''}`,
        message: `${rangeText(r.new_date_from, r.new_date_to)}${note ? ` · ${note}` : ''}`,
        relatedType: 'installation_project', relatedId: r.project_id,
      }, req.user.id).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally { conn.release(); }
}

router.post('/reschedules/:rid/approve', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { await decide(req, res, 'approved'); } catch (err) { next(err); }
});
router.post('/reschedules/:rid/reject', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { await decide(req, res, 'rejected'); } catch (err) { next(err); }
});
router.post('/reschedules/:rid/cancel', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { await decide(req, res, 'cancelled'); } catch (err) { next(err); }
});

// ---------------------------------------------------------------- progress updates

router.post('/projects/:id/progress', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const percent = Number(req.body?.percent);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) return errorOut(res, 400, 'Progress must be a whole number from 0 to 100.');
    let photo = null;
    if (req.body?.photo?.data) {
      photo = decodeUpload(req.body.photo);
      if (photo.error) return errorOut(res, photo.status || 400, photo.error);
      if (!/^image\//.test(photo.mime)) return errorOut(res, 400, 'The photo must be an image.');
      photo = await shrunk(photo);
    }
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT id, progress, status FROM installation_projects WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!p) { await conn.rollback(); return errorOut(res, 404, 'Project not found'); }
    await conn.query(
      `INSERT INTO installation_progress_updates (project_id, percent, note, photo_name, photo_mime, photo_data, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [p.id, percent, trunc(req.body?.note, 5000), photo?.fileName || null, photo?.mime || null, photo?.buf || null, req.user.id]);
    const progress = Math.min(100, (Number(p.progress) || 0) + percent);
    let { status } = p;
    if (progress >= 100) status = 'done';
    else if (status === 'pending') status = 'ongoing';
    await conn.query('UPDATE installation_projects SET progress = ?, status = ? WHERE id = ?', [progress, status, p.id]);
    await conn.commit();
    res.status(201).json({ progress, status });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.get('/projects/:id/progress/:updateId/photo', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[g]] = await pool.query(
      'SELECT photo_name, photo_mime, photo_data FROM installation_progress_updates WHERE id = ? AND project_id = ?',
      [req.params.updateId, req.params.id]);
    if (!g?.photo_data) return errorOut(res, 404, 'No photo on this update');
    sendBlob(res, { name: g.photo_name, mime: g.photo_mime, data: g.photo_data });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- categories + checklists

router.get('/categories', requireAuth, requirePermission(CAT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [cats] = await pool.query(
      `SELECT c.*, (SELECT COUNT(*) FROM installation_projects p WHERE p.category_id = c.id) AS project_count
         FROM installation_categories c ORDER BY c.name`);
    const [items] = await pool.query('SELECT * FROM installation_checklist_items ORDER BY category_id, sort_order, id');
    res.json(cats.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) })));
  } catch (err) { next(err); }
});

function readCategory(body) {
  const name = trunc(body.name, 150);
  if (!name) return { error: 'Enter the category name.' };
  return { values: { name, description: trunc(body.description, 5000), is_active: body.is_active === undefined || bool(body.is_active) ? 1 : 0 } };
}

const dupName = (err, res) => (err.code === 'ER_DUP_ENTRY' ? (errorOut(res, 409, 'A category with that name already exists.'), true) : false);

router.post('/categories', requireAuth, requirePermission(CAT_ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const r = readCategory(req.body || {});
    if (r.error) return errorOut(res, 400, r.error);
    const [ins] = await pool.query('INSERT INTO installation_categories SET ?', [r.values]);
    res.status(201).json({ id: ins.insertId });
  } catch (err) { if (!dupName(err, res)) next(err); }
});

router.put('/categories/:id', requireAuth, requirePermission(CAT_ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const r = readCategory(req.body || {});
    if (r.error) return errorOut(res, 400, r.error);
    const [u] = await pool.query('UPDATE installation_categories SET ? WHERE id = ?', [r.values, req.params.id]);
    if (!u.affectedRows) return errorOut(res, 404, 'Category not found');
    res.json({ ok: true });
  } catch (err) { if (!dupName(err, res)) next(err); }
});

router.delete('/categories/:id', requireAuth, requirePermission(CAT_ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM installation_projects WHERE category_id = ?', [req.params.id]);
    if (used.n) return errorOut(res, 409, `${used.n} project(s) use this category -- set it inactive instead.`);
    await pool.query('DELETE FROM installation_categories WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

function readItem(body) {
  const item = trunc(body.item, 255);
  if (!item) return { error: 'Type the checklist item.' };
  const sort = Number(body.sort_order);
  return {
    values: {
      item,
      sort_order: Number.isInteger(sort) && sort >= 0 ? sort : 0,
      is_required: bool(body.is_required) ? 1 : 0,
      is_active: body.is_active === undefined || bool(body.is_active) ? 1 : 0,
    },
  };
}

router.post('/categories/:id/items', requireAuth, requirePermission(CAT_ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const r = readItem(req.body || {});
    if (r.error) return errorOut(res, 400, r.error);
    const [[c]] = await pool.query('SELECT id FROM installation_categories WHERE id = ?', [req.params.id]);
    if (!c) return errorOut(res, 404, 'Category not found');
    const [ins] = await pool.query('INSERT INTO installation_checklist_items SET ?', [{ ...r.values, category_id: c.id }]);
    res.status(201).json({ id: ins.insertId });
  } catch (err) { next(err); }
});

router.put('/checklist-items/:itemId', requireAuth, requirePermission(CAT_ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const r = readItem(req.body || {});
    if (r.error) return errorOut(res, 400, r.error);
    const [u] = await pool.query('UPDATE installation_checklist_items SET ? WHERE id = ?', [r.values, req.params.itemId]);
    if (!u.affectedRows) return errorOut(res, 404, 'Checklist item not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/checklist-items/:itemId', requireAuth, requirePermission(CAT_ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM installation_checklist_items WHERE id = ?', [req.params.itemId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.parseBomText = parseBomText;
