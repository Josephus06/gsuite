const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { resolveCustody, recordMovement, descendantIds } = require('../lib/assetCustody');

const router = express.Router();

// Month-end asset audit (AUD-####): the count sheet the audit team works from.
//
// Generating a sheet SNAPSHOTS what the register currently claims -- expected location and
// expected custodian, frozen onto each line. That freeze is the whole point: if the sheet read
// live from the register, a transfer completed halfway through the count would rewrite the
// expectation the auditor was checking against, and a discrepancy would quietly become a match.
//
// The auditor then marks each reference number Verified / Wrong Location / Not Found / Damaged.
// A wrong-location finding does NOT move the asset by itself -- an audit records what was seen,
// and correcting the register is a separate, deliberate act (and a separate permission), so a
// count can never be the thing that silently relocates equipment.
const ROUTE = '/asset-audits';

const RESULTS = new Set(['pending', 'verified', 'wrong_location', 'not_found', 'damaged']);
const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const idOrNull = (v) => (v == null || v === '' ? null : v);

const EFFECTIVE_LOCATION = 'CASE WHEN a.parent_asset_id IS NULL THEN a.location_id ELSE p.location_id END';
const EFFECTIVE_CUSTODIAN = 'CASE WHEN a.parent_asset_id IS NULL THEN a.custodian_employee_id ELSE p.custodian_employee_id END';

