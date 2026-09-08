const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { resolveCustody, wouldCreateCycle, descendantIds, recordMovement } = require('../lib/assetCustody');

const router = express.Router();

// The asset register: every individual unit, keyed by the reference number the audit team calls
// out. An asset is either a ROOT (it sits at a location, held by a custodian) or ATTACHED to a
// root -- the UPS reference 1542 plugged into the System Unit "PC 1" -- in which case it is
// wherever its host is.
//
// Nesting is capped at ONE level: a host may not itself be attached to something else. Every real
// case is component-into-host (UPS into a PC, RAM into a system unit), and the cap is what lets
// the list query resolve a location with one exact join instead of walking a chain per row. The
// general chain walker in lib/assetCustody.js stays as the defensive path -- it is what detail
// views and moves use, and it still copes if older data ever turns out to be deeper.
const ROUTE = '/assets';

const STATUSES = new Set(['active', 'for_repair', 'retired', 'disposed', 'missing']);
const CONDITIONS = new Set(['good', 'fair', 'poor', 'damaged']);
const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const numOrNull = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const idOrNull = (v) => (v == null || v === '' ? null : v);

// Effective custody, as SQL. An attached unit takes its host's location outright -- it never
// falls back to its own columns, because those are exactly the stale values this module exists
// to stop anyone reading. COALESCE would reintroduce that fallback, hence the explicit CASE.
const EFFECTIVE_LOCATION = 'CASE WHEN a.parent_asset_id IS NULL THEN a.location_id ELSE p.location_id END';
const EFFECTIVE_CUSTODIAN = 'CASE WHEN a.parent_asset_id IS NULL THEN a.custodian_employee_id ELSE p.custodian_employee_id END';
const EFFECTIVE_DEPARTMENT = 'CASE WHEN a.parent_asset_id IS NULL THEN a.department_id ELSE p.department_id END';

async function logAudit(conn, { assetId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Asset', ?, ?, ?, ?, ?, ?)`,
    [assetId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId],
  );
}

// Lookups for the create/edit form and the register filters.
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [items] = await pool.query(
      'SELECT id, item_code, display_name, category, brand, model FROM asset_items WHERE is_active = TRUE ORDER BY display_name',
    );
    const [locations] = await pool.query('SELECT id, location_code, location_name FROM locations WHERE is_active = TRUE ORDER BY location_name');
    const [employees] = await pool.query(
      `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, e.employee_code, d.name AS department_name, e.department_id
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.is_active = TRUE ORDER BY e.first_name, e.last_name`,
    );
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [categories] = await pool.query(
      "SELECT DISTINCT category FROM asset_items WHERE category IS NOT NULL AND category <> '' ORDER BY category",
    );
    res.json({
      items,
      locations,
      employees,
      departments,
      categories: categories.map((c) => c.category),
      statuses: [...STATUSES],
      conditions: [...CONDITIONS],
    });
  } catch (err) { next(err); }
});

