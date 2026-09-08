const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { resolveCustody, moveAsset, approverUserIdForEmployee, TRANSFERABLE_STATUSES } = require('../lib/assetCustody');
const { getAssetScope, visibilityClause, canActOnAsset } = require('../lib/assetDepartmentScope');

const router = express.Router();

// Asset Transfer (ATR-####): the only sanctioned way an asset changes hands.
//
// The point of the document is that neither side can move equipment on its own. IT raises the
// transfer, but it does not take effect until BOTH custodians have signed:
//
//   draft -> pending_release -> pending_receipt -> approved -> completed
//             (current holder     (receiving        (IT carries it
//              gives it up)        accepts it)       out, assets move)
//
// Sequential rather than parallel, so the receiving side is never asked to accept something the
// current holder has not yet agreed to part with. Either side may reject, which ends the document
// -- a rejected transfer is kept, not deleted, because "who refused this and why" is exactly what
// gets asked at month end.
//
// Assets move at COMPLETE, not at approval. Approval records consent; the equipment is physically
// carried afterwards, and the register should say it is still in the warehouse until it isn't.
const ROUTE = '/asset-transfers';

const OPEN_STATUSES = ['draft', 'pending_release', 'pending_receipt', 'approved'];
const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const idOrNull = (v) => (v == null || v === '' ? null : v);