async function logAudit(conn, { auditId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('AssetAudit', ?, ?, ?, ?, ?, ?)`,
    [auditId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId],
  );
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [locations] = await pool.query('SELECT id, location_code, location_name FROM locations WHERE is_active = TRUE ORDER BY location_name');
    const [employees] = await pool.query(
      `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, e.employee_code
         FROM employees e WHERE e.is_active = TRUE ORDER BY e.first_name, e.last_name`,
    );
    res.json({ locations, employees, results: [...RESULTS] });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { status, location_id: locationId, period_month: periodMonth, search } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));

    const where = [];
    const params = [];
    if (status) { where.push('s.status = ?'); params.push(status); }
    if (locationId) { where.push('s.location_id = ?'); params.push(locationId); }
    if (periodMonth) { where.push('s.period_month = ?'); params.push(periodMonth); }
    if (search) { where.push('(s.audit_no LIKE ? OR s.memo LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM asset_audits s ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT s.id, s.audit_no, s.period_month, s.status, s.memo, s.created_at, s.completed_at,
              loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name,
              cu.display_name AS created_by_name,
              (SELECT COUNT(*) FROM asset_audit_lines l WHERE l.audit_id = s.id) AS line_count,
              (SELECT COUNT(*) FROM asset_audit_lines l WHERE l.audit_id = s.id AND l.result = 'pending') AS pending_count,
              (SELECT COUNT(*) FROM asset_audit_lines l WHERE l.audit_id = s.id AND l.result IN ('wrong_location','not_found','damaged')) AS exception_count
         FROM asset_audits s
         LEFT JOIN locations loc ON loc.id = s.location_id
         LEFT JOIN employees e ON e.id = s.custodian_employee_id
         LEFT JOIN users cu ON cu.id = s.created_by_user_id
         ${whereSql} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

// How many assets a sheet would cover, so the audit team can see the size of the count before
// committing to generating it.
router.get('/preview-count', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { location_id: locationId, custodian_employee_id: custodianId, include_attached: includeAttached } = req.query;
    const where = ["a.status IN ('active', 'for_repair')"];
    const params = [];
    if (locationId) { where.push(`${EFFECTIVE_LOCATION} = ?`); params.push(locationId); }
    if (custodianId) { where.push(`${EFFECTIVE_CUSTODIAN} = ?`); params.push(custodianId); }
    if (includeAttached !== 'yes') where.push('a.parent_asset_id IS NULL');
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS n FROM assets a LEFT JOIN assets p ON p.id = a.parent_asset_id WHERE ${where.join(' AND ')}`,
      params,
    );
    res.json({ count: row.n });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[s]] = await pool.query(
      `SELECT s.*, loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name,
              cu.display_name AS created_by_name, du.display_name AS completed_by_name
         FROM asset_audits s
         LEFT JOIN locations loc ON loc.id = s.location_id
         LEFT JOIN employees e ON e.id = s.custodian_employee_id
         LEFT JOIN users cu ON cu.id = s.created_by_user_id
         LEFT JOIN users du ON du.id = s.completed_by_user_id
        WHERE s.id = ?`,
      [req.params.id],
    );
    if (!s) return res.status(404).json({ error: 'Not found' });

    // current_* is read live and shown next to the frozen expected_*: that pair is what turns a
    // count into an audit, because it shows whether the register has moved under the sheet since
    // it was generated.
    const [lines] = await pool.query(
      `SELECT l.*, a.reference_no, a.serial_no, a.status AS asset_status, a.parent_asset_id,
              ai.display_name AS item_name, ai.category,
              COALESCE(a.brand, ai.brand) AS brand, COALESCE(a.model, ai.model) AS model,
              el.location_name AS expected_location_name,
              CONCAT(ee.first_name, ' ', ee.last_name) AS expected_custodian_name,
              fl.location_name AS found_location_name,
              CONCAT(fe.first_name, ' ', fe.last_name) AS found_custodian_name,
              vu.display_name AS verified_by_name,
              ${EFFECTIVE_LOCATION} AS current_location_id,
              cl.location_name AS current_location_name,
              CONCAT(ce.first_name, ' ', ce.last_name) AS current_custodian_name,
              pa.reference_no AS parent_reference_no
         FROM asset_audit_lines l
         JOIN assets a ON a.id = l.asset_id
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         LEFT JOIN assets pa ON pa.id = a.parent_asset_id
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN locations el ON el.id = l.expected_location_id
         LEFT JOIN employees ee ON ee.id = l.expected_custodian_employee_id
         LEFT JOIN locations fl ON fl.id = l.found_location_id
         LEFT JOIN employees fe ON fe.id = l.found_custodian_employee_id
         LEFT JOIN locations cl ON cl.id = ${EFFECTIVE_LOCATION}
         LEFT JOIN employees ce ON ce.id = ${EFFECTIVE_CUSTODIAN}
         LEFT JOIN users vu ON vu.id = l.verified_by_user_id
        WHERE l.audit_id = ? ORDER BY l.line_no`,
      [req.params.id],
    );

    const summary = { total: lines.length, pending: 0, verified: 0, wrong_location: 0, not_found: 0, damaged: 0 };
    for (const l of lines) if (summary[l.result] != null) summary[l.result] += 1;
    res.json({ ...s, lines, summary });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'AssetAudit' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Generate the sheet. Scope it to a location, a custodian, or neither (everything).
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    if (!b.period_month) return res.status(400).json({ error: 'An audit period (month) is required.' });
    // Normalised to the first of the month, so two sheets for the same period compare equal
    // however the client happened to send the date.
    const periodMonth = `${String(b.period_month).slice(0, 7)}-01`;

    const where = ["a.status IN ('active', 'for_repair')"];
    const params = [];
    if (b.location_id) { where.push(`${EFFECTIVE_LOCATION} = ?`); params.push(b.location_id); }
    if (b.custodian_employee_id) { where.push(`${EFFECTIVE_CUSTODIAN} = ?`); params.push(b.custodian_employee_id); }
    // Attached units are excluded by default: an auditor counting a desk sees one system unit, and
    // listing the RAM inside it as a separate line to physically find means opening the case. Opt
    // in when the count is meant to be that thorough.
    if (b.include_attached !== true && b.include_attached !== 'yes') where.push('a.parent_asset_id IS NULL');

    const [assets] = await conn.query(
      `SELECT a.id, ${EFFECTIVE_LOCATION} AS location_id, ${EFFECTIVE_CUSTODIAN} AS custodian_employee_id
         FROM assets a
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         JOIN asset_items ai ON ai.id = a.asset_item_id
        WHERE ${where.join(' AND ')}
        ORDER BY ai.display_name, a.reference_no`,
      params,
    );
    if (!assets.length) return res.status(400).json({ error: 'No assets match that scope, so there is nothing to count.' });

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO asset_audits (audit_no, period_month, location_id, custodian_employee_id, status, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, 'open', ?, ?)`,
      [periodMonth, idOrNull(b.location_id), idOrNull(b.custodian_employee_id), trunc(b.memo, 1000), req.user.id],
    );
    const auditId = r.insertId;
    const auditNo = `AUD-${auditId}`;
    await conn.query('UPDATE asset_audits SET audit_no = ? WHERE id = ?', [auditNo, auditId]);

    // One multi-row INSERT rather than a query per asset: a company-wide sheet is thousands of
    // lines, and that many round trips inside a transaction is how you hold a write lock for a
    // minute.
    const values = assets.map((a, i) => [auditId, i + 1, a.id, a.location_id, a.custodian_employee_id]);
    await conn.query(
      `INSERT INTO asset_audit_lines (audit_id, line_no, asset_id, expected_location_id, expected_custodian_employee_id)
       VALUES ?`,
      [values],
    );
    await logAudit(conn, { auditId, userId: req.user.id, eventType: 'Created', fieldName: 'audit_no', newValue: auditNo });
    await conn.commit();
    res.status(201).json({ id: auditId, audit_no: auditNo, line_count: assets.length });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Record what the auditor actually saw for one line.
router.put('/:id/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { result, found_location_id: foundLocationId, found_custodian_employee_id: foundCustodianId, remarks } = req.body;
    if (!RESULTS.has(result)) return res.status(400).json({ error: `Unknown result: ${result}` });

    const [[s]] = await pool.query('SELECT id, status FROM asset_audits WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status !== 'open') return res.status(409).json({ error: 'This audit is closed and can no longer be marked up.' });
    if (result === 'wrong_location' && !foundLocationId) {
      return res.status(400).json({ error: 'Marking an asset as being in the wrong location needs the location it was actually found in.' });
    }

    const [r] = await pool.query(
      `UPDATE asset_audit_lines
          SET result = ?, found_location_id = ?, found_custodian_employee_id = ?, remarks = ?,
              verified_by_user_id = ?, verified_at = NOW()
        WHERE id = ? AND audit_id = ?`,
      [result, idOrNull(foundLocationId), idOrNull(foundCustodianId), trunc(remarks, 500), req.user.id, req.params.lineId, req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Audit line not found.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Mark every still-pending line on the sheet as verified in one go. Offered because the common
// shape of a count is "everything was where it should be except these four", and clicking through
// two hundred matching lines to say so invites the auditor to stop reading them.
router.put('/:id/verify-remaining', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[s]] = await pool.query('SELECT id, status FROM asset_audits WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status !== 'open') return res.status(409).json({ error: 'This audit is closed.' });
    const [r] = await pool.query(
      `UPDATE asset_audit_lines SET result = 'verified', verified_by_user_id = ?, verified_at = NOW()
        WHERE audit_id = ? AND result = 'pending'`,
      [req.user.id, req.params.id],
    );
    res.json({ ok: true, verified: r.affectedRows });
  } catch (err) { next(err); }
});

// Push a wrong-location finding into the register. Deliberately separate from marking the line,
// gated on can_approve, and it writes an 'audit_correction' movement so the ledger shows the
// register was corrected by a count rather than by a transfer nobody can find.
router.post('/:id/lines/:lineId/apply-correction', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[line]] = await conn.query(
      'SELECT * FROM asset_audit_lines WHERE id = ? AND audit_id = ?',
      [req.params.lineId, req.params.id],
    );
    if (!line) return res.status(404).json({ error: 'Audit line not found.' });
    if (line.result !== 'wrong_location') return res.status(400).json({ error: 'Only a line marked as being in the wrong location can be applied.' });
    if (!line.found_location_id) return res.status(400).json({ error: 'This line has no found location to apply.' });

    const [[asset]] = await conn.query('SELECT id, parent_asset_id, reference_no FROM assets WHERE id = ?', [line.asset_id]);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    if (asset.parent_asset_id) {
      return res.status(400).json({ error: `${asset.reference_no} is attached to another asset, so correcting it means correcting or detaching its host.` });
    }

    await conn.beginTransaction();
    const before = await resolveCustody(asset.id, conn);
    await conn.query(
      'UPDATE assets SET location_id = ?, custodian_employee_id = ?, updated_at = NOW() WHERE id = ?',
      [line.found_location_id, line.found_custodian_employee_id, asset.id],
    );
    await recordMovement(conn, {
      assetId: asset.id,
      movementType: 'audit_correction',
      auditId: req.params.id,
      fromLocationId: before.location_id,
      fromCustodianEmployeeId: before.custodian_employee_id,
      toLocationId: line.found_location_id,
      toCustodianEmployeeId: line.found_custodian_employee_id,
      remarks: `Corrected by audit: ${line.remarks || 'found in a different location'}`,
      userId: req.user.id,
    });
    for (const childId of await descendantIds(asset.id, conn)) {
      await recordMovement(conn, {
        assetId: childId,
        movementType: 'carried',
        auditId: req.params.id,
        fromLocationId: before.location_id,
        fromCustodianEmployeeId: before.custodian_employee_id,
        toLocationId: line.found_location_id,
        toCustodianEmployeeId: line.found_custodian_employee_id,
        remarks: 'Moved with its host asset (audit correction)',
        userId: req.user.id,
      });
    }
    await logAudit(conn, { auditId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'applied_correction', oldValue: before.location_id, newValue: line.found_location_id });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/complete', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[s]] = await conn.query('SELECT id, status FROM asset_audits WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status !== 'open') return res.status(409).json({ error: 'This audit is already closed.' });
    const [[pending]] = await conn.query("SELECT COUNT(*) AS n FROM asset_audit_lines WHERE audit_id = ? AND result = 'pending'", [req.params.id]);
    if (pending.n > 0) return res.status(400).json({ error: `${pending.n} asset(s) have not been counted yet.` });

    await conn.beginTransaction();
    await conn.query("UPDATE asset_audits SET status = 'completed', completed_by_user_id = ?, completed_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { auditId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: 'open', newValue: 'completed' });
    await conn.commit();
    res.json({ ok: true, status: 'completed' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[s]] = await conn.query('SELECT id, status FROM asset_audits WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status !== 'open') return res.status(409).json({ error: 'This audit is already closed.' });
    await conn.beginTransaction();
    await conn.query("UPDATE asset_audits SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { auditId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'cancelled' });
    await conn.commit();
    res.json({ ok: true, status: 'cancelled' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