// Candidate hosts for the "attached to" picker: root assets only (the one-level cap), never the
// asset being edited, and never one that is already out of circulation.
router.get('/hosts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const excludeId = req.query.exclude_id || 0;
    const [rows] = await pool.query(
      `SELECT a.id, a.reference_no, a.serial_no, ai.display_name AS item_name,
              loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name
         FROM assets a
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN locations loc ON loc.id = a.location_id
         LEFT JOIN employees e ON e.id = a.custodian_employee_id
        WHERE a.parent_asset_id IS NULL AND a.id <> ? AND a.status IN ('active', 'for_repair')
        ORDER BY ai.display_name, a.reference_no`,
      [excludeId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function buildListWhere(query) {
  const where = [];
  const params = [];
  const { search, status, location_id: locationId, custodian_employee_id: custodianId, asset_item_id: itemId, category, attached } = query;

  if (status) { where.push('a.status = ?'); params.push(status); }
  if (itemId) { where.push('a.asset_item_id = ?'); params.push(itemId); }
  if (category) { where.push('ai.category = ?'); params.push(category); }
  // Filtering on where the asset IS, not on the column -- an attached unit must turn up under its
  // host's location, which is the entire point of the register.
  if (locationId) { where.push(`${EFFECTIVE_LOCATION} = ?`); params.push(locationId); }
  if (custodianId) { where.push(`${EFFECTIVE_CUSTODIAN} = ?`); params.push(custodianId); }
  if (attached === 'yes') where.push('a.parent_asset_id IS NOT NULL');
  if (attached === 'no') where.push('a.parent_asset_id IS NULL');
  if (search) {
    where.push('(a.reference_no LIKE ? OR a.serial_no LIKE ? OR a.tag_no LIKE ? OR ai.display_name LIKE ? OR ai.brand LIKE ? OR ai.model LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// Paginated in SQL, not in the browser. Every list in this module answers an audit question over
// the whole register, so shipping the entire table to render fifteen rows would get slower every
// month the company buys equipment.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = buildListWhere(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));

    // One FROM clause for both queries. Every join here is a LEFT JOIN on a primary key, so it
    // cannot multiply rows -- the COUNT stays exact even though it does not need the display joins.
    const fromSql = `
      FROM assets a
      LEFT JOIN assets p ON p.id = a.parent_asset_id
      LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
      LEFT JOIN asset_items pi ON pi.id = p.asset_item_id
      LEFT JOIN locations loc ON loc.id = ${EFFECTIVE_LOCATION}
      LEFT JOIN employees e ON e.id = ${EFFECTIVE_CUSTODIAN}
      LEFT JOIN departments d ON d.id = ${EFFECTIVE_DEPARTMENT}
      ${whereSql}`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${fromSql}`, params);
    const [rows] = await pool.query(
      `SELECT a.id, a.reference_no, a.serial_no, a.tag_no, a.status, a.asset_condition,
              a.parent_asset_id, a.acquired_date, a.acquisition_cost,
              ai.id AS asset_item_id, ai.display_name AS item_name, ai.category, ai.brand, ai.model,
              p.reference_no AS parent_reference_no, pi.display_name AS parent_item_name,
              ${EFFECTIVE_LOCATION} AS location_id,
              ${EFFECTIVE_CUSTODIAN} AS custodian_employee_id,
              loc.location_name,
              CONCAT(e.first_name, ' ', e.last_name) AS custodian_name,
              d.name AS department_name
       ${fromSql}
       ORDER BY ai.display_name, a.reference_no
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

// The register as the user describes it: the type on top, its reference numbers underneath.
//
//   UPS
//     Ref 023123
//     Ref 123124
//
// Paginated by TYPE rather than by unit, so a type never arrives with half its references missing
// -- a half-listed type reads as a shortage, which is the one thing an asset register must not
// invent.
router.get('/tree', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = buildListWhere(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size) || 10));

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(DISTINCT ai.id) AS total
         FROM assets a
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         JOIN asset_items ai ON ai.id = a.asset_item_id
         ${whereSql}`,
      params,
    );

    const [groups] = await pool.query(
      `SELECT ai.id, ai.item_code, ai.display_name, ai.category, ai.brand, ai.model, COUNT(a.id) AS unit_count
         FROM assets a
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         JOIN asset_items ai ON ai.id = a.asset_item_id
         ${whereSql}
         GROUP BY ai.id, ai.item_code, ai.display_name, ai.category, ai.brand, ai.model
         ORDER BY ai.display_name
         LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    if (!groups.length) return res.json({ groups: [], total, page, page_size: pageSize });

    const itemIds = groups.map((g) => g.id);
    const [units] = await pool.query(
      `SELECT a.id, a.reference_no, a.serial_no, a.status, a.asset_condition, a.parent_asset_id,
              a.asset_item_id,
              p.reference_no AS parent_reference_no, pi.display_name AS parent_item_name,
              loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name,
              d.name AS department_name
         FROM assets a
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN asset_items pi ON pi.id = p.asset_item_id
         LEFT JOIN locations loc ON loc.id = ${EFFECTIVE_LOCATION}
         LEFT JOIN employees e ON e.id = ${EFFECTIVE_CUSTODIAN}
         LEFT JOIN departments d ON d.id = ${EFFECTIVE_DEPARTMENT}
         ${whereSql ? `${whereSql} AND` : 'WHERE'} a.asset_item_id IN (?)
         ORDER BY a.reference_no`,
      [...params, itemIds],
    );

    const byItem = new Map(groups.map((g) => [String(g.id), { ...g, units: [] }]));
    for (const u of units) byItem.get(String(u.asset_item_id))?.units.push(u);
    res.json({ groups: [...byItem.values()], total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[a]] = await pool.query(
      `SELECT a.*, ai.item_code, ai.display_name AS item_name, ai.category, ai.brand, ai.model, ai.specification,
              p.reference_no AS parent_reference_no, pi.display_name AS parent_item_name,
              ${EFFECTIVE_LOCATION} AS effective_location_id,
              ${EFFECTIVE_CUSTODIAN} AS effective_custodian_employee_id,
              loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name,
              d.name AS department_name, cu.display_name AS created_by_name
         FROM assets a
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN asset_items pi ON pi.id = p.asset_item_id
         LEFT JOIN locations loc ON loc.id = ${EFFECTIVE_LOCATION}
         LEFT JOIN employees e ON e.id = ${EFFECTIVE_CUSTODIAN}
         LEFT JOIN departments d ON d.id = ${EFFECTIVE_DEPARTMENT}
         LEFT JOIN users cu ON cu.id = a.created_by_user_id
        WHERE a.id = ?`,
      [req.params.id],
    );
    if (!a) return res.status(404).json({ error: 'Not found' });

    const custody = await resolveCustody(a.id);
    const [attached] = await pool.query(
      `SELECT a.id, a.reference_no, a.serial_no, a.status, ai.display_name AS item_name
         FROM assets a LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
        WHERE a.parent_asset_id = ? ORDER BY ai.display_name, a.reference_no`,
      [a.id],
    );
    const [movements] = await pool.query(
      `SELECT m.*, fl.location_name AS from_location_name, tl.location_name AS to_location_name,
              CONCAT(fe.first_name, ' ', fe.last_name) AS from_custodian_name,
              CONCAT(te.first_name, ' ', te.last_name) AS to_custodian_name,
              u.display_name AS moved_by_name, t.transfer_no
         FROM asset_movements m
         LEFT JOIN locations fl ON fl.id = m.from_location_id
         LEFT JOIN locations tl ON tl.id = m.to_location_id
         LEFT JOIN employees fe ON fe.id = m.from_custodian_employee_id
         LEFT JOIN employees te ON te.id = m.to_custodian_employee_id
         LEFT JOIN users u ON u.id = m.moved_by_user_id
         LEFT JOIN asset_transfers t ON t.id = m.transfer_id
        WHERE m.asset_id = ? ORDER BY m.moved_at DESC, m.id DESC`,
      [a.id],
    );
    // Transfers this asset is currently named on and that have not finished -- shown so nobody
    // raises a second transfer for equipment already halfway through one.
    const [openTransfers] = await pool.query(
      `SELECT t.id, t.transfer_no, t.status, t.date_created, tl.location_name AS to_location_name
         FROM asset_transfer_lines l
         JOIN asset_transfers t ON t.id = l.transfer_id
         LEFT JOIN locations tl ON tl.id = t.to_location_id
        WHERE l.asset_id = ? AND t.status IN ('draft', 'pending_release', 'pending_receipt', 'approved')
        ORDER BY t.id DESC`,
      [a.id],
    );

    res.json({ ...a, custody_chain: custody.chain, is_attached: custody.is_attached, attached_assets: attached, movements, open_transfers: openTransfers });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'Asset' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Shared validation for create and edit. Returns an error string, or null when the payload is
// acceptable.
async function validateAsset(conn, body, { assetId = null } = {}) {
  const { reference_no: referenceNo, asset_item_id: itemId, parent_asset_id: parentId, status, asset_condition: condition } = body;

  if (!referenceNo || !String(referenceNo).trim()) return 'Reference number is required.';
  if (!itemId) return 'Asset type is required.';
  if (status && !STATUSES.has(status)) return `Unknown status: ${status}`;
  if (condition && !CONDITIONS.has(condition)) return `Unknown condition: ${condition}`;

  const [[dupe]] = await conn.query(
    'SELECT id FROM assets WHERE reference_no = ? AND id <> ? LIMIT 1',
    [String(referenceNo).trim(), assetId || 0],
  );
  if (dupe) return `Reference number ${String(referenceNo).trim()} is already used by another asset.`;

  const [[item]] = await conn.query('SELECT id FROM asset_items WHERE id = ?', [itemId]);
  if (!item) return 'Asset type not found.';

  if (parentId) {
    if (assetId && String(parentId) === String(assetId)) return 'An asset cannot be attached to itself.';
    const [[parent]] = await conn.query('SELECT id, parent_asset_id, status FROM assets WHERE id = ?', [parentId]);
    if (!parent) return 'The asset it is attached to was not found.';
    // The one-level cap. Enforced here rather than left to the reader, because a two-deep chain
    // would quietly make the register's location join wrong for the deepest unit.
    if (parent.parent_asset_id) return 'That asset is itself attached to something else. Attach this to the host asset instead.';
    if (!['active', 'for_repair'].includes(parent.status)) return 'Cannot attach to an asset that is retired, disposed or missing.';
    if (assetId && await wouldCreateCycle(assetId, parentId, conn)) return 'That attachment would create a loop.';
    if (assetId) {
      const kids = await descendantIds(assetId, conn);
      if (kids.length) return 'This asset has other assets attached to it, so it cannot itself be attached to something else. Detach them first.';
    }
  }
  return null;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const problem = await validateAsset(conn, b);
    if (problem) return res.status(400).json({ error: problem });

    const parentId = idOrNull(b.parent_asset_id);
    // An attached unit is given no location of its own -- it inherits. Writing the form's values
    // anyway would leave a second, unmaintained answer sitting in the row.
    const locationId = parentId ? null : idOrNull(b.location_id);
    const custodianId = parentId ? null : idOrNull(b.custodian_employee_id);
    const departmentId = parentId ? null : idOrNull(b.department_id);
    if (!parentId && !locationId) return res.status(400).json({ error: 'A location is required unless the asset is attached to another asset.' });

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO assets (reference_no, asset_item_id, parent_asset_id, serial_no, tag_no, location_id,
                           custodian_employee_id, department_id, status, asset_condition, acquired_date,
                           acquisition_cost, remarks, created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [String(b.reference_no).trim(), b.asset_item_id, parentId, trunc(b.serial_no, 120), trunc(b.tag_no, 60),
        locationId, custodianId, departmentId, b.status || 'active', b.asset_condition || 'good',
        b.acquired_date || null, numOrNull(b.acquisition_cost), trunc(b.remarks, 1000), req.user.id],
    );
    const assetId = r.insertId;

    // The opening ledger row. Without it an asset registered straight into a location has an
    // empty history, and the audit team cannot tell "never moved" from "never recorded".
    const custody = await resolveCustody(assetId, conn);
    await recordMovement(conn, {
      assetId,
      movementType: 'registered',
      toLocationId: custody.location_id,
      toCustodianEmployeeId: custody.custodian_employee_id,
      remarks: parentId ? 'Registered as an attached asset' : 'Registered',
      userId: req.user.id,
    });
    await logAudit(conn, { assetId, userId: req.user.id, eventType: 'Created', fieldName: 'reference_no', newValue: String(b.reference_no).trim() });
    await conn.commit();
    res.status(201).json({ id: assetId, reference_no: String(b.reference_no).trim() });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Editing corrects the RECORD -- specification, serial, condition, what it is attached to. It does
// not move an asset between custodians: that is what a transfer is for, and letting an edit do it
// silently would route straight past both approvals. Location and custodian are therefore ignored
// here for an asset that already has a movement history; see PUT /:id/relocate for the deliberate
// correction path.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const assetId = req.params.id;
    const [[existing]] = await conn.query('SELECT * FROM assets WHERE id = ?', [assetId]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const b = req.body;
    const problem = await validateAsset(conn, b, { assetId });
    if (problem) return res.status(400).json({ error: problem });

    const [[openTransfer]] = await conn.query(
      `SELECT t.transfer_no FROM asset_transfer_lines l JOIN asset_transfers t ON t.id = l.transfer_id
        WHERE l.asset_id = ? AND t.status IN ('pending_release', 'pending_receipt', 'approved') LIMIT 1`,
      [assetId],
    );
    if (openTransfer) return res.status(409).json({ error: `This asset is on transfer ${openTransfer.transfer_no}, which is still in progress. Finish or cancel it first.` });

    const parentId = idOrNull(b.parent_asset_id);
    const wasAttached = existing.parent_asset_id != null;
    const nowAttached = parentId != null;

    // Attaching hands custody to the host; detaching has to give the unit somewhere to be, so the
    // caller must say where -- otherwise a detached UPS ends up at no location at all.
    let locationId = existing.location_id;
    let custodianId = existing.custodian_employee_id;
    let departmentId = existing.department_id;
    if (nowAttached) {
      locationId = null; custodianId = null; departmentId = null;
    } else if (wasAttached) {
      locationId = idOrNull(b.location_id);
      custodianId = idOrNull(b.custodian_employee_id);
      departmentId = idOrNull(b.department_id);
      if (!locationId) return res.status(400).json({ error: 'Detaching this asset needs a location for it to stand on its own.' });
    }

    await conn.beginTransaction();
    const before = await resolveCustody(assetId, conn);
    await conn.query(
      `UPDATE assets SET reference_no = ?, asset_item_id = ?, parent_asset_id = ?, serial_no = ?, tag_no = ?,
              location_id = ?, custodian_employee_id = ?, department_id = ?, status = ?, asset_condition = ?,
              acquired_date = ?, acquisition_cost = ?, remarks = ?, updated_at = NOW()
        WHERE id = ?`,
      [String(b.reference_no).trim(), b.asset_item_id, parentId, trunc(b.serial_no, 120), trunc(b.tag_no, 60),
        locationId, custodianId, departmentId, b.status || existing.status, b.asset_condition || existing.asset_condition,
        b.acquired_date || null, numOrNull(b.acquisition_cost), trunc(b.remarks, 1000), assetId],
    );

    for (const field of ['reference_no', 'serial_no', 'tag_no', 'status', 'asset_condition']) {
      const oldV = existing[field];
      const newV = field === 'reference_no' ? String(b.reference_no).trim() : (b[field] ?? existing[field]);
      if (String(oldV ?? '') !== String(newV ?? '')) {
        await logAudit(conn, { assetId, userId: req.user.id, eventType: 'Updated', fieldName: field, oldValue: oldV, newValue: newV });
      }
    }

    if (wasAttached !== nowAttached || String(existing.parent_asset_id ?? '') !== String(parentId ?? '')) {
      const after = await resolveCustody(assetId, conn);
      await recordMovement(conn, {
        assetId,
        movementType: nowAttached ? 'attached' : 'detached',
        fromLocationId: before.location_id,
        fromCustodianEmployeeId: before.custodian_employee_id,
        toLocationId: after.location_id,
        toCustodianEmployeeId: after.custodian_employee_id,
        remarks: nowAttached ? 'Attached to a host asset' : 'Detached from its host asset',
        userId: req.user.id,
      });
      await logAudit(conn, { assetId, userId: req.user.id, eventType: 'Updated', fieldName: 'parent_asset_id', oldValue: existing.parent_asset_id, newValue: parentId });
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// The deliberate correction path: the register says one thing, the floor says another, and this
// is an error being fixed rather than equipment changing hands. Gated on can_approve and it always
// writes a ledger row with a reason, so a correction can never look like an ordinary transfer.
router.put('/:id/relocate', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const assetId = req.params.id;
    const { location_id: locationId, custodian_employee_id: custodianId, department_id: departmentId, reason } = req.body;
    if (!locationId) return res.status(400).json({ error: 'A location is required.' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required for a correction.' });

    const [[existing]] = await conn.query('SELECT id, parent_asset_id FROM assets WHERE id = ?', [assetId]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.parent_asset_id) return res.status(400).json({ error: 'This asset is attached to another asset. Correct the host, or detach it first.' });

    await conn.beginTransaction();
    const before = await resolveCustody(assetId, conn);
    await conn.query(
      'UPDATE assets SET location_id = ?, custodian_employee_id = ?, department_id = ?, updated_at = NOW() WHERE id = ?',
      [locationId, idOrNull(custodianId), idOrNull(departmentId), assetId],
    );
    await recordMovement(conn, {
      assetId,
      movementType: 'correction',
      fromLocationId: before.location_id,
      fromCustodianEmployeeId: before.custodian_employee_id,
      toLocationId: locationId,
      toCustodianEmployeeId: idOrNull(custodianId),
      remarks: `Correction: ${String(reason).trim()}`,
      userId: req.user.id,
    });
    for (const childId of await descendantIds(assetId, conn)) {
      await recordMovement(conn, {
        assetId: childId,
        movementType: 'carried',
        fromLocationId: before.location_id,
        fromCustodianEmployeeId: before.custodian_employee_id,
        toLocationId: locationId,
        toCustodianEmployeeId: idOrNull(custodianId),
        remarks: 'Moved with its host asset (correction)',
        userId: req.user.id,
      });
    }
    await logAudit(conn, { assetId, userId: req.user.id, eventType: 'Status Change', fieldName: 'location_id', oldValue: before.location_id, newValue: locationId });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/status', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { status, remarks } = req.body;
    if (!STATUSES.has(status)) return res.status(400).json({ error: `Unknown status: ${status}` });
    const [[existing]] = await conn.query('SELECT id, status FROM assets WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    // Retiring a host would leave its attached units inheriting a location from something that is
    // no longer in service, so they have to be dealt with first.
    if (!['active', 'for_repair'].includes(status)) {
      const kids = await descendantIds(req.params.id, conn);
      if (kids.length) return res.status(409).json({ error: 'Detach the assets attached to this one before retiring or disposing of it.' });
    }

    await conn.beginTransaction();
    await conn.query('UPDATE assets SET status = ?, updated_at = NOW() WHERE id = ?', [status, req.params.id]);
    const custody = await resolveCustody(req.params.id, conn);
    await recordMovement(conn, {
      assetId: req.params.id,
      movementType: 'status_change',
      fromLocationId: custody.location_id,
      fromCustodianEmployeeId: custody.custodian_employee_id,
      toLocationId: custody.location_id,
      toCustodianEmployeeId: custody.custodian_employee_id,
      remarks: `Status ${existing.status} -> ${status}${remarks ? `: ${remarks}` : ''}`,
      userId: req.user.id,
    });
    await logAudit(conn, { assetId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: existing.status, newValue: status });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Deleting is for a mis-keyed row, not for equipment leaving the company -- that is a status of
// retired or disposed, which keeps the history. So anything with a real past is refused.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const assetId = req.params.id;
    const kids = await descendantIds(assetId, conn);
    if (kids.length) return res.status(409).json({ error: 'Detach the assets attached to this one first.' });
    const [[onTransfer]] = await conn.query('SELECT id FROM asset_transfer_lines WHERE asset_id = ? LIMIT 1', [assetId]);
    if (onTransfer) return res.status(409).json({ error: 'This asset appears on a transfer, so it cannot be deleted. Set its status to Retired or Disposed instead.' });
    const [[counted]] = await conn.query('SELECT id FROM asset_audit_lines WHERE asset_id = ? LIMIT 1', [assetId]);
    if (counted) return res.status(409).json({ error: 'This asset has been counted on an audit, so it cannot be deleted. Set its status to Retired or Disposed instead.' });

    await conn.beginTransaction();
    await conn.query('DELETE FROM asset_movements WHERE asset_id = ?', [assetId]);
    await conn.query('DELETE FROM assets WHERE id = ?', [assetId]);
    await logAudit(conn, { assetId, userId: req.user.id, eventType: 'Deleted' });
    await conn.commit();
    res.status(204).send();
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