async function logAudit(conn, { transferId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('AssetTransfer', ?, ?, ?, ?, ?, ?)`,
    [transferId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId],
  );
}

async function notify(conn, userId, { title, message, transferId }) {
  if (!userId) return;
  await conn.query(
    `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
     VALUES (?, 'asset_transfer', ?, ?, 'AssetTransfer', ?)`,
    [userId, trunc(title, 255), trunc(message, 500), transferId],
  );
}

// May this user sign for the custodian named on one side of the transfer?
//
// Custody is held by an EMPLOYEE because warehouse staff may have no login at all, but a signature
// needs a USER. So: the custodian's own account signs their side. Where that employee has no
// account -- or no custodian was named, as when equipment is moving to a location rather than to a
// named person -- it falls back to anyone holding can_approve, otherwise a transfer involving
// someone without a login could never be completed by anybody.
async function mayActFor(userId, employeeId) {
  if (!employeeId) return userCan(userId, ROUTE, 'can_approve');
  const linkedUserId = await approverUserIdForEmployee(employeeId);
  if (linkedUserId && String(linkedUserId) === String(userId)) return true;
  if (linkedUserId) {
    // The custodian does have an account, so it is theirs to sign -- with one exception: a System
    // Admin can always act, which is what stops a transfer being stuck forever behind someone who
    // has left the company. userCan() short-circuits true for System Admin and checks the
    // permission row for everyone else, so an ordinary approver still cannot sign in their place.
    const [[u]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
    return u?.account_type === 'System Admin';
  }
  return userCan(userId, ROUTE, 'can_approve');
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [locations] = await pool.query('SELECT id, location_code, location_name FROM locations WHERE is_active = TRUE ORDER BY location_name');
    const [employees] = await pool.query(
      `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, e.employee_code, e.department_id, d.name AS department_name,
              (SELECT u.id FROM users u WHERE u.employee_id = e.id AND u.is_active = TRUE ORDER BY u.id LIMIT 1) AS user_id
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.is_active = TRUE ORDER BY e.first_name, e.last_name`,
    );
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    res.json({ locations, employees, departments, defaults: { requestor_employee_id: me?.employee_id || null } });
  } catch (err) { next(err); }
});

// The asset picker for the transfer form. Only things that can actually be handed over: in a
// transferable status, and not already named on a transfer that is still running -- otherwise two
// documents could each promise the same UPS to a different office.
router.get('/available-assets', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { location_id: locationId, custodian_employee_id: custodianId, search } = req.query;
    const effLocation = 'CASE WHEN a.parent_asset_id IS NULL THEN a.location_id ELSE p.location_id END';
    const effCustodian = 'CASE WHEN a.parent_asset_id IS NULL THEN a.custodian_employee_id ELSE p.custodian_employee_id END';

    const where = [`a.status IN (${[...TRANSFERABLE_STATUSES].map(() => '?').join(', ')})`];
    const params = [...TRANSFERABLE_STATUSES];
    if (locationId) { where.push(`${effLocation} = ?`); params.push(locationId); }
    if (custodianId) { where.push(`${effCustodian} = ?`); params.push(custodianId); }
    if (search) {
      where.push('(a.reference_no LIKE ? OR a.serial_no LIKE ? OR ai.display_name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    where.push(`NOT EXISTS (SELECT 1 FROM asset_transfer_lines l JOIN asset_transfers t ON t.id = l.transfer_id
                             WHERE l.asset_id = a.id AND t.status IN (${OPEN_STATUSES.map(() => '?').join(', ')}))`);
    params.push(...OPEN_STATUSES);

    // Department scoping: you can only move equipment your own department owns.
    const scope = await getAssetScope(req.user.id);
    if (!scope.unrestricted && !scope.isHead) return res.json([]);
    const vis = visibilityClause(scope);
    if (vis.sql) { where.push(vis.sql); params.push(...vis.params); }

    const [rows] = await pool.query(
      `SELECT a.id, a.reference_no, a.serial_no, a.status, a.parent_asset_id,
              ai.display_name AS item_name, ai.category,
              COALESCE(a.brand, ai.brand) AS brand, COALESCE(a.model, ai.model) AS model,
              p.reference_no AS parent_reference_no,
              ${effLocation} AS location_id, ${effCustodian} AS custodian_employee_id,
              loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name,
              (SELECT COUNT(*) FROM assets c WHERE c.parent_asset_id = a.id) AS attached_count
         FROM assets a
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN locations loc ON loc.id = ${effLocation}
         LEFT JOIN employees e ON e.id = ${effCustodian}
        WHERE ${where.join(' AND ')}
        ORDER BY ai.display_name, a.reference_no
        LIMIT 500`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, from_location_id: fromLoc, to_location_id: toLoc, awaiting_me: awaitingMe } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));

    const where = [];
    const params = [];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (fromLoc) { where.push('t.from_location_id = ?'); params.push(fromLoc); }
    if (toLoc) { where.push('t.to_location_id = ?'); params.push(toLoc); }
    if (search) {
      where.push('(t.transfer_no LIKE ? OR t.reason LIKE ? OR t.memo LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    // "Waiting on me": the transfers where this user is the custodian whose signature the document
    // is currently stopped on. Drives the badge on the list page, so an approval is not something
    // people have to be told about out-of-band.
    if (awaitingMe === 'yes') {
      const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
      const employeeId = me?.employee_id || 0;
      where.push(`((t.status = 'pending_release' AND t.from_custodian_employee_id = ?)
                OR (t.status = 'pending_receipt' AND t.to_custodian_employee_id = ?))`);
      params.push(employeeId, employeeId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const fromSql = `
      FROM asset_transfers t
      LEFT JOIN locations fl ON fl.id = t.from_location_id
      LEFT JOIN locations tl ON tl.id = t.to_location_id
      LEFT JOIN employees fe ON fe.id = t.from_custodian_employee_id
      LEFT JOIN employees te ON te.id = t.to_custodian_employee_id
      ${whereSql}`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${fromSql}`, params);
    const [rows] = await pool.query(
      `SELECT t.id, t.transfer_no, t.date_created, t.date_needed, t.status, t.reason,
              fl.location_name AS from_location_name, tl.location_name AS to_location_name,
              CONCAT(fe.first_name, ' ', fe.last_name) AS from_custodian_name,
              CONCAT(te.first_name, ' ', te.last_name) AS to_custodian_name,
              (SELECT COUNT(*) FROM asset_transfer_lines l WHERE l.transfer_id = t.id) AS asset_count
       ${fromSql} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

async function loadTransfer(id) {
  const [[t]] = await pool.query(
    `SELECT t.*, fl.location_name AS from_location_name, tl.location_name AS to_location_name,
            CONCAT(fe.first_name, ' ', fe.last_name) AS from_custodian_name,
            CONCAT(te.first_name, ' ', te.last_name) AS to_custodian_name,
            d.name AS to_department_name,
            ru.display_name AS requested_by_name, relu.display_name AS released_by_name,
            recu.display_name AS received_by_name, cu.display_name AS completed_by_name,
            rju.display_name AS rejected_by_name
       FROM asset_transfers t
       LEFT JOIN locations fl ON fl.id = t.from_location_id
       LEFT JOIN locations tl ON tl.id = t.to_location_id
       LEFT JOIN employees fe ON fe.id = t.from_custodian_employee_id
       LEFT JOIN employees te ON te.id = t.to_custodian_employee_id
       LEFT JOIN departments d ON d.id = t.to_department_id
       LEFT JOIN users ru ON ru.id = t.requested_by_user_id
       LEFT JOIN users relu ON relu.id = t.released_by_user_id
       LEFT JOIN users recu ON recu.id = t.received_by_user_id
       LEFT JOIN users cu ON cu.id = t.completed_by_user_id
       LEFT JOIN users rju ON rju.id = t.rejected_by_user_id
      WHERE t.id = ?`,
    [id],
  );
  if (!t) return null;
  const [lines] = await pool.query(
    `SELECT l.*, a.reference_no, a.serial_no, a.status AS asset_status, a.parent_asset_id,
            ai.display_name AS item_name, ai.category,
            COALESCE(a.brand, ai.brand) AS brand, COALESCE(a.model, ai.model) AS model,
            fl.location_name AS from_location_name,
            CONCAT(fe.first_name, ' ', fe.last_name) AS from_custodian_name,
            (SELECT COUNT(*) FROM assets c WHERE c.parent_asset_id = a.id) AS attached_count
       FROM asset_transfer_lines l
       JOIN assets a ON a.id = l.asset_id
       LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
       LEFT JOIN locations fl ON fl.id = l.from_location_id
       LEFT JOIN employees fe ON fe.id = l.from_custodian_employee_id
      WHERE l.transfer_id = ? ORDER BY l.line_no`,
    [id],
  );
  return { ...t, lines };
}

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const t = await loadTransfer(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    // What THIS user is allowed to do, decided server-side and handed to the client. The client
    // must not re-derive it from account type, or the buttons and the API will drift apart.
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    res.json({
      ...t,
      my_actions: {
        can_release: t.status === 'pending_release' && await mayActFor(req.user.id, t.from_custodian_employee_id),
        can_receive: t.status === 'pending_receipt' && await mayActFor(req.user.id, t.to_custodian_employee_id),
        my_employee_id: me?.employee_id || null,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'AssetTransfer' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Writes the lines and snapshots where each asset is standing right now. The snapshot is what the
// releasing custodian is shown when they sign, so it must be captured at request time and never
// recomputed -- otherwise the document silently rewrites what somebody already agreed to.
// Every asset named on a transfer is re-checked against the caller's department here, not just
// filtered out of the picker. The picker is a convenience; this is the control -- a request can
// name any asset id it likes.
async function assertMayMoveAssets(conn, userId, lines) {
  for (const l of (Array.isArray(lines) ? lines : [])) {
    if (!l.asset_id) continue;
    const { allowed, reason } = await canActOnAsset(userId, l.asset_id, conn);
    if (!allowed) {
      const [[a]] = await conn.query('SELECT reference_no FROM assets WHERE id = ?', [l.asset_id]);
      const err = new Error(`${a?.reference_no || 'That asset'}: ${reason}`);
      err.status = 403;
      throw err;
    }
  }
}

async function writeLines(conn, transferId, lines) {
  await conn.query('DELETE FROM asset_transfer_lines WHERE transfer_id = ?', [transferId]);
  const seen = new Set();
  let lineNo = 0;
  for (const l of (Array.isArray(lines) ? lines : [])) {
    if (!l.asset_id || seen.has(String(l.asset_id))) continue;
    seen.add(String(l.asset_id));
    const custody = await resolveCustody(l.asset_id, conn);
    lineNo += 1;
    await conn.query(
      `INSERT INTO asset_transfer_lines (transfer_id, line_no, asset_id, from_location_id, from_custodian_employee_id, remarks)
       VALUES (?,?,?,?,?,?)`,
      [transferId, lineNo, l.asset_id, custody.location_id, custody.custodian_employee_id, trunc(l.remarks, 500)],
    );
  }
  return lineNo;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    if (!b.to_location_id) return res.status(400).json({ error: 'A destination location is required.' });

    await assertMayMoveAssets(conn, req.user.id, b.lines);

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO asset_transfers (transfer_no, date_created, date_needed, from_location_id, from_custodian_employee_id,
                                    to_location_id, to_custodian_employee_id, to_department_id, reason, memo, status, requested_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      [b.date_created || new Date().toISOString().slice(0, 10), b.date_needed || null,
        idOrNull(b.from_location_id), idOrNull(b.from_custodian_employee_id),
        b.to_location_id, idOrNull(b.to_custodian_employee_id), idOrNull(b.to_department_id),
        trunc(b.reason, 500), trunc(b.memo, 1000), req.user.id],
    );
    const transferId = r.insertId;
    const transferNo = `ATR-${transferId}`;
    await conn.query('UPDATE asset_transfers SET transfer_no = ? WHERE id = ?', [transferNo, transferId]);
    await writeLines(conn, transferId, b.lines);
    await logAudit(conn, { transferId, userId: req.user.id, eventType: 'Created', fieldName: 'transfer_no', newValue: transferNo });
    await conn.commit();
    res.status(201).json({ id: transferId, transfer_no: transferNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const [[t]] = await conn.query('SELECT id, status FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    // Once it has been submitted it is out for signature. Editing it then would change what the
    // releasing custodian is being asked to agree to, after they have been asked.
    if (t.status !== 'draft') return res.status(409).json({ error: 'Only a draft transfer can be edited. Cancel it and raise a new one.' });
    if (!b.to_location_id) return res.status(400).json({ error: 'A destination location is required.' });
    await assertMayMoveAssets(conn, req.user.id, b.lines);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE asset_transfers SET date_created = ?, date_needed = ?, from_location_id = ?, from_custodian_employee_id = ?,
              to_location_id = ?, to_custodian_employee_id = ?, to_department_id = ?, reason = ?, memo = ?, updated_at = NOW()
        WHERE id = ?`,
      [b.date_created || new Date().toISOString().slice(0, 10), b.date_needed || null,
        idOrNull(b.from_location_id), idOrNull(b.from_custodian_employee_id),
        b.to_location_id, idOrNull(b.to_custodian_employee_id), idOrNull(b.to_department_id),
        trunc(b.reason, 500), trunc(b.memo, 1000), req.params.id],
    );
    await writeLines(conn, req.params.id, b.lines);
    await logAudit(conn, { transferId: req.params.id, userId: req.user.id, eventType: 'Updated' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Submitting sends it to the releasing custodian. Everything that has to be true about the assets
// is checked here rather than at completion, so a problem surfaces before two people have signed.
router.post('/:id/submit', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT * FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'draft') return res.status(409).json({ error: 'This transfer has already been submitted.' });

    const [lines] = await conn.query(
      `SELECT l.asset_id, l.from_location_id, a.reference_no, a.status
         FROM asset_transfer_lines l JOIN assets a ON a.id = l.asset_id WHERE l.transfer_id = ?`,
      [req.params.id],
    );
    if (!lines.length) return res.status(400).json({ error: 'Add at least one asset before submitting.' });

    for (const l of lines) {
      if (!TRANSFERABLE_STATUSES.has(l.status)) {
        return res.status(400).json({ error: `Asset ${l.reference_no} is ${l.status.replace('_', ' ')} and cannot be transferred.` });
      }
      const [[clash]] = await conn.query(
        `SELECT t2.transfer_no FROM asset_transfer_lines l2 JOIN asset_transfers t2 ON t2.id = l2.transfer_id
          WHERE l2.asset_id = ? AND t2.id <> ? AND t2.status IN (?) LIMIT 1`,
        [l.asset_id, req.params.id, OPEN_STATUSES],
      );
      if (clash) return res.status(409).json({ error: `Asset ${l.reference_no} is already on transfer ${clash.transfer_no}.` });
    }
    // A transfer that does not change anything is a paperwork error, not a move -- and it would
    // put two signatures against a no-op.
    if (t.from_location_id && String(t.from_location_id) === String(t.to_location_id)
      && String(t.from_custodian_employee_id ?? '') === String(t.to_custodian_employee_id ?? '')) {
      return res.status(400).json({ error: 'The destination is the same location and custodian as the source.' });
    }

    await conn.beginTransaction();
    await conn.query("UPDATE asset_transfers SET status = 'pending_release', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { transferId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: 'draft', newValue: 'pending_release' });
    await notify(conn, await approverUserIdForEmployee(t.from_custodian_employee_id, conn), {
      title: `Asset transfer ${t.transfer_no} needs your release`,
      message: `${lines.length} asset(s) are requested to move out of your custody.`,
      transferId: t.id,
    });
    await conn.commit();
    res.json({ ok: true, status: 'pending_release' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Step 1 of 2: the current holder agrees to give the equipment up.
router.post('/:id/release-approve', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT * FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'pending_release') return res.status(409).json({ error: 'This transfer is not waiting for a release approval.' });
    if (!(await mayActFor(req.user.id, t.from_custodian_employee_id))) {
      return res.status(403).json({ error: 'Only the releasing custodian can approve the release of these assets.' });
    }

    await conn.beginTransaction();
    await conn.query(
      "UPDATE asset_transfers SET status = 'pending_receipt', released_by_user_id = ?, released_at = NOW(), release_remarks = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, trunc(req.body?.remarks, 500), req.params.id],
    );
    await logAudit(conn, { transferId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'released_by_user_id', newValue: req.user.id });
    await notify(conn, await approverUserIdForEmployee(t.to_custodian_employee_id, conn), {
      title: `Asset transfer ${t.transfer_no} needs your acceptance`,
      message: 'The releasing custodian has approved. Confirm you are accepting these assets.',
      transferId: t.id,
    });
    await conn.commit();
    res.json({ ok: true, status: 'pending_receipt' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Step 2 of 2: the receiving custodian accepts responsibility. After this the document is approved
// but nothing has moved yet -- IT still has to complete it.
router.post('/:id/receipt-approve', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT * FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'pending_receipt') return res.status(409).json({ error: 'This transfer is not waiting for an acceptance.' });
    if (!(await mayActFor(req.user.id, t.to_custodian_employee_id))) {
      return res.status(403).json({ error: 'Only the receiving custodian can accept these assets.' });
    }
    // Two signatures from one person is one signature. The exception is a genuine same-custodian
    // move (their own equipment following them to another site), where there is only one person
    // to ask and demanding a second name would just invite someone to sign on their behalf.
    const sameCustodian = t.from_custodian_employee_id != null
      && String(t.from_custodian_employee_id) === String(t.to_custodian_employee_id);
    if (!sameCustodian && String(t.released_by_user_id) === String(req.user.id)) {
      return res.status(403).json({ error: 'The release was approved under your account, so the acceptance must be signed by the receiving custodian.' });
    }

    await conn.beginTransaction();
    await conn.query(
      "UPDATE asset_transfers SET status = 'approved', received_by_user_id = ?, received_at = NOW(), receipt_remarks = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, trunc(req.body?.remarks, 500), req.params.id],
    );
    await logAudit(conn, { transferId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'received_by_user_id', newValue: req.user.id });
    await notify(conn, t.requested_by_user_id, {
      title: `Asset transfer ${t.transfer_no} is fully approved`,
      message: 'Both custodians have signed. It can now be completed.',
      transferId: t.id,
    });
    await conn.commit();
    res.json({ ok: true, status: 'approved' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// IT carries out the move. This is the only place assets actually change location.
router.post('/:id/complete', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT * FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status !== 'approved') {
      return res.status(409).json({ error: 'Both custodians must approve before this transfer can be completed.' });
    }

    await conn.beginTransaction();
    // Re-read the lines FOR UPDATE. Between approval and completion an asset could have been
    // corrected or retired by someone else; moving it anyway would overwrite that silently, and
    // holding the row lock stops two people completing the same transfer at once.
    const [lines] = await conn.query(
      `SELECT l.asset_id, l.from_location_id, a.reference_no, a.status
         FROM asset_transfer_lines l JOIN assets a ON a.id = l.asset_id
        WHERE l.transfer_id = ? ORDER BY l.line_no FOR UPDATE`,
      [req.params.id],
    );
    if (!lines.length) { await conn.rollback(); return res.status(400).json({ error: 'This transfer has no assets on it.' }); }

    for (const l of lines) {
      if (!TRANSFERABLE_STATUSES.has(l.status)) {
        await conn.rollback();
        return res.status(409).json({ error: `Asset ${l.reference_no} is now ${l.status.replace('_', ' ')} and can no longer be transferred.` });
      }
    }

    for (const l of lines) {
      await moveAsset(conn, {
        assetId: l.asset_id,
        toLocationId: t.to_location_id,
        toCustodianEmployeeId: t.to_custodian_employee_id,
        toDepartmentId: t.to_department_id,
        movementType: 'transfer',
        transferId: t.id,
        remarks: `Transfer ${t.transfer_no}`,
        userId: req.user.id,
      });
    }

    await conn.query(
      "UPDATE asset_transfers SET status = 'completed', completed_by_user_id = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id],
    );
    await logAudit(conn, { transferId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: 'approved', newValue: 'completed' });
    for (const userId of new Set([t.requested_by_user_id, t.released_by_user_id, t.received_by_user_id].filter(Boolean))) {
      await notify(conn, userId, {
        title: `Asset transfer ${t.transfer_no} completed`,
        message: `${lines.length} asset(s) have been moved.`,
        transferId: t.id,
      });
    }
    await conn.commit();
    res.json({ ok: true, status: 'completed', moved: lines.length });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Either custodian may refuse. A reason is required: a rejection with no reason tells the next
// person nothing, and this document is read months later by people who were not in the room.
router.post('/:id/reject', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const reason = req.body?.reason;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required to reject a transfer.' });
    const [[t]] = await conn.query('SELECT * FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!['pending_release', 'pending_receipt'].includes(t.status)) {
      return res.status(409).json({ error: 'Only a transfer awaiting approval can be rejected.' });
    }
    const custodianId = t.status === 'pending_release' ? t.from_custodian_employee_id : t.to_custodian_employee_id;
    if (!(await mayActFor(req.user.id, custodianId))) {
      return res.status(403).json({ error: 'Only the custodian this transfer is waiting on can reject it.' });
    }

    await conn.beginTransaction();
    await conn.query(
      "UPDATE asset_transfers SET status = 'rejected', rejected_by_user_id = ?, rejected_at = NOW(), reject_reason = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, trunc(reason, 500), req.params.id],
    );
    await logAudit(conn, { transferId: req.params.id, userId: req.user.id, eventType: 'Disapproved', fieldName: 'status', oldValue: t.status, newValue: 'rejected' });
    await notify(conn, t.requested_by_user_id, {
      title: `Asset transfer ${t.transfer_no} was rejected`,
      message: trunc(String(reason).trim(), 500),
      transferId: t.id,
    });
    await conn.commit();
    res.json({ ok: true, status: 'rejected' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT id, status, transfer_no FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.status === 'completed') return res.status(409).json({ error: 'A completed transfer cannot be cancelled. Raise a transfer moving the assets back.' });
    if (['cancelled', 'rejected'].includes(t.status)) return res.status(409).json({ error: 'This transfer is already closed.' });

    await conn.beginTransaction();
    await conn.query("UPDATE asset_transfers SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { transferId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: t.status, newValue: 'cancelled' });
    await conn.commit();
    res.json({ ok: true, status: 'cancelled' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT id, status FROM asset_transfers WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    // Anything that has been out for signature is kept, whatever its outcome -- the record of who
    // was asked and what they said is the reason this module exists.
    if (t.status !== 'draft') return res.status(409).json({ error: 'Only a draft transfer can be deleted. Cancel it instead.' });
    await conn.beginTransaction();
    await conn.query('DELETE FROM asset_transfer_lines WHERE transfer_id = ?', [req.params.id]);
    await conn.query('DELETE FROM asset_transfers WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
