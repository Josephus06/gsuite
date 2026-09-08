const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { capitalizedCost, accumulatedDepreciation, money } = require('../lib/fixedAssets');
const { resolveCustody, recordMovement, descendantIds } = require('../lib/assetCustody');

const router = express.Router();

// Asset disposals (ADP-####): the end of the lifecycle, whether sold, scrapped, donated or written
// off. One entry does three things at once -- removes the asset's cost, removes the accumulated
// depreciation that was standing against it, and recognises whatever the proceeds did not cover:
//
//   Dr  Accumulated Depreciation      (everything taken to date)
//   Dr  Cash / Receivable             (proceeds, if sold)
//   Cr  Fixed Asset - cost            (full capitalised cost)
//   Dr/Cr Gain or Loss on Sale        (the balancing figure)
//
// Cost and accumulated depreciation are FROZEN onto the document when it posts. They are derived
// figures everywhere else in this module, but the entry has to remove exactly the amounts it said
// it would -- a later cost line or voided depreciation run must not silently restate a posted
// disposal.
//
// Posting also retires the asset in the custody register and writes a movement, so a disposed asset
// stops appearing on audit sheets and transfer pickers.
const ROUTE = '/asset-disposals';

const DISPOSAL_TYPES = new Set(['sale', 'scrap', 'donation', 'write_off']);
const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const idOrNull = (v) => (v == null || v === '' ? null : v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function logAudit(conn, { disposalId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('AssetDisposal', ?, ?, ?, ?, ?, ?)`,
    [disposalId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId],
  );
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[settings]] = await pool.query('SELECT gain_loss_account_id FROM asset_settings WHERE id = 1');
    const [cashAccounts] = await pool.query(
      "SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_type = 'Asset' ORDER BY account_code",
    );
    const [allAccounts] = await pool.query('SELECT id, account_code, account_name, account_type FROM chart_of_accounts ORDER BY account_code');
    res.json({
      disposal_types: [...DISPOSAL_TYPES],
      cash_accounts: cashAccounts,
      all_accounts: allAccounts,
      defaults: { gain_loss_account_id: settings?.gain_loss_account_id || null },
    });
  } catch (err) { next(err); }
});

// Assets that can still be disposed of, with what disposing of them would cost and realise.
router.get('/disposable-assets', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const params = [];
    let searchSql = '';
    if (search) {
      searchSql = 'AND (a.reference_no LIKE ? OR a.serial_no LIKE ? OR ai.display_name LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const [rows] = await pool.query(
      `SELECT a.id, a.reference_no, a.serial_no, a.is_capitalized, ai.display_name AS item_name,
              c.name AS class_name, c.id AS asset_class_id,
              loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name,
              (SELECT COALESCE(SUM(cl.amount), 0) FROM asset_cost_lines cl WHERE cl.asset_id = a.id) AS capitalized_cost,
              (SELECT COALESCE(SUM(l.amount), 0) FROM asset_depreciation_lines l
                 JOIN asset_depreciation_runs r ON r.id = l.run_id
                WHERE l.asset_id = a.id AND r.status = 'posted') AS accumulated_depreciation
         FROM assets a
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN asset_classes c ON c.id = a.asset_class_id
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         LEFT JOIN locations loc ON loc.id = CASE WHEN a.parent_asset_id IS NULL THEN a.location_id ELSE p.location_id END
         LEFT JOIN employees e ON e.id = CASE WHEN a.parent_asset_id IS NULL THEN a.custodian_employee_id ELSE p.custodian_employee_id END
        WHERE a.status <> 'disposed'
          AND NOT EXISTS (SELECT 1 FROM asset_disposals d WHERE d.asset_id = a.id AND d.status IN ('draft', 'posted'))
          ${searchSql}
        ORDER BY ai.display_name, a.reference_no
        LIMIT 500`,
      params,
    );
    res.json(rows.map((r) => ({
      ...r,
      capitalized_cost: money(r.capitalized_cost),
      accumulated_depreciation: money(r.accumulated_depreciation),
      net_book_value: money(Number(r.capitalized_cost) - Number(r.accumulated_depreciation)),
    })));
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { status, disposal_type: type, search } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));
    const where = [];
    const params = [];
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (type) { where.push('d.disposal_type = ?'); params.push(type); }
    if (search) {
      where.push('(d.disposal_no LIKE ? OR a.reference_no LIKE ? OR d.buyer_name LIKE ? OR d.reason LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM asset_disposals d
                     JOIN assets a ON a.id = d.asset_id
                     LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
                     ${whereSql}`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${fromSql}`, params);
    const [rows] = await pool.query(
      `SELECT d.id, d.disposal_no, d.disposal_date, d.disposal_type, d.proceeds, d.cost_at_disposal,
              d.accumulated_at_disposal, d.net_book_value, d.gain_loss, d.status, d.buyer_name,
              a.reference_no, ai.display_name AS item_name
       ${fromSql} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query(
      `SELECT d.*, a.reference_no, a.serial_no, ai.display_name AS item_name, c.name AS class_name,
              ca.account_code AS cost_account_code, ca.account_name AS cost_account_name,
              aa.account_code AS accumulated_account_code, aa.account_name AS accumulated_account_name,
              ga.account_code AS gain_loss_account_code, ga.account_name AS gain_loss_account_name,
              pa.account_code AS proceeds_account_code, pa.account_name AS proceeds_account_name,
              cu.display_name AS created_by_name, pu.display_name AS posted_by_name, vu.display_name AS voided_by_name
         FROM asset_disposals d
         JOIN assets a ON a.id = d.asset_id
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN asset_classes c ON c.id = a.asset_class_id
         LEFT JOIN chart_of_accounts ca ON ca.id = d.cost_account_id
         LEFT JOIN chart_of_accounts aa ON aa.id = d.accumulated_account_id
         LEFT JOIN chart_of_accounts ga ON ga.id = d.gain_loss_account_id
         LEFT JOIN chart_of_accounts pa ON pa.id = d.proceeds_account_id
         LEFT JOIN users cu ON cu.id = d.created_by_user_id
         LEFT JOIN users pu ON pu.id = d.posted_by_user_id
         LEFT JOIN users vu ON vu.id = d.voided_by_user_id
        WHERE d.id = ?`,
      [req.params.id],
    );
    if (!d) return res.status(404).json({ error: 'Not found' });

    // A draft shows LIVE figures (they can still change before posting); a posted one shows what
    // was frozen onto it. Presenting a draft's stale snapshot would mislead the person approving it.
    if (d.status === 'draft') {
      const cost = await capitalizedCost(d.asset_id);
      const accumulated = await accumulatedDepreciation(d.asset_id);
      d.cost_at_disposal = cost;
      d.accumulated_at_disposal = accumulated;
      d.net_book_value = money(cost - accumulated);
      d.gain_loss = money(Number(d.proceeds) - d.net_book_value);
    }
    res.json(d);
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'AssetDisposal' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

async function validateDisposal(conn, b, { disposalId = null } = {}) {
  if (!b.asset_id) return 'An asset is required.';
  if (!b.disposal_date) return 'A disposal date is required.';
  if (b.disposal_type && !DISPOSAL_TYPES.has(b.disposal_type)) return `Unknown disposal type: ${b.disposal_type}`;
  if (num(b.proceeds) < 0) return 'Proceeds cannot be negative.';
  if (b.disposal_type === 'sale' && num(b.proceeds) > 0 && !b.proceeds_account_id) {
    return 'A sale with proceeds needs the account the money went into.';
  }

  const [[asset]] = await conn.query('SELECT id, status, reference_no, is_capitalized, asset_class_id FROM assets WHERE id = ?', [b.asset_id]);
  if (!asset) return 'Asset not found.';
  if (asset.status === 'disposed') return `${asset.reference_no} is already disposed.`;

  const [[open]] = await conn.query(
    "SELECT disposal_no FROM asset_disposals WHERE asset_id = ? AND status IN ('draft','posted') AND id <> ? LIMIT 1",
    [b.asset_id, disposalId || 0],
  );
  if (open) return `${asset.reference_no} is already on disposal ${open.disposal_no}.`;

  // Attached units have no cost of their own to remove and would be orphaned by their host leaving.
  const kids = await descendantIds(b.asset_id, conn);
  if (kids.length) return 'Detach the assets attached to this one before disposing of it.';
  return null;
}

// Resolves the three accounts a disposal posts to, from the asset's class and the settings default.
async function resolveAccounts(conn, assetId, body) {
  const [[cls]] = await conn.query(
    `SELECT c.cost_account_id, c.accumulated_depreciation_account_id
       FROM assets a JOIN asset_classes c ON c.id = a.asset_class_id WHERE a.id = ?`,
    [assetId],
  );
  const [[settings]] = await conn.query('SELECT gain_loss_account_id FROM asset_settings WHERE id = 1');
  return {
    cost_account_id: cls?.cost_account_id || null,
    accumulated_account_id: cls?.accumulated_depreciation_account_id || null,
    gain_loss_account_id: idOrNull(body.gain_loss_account_id) || settings?.gain_loss_account_id || null,
  };
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const problem = await validateDisposal(conn, b);
    if (problem) return res.status(400).json({ error: problem });
    await assertPeriodOpen(b.disposal_date, 'other_gl', conn);

    const accounts = await resolveAccounts(conn, b.asset_id, b);
    const cost = await capitalizedCost(b.asset_id, conn);
    const accumulated = await accumulatedDepreciation(b.asset_id, { conn });
    const nbv = money(cost - accumulated);
    const gainLoss = money(num(b.proceeds) - nbv);

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO asset_disposals
         (disposal_no, asset_id, disposal_date, disposal_type, proceeds, proceeds_account_id,
          cost_at_disposal, accumulated_at_disposal, net_book_value, gain_loss, gain_loss_account_id,
          cost_account_id, accumulated_account_id, buyer_name, reason, memo, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      [b.asset_id, b.disposal_date, b.disposal_type || 'sale', num(b.proceeds), idOrNull(b.proceeds_account_id),
        cost, accumulated, nbv, gainLoss, accounts.gain_loss_account_id, accounts.cost_account_id,
        accounts.accumulated_account_id, trunc(b.buyer_name, 255), trunc(b.reason, 500), trunc(b.memo, 1000), req.user.id],
    );
    const disposalId = r.insertId;
    const disposalNo = `ADP-${disposalId}`;
    await conn.query('UPDATE asset_disposals SET disposal_no = ? WHERE id = ?', [disposalNo, disposalId]);
    await logAudit(conn, { disposalId, userId: req.user.id, eventType: 'Created', fieldName: 'disposal_no', newValue: disposalNo });
    await conn.commit();
    res.status(201).json({ id: disposalId, disposal_no: disposalNo, net_book_value: nbv, gain_loss: gainLoss });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const [[d]] = await conn.query('SELECT * FROM asset_disposals WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status !== 'draft') return res.status(409).json({ error: 'Only a draft disposal can be edited.' });
    const problem = await validateDisposal(conn, { ...b, asset_id: b.asset_id || d.asset_id }, { disposalId: d.id });
    if (problem) return res.status(400).json({ error: problem });
    await assertPeriodOpen([d.disposal_date, b.disposal_date], 'other_gl', conn);

    const assetId = b.asset_id || d.asset_id;
    const accounts = await resolveAccounts(conn, assetId, b);
    const cost = await capitalizedCost(assetId, conn);
    const accumulated = await accumulatedDepreciation(assetId, { conn });
    const nbv = money(cost - accumulated);
    const gainLoss = money(num(b.proceeds) - nbv);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE asset_disposals SET asset_id = ?, disposal_date = ?, disposal_type = ?, proceeds = ?, proceeds_account_id = ?,
              cost_at_disposal = ?, accumulated_at_disposal = ?, net_book_value = ?, gain_loss = ?, gain_loss_account_id = ?,
              cost_account_id = ?, accumulated_account_id = ?, buyer_name = ?, reason = ?, memo = ?
        WHERE id = ?`,
      [assetId, b.disposal_date, b.disposal_type || 'sale', num(b.proceeds), idOrNull(b.proceeds_account_id),
        cost, accumulated, nbv, gainLoss, accounts.gain_loss_account_id, accounts.cost_account_id,
        accounts.accumulated_account_id, trunc(b.buyer_name, 255), trunc(b.reason, 500), trunc(b.memo, 1000), req.params.id],
    );
    await logAudit(conn, { disposalId: d.id, userId: req.user.id, eventType: 'Updated' });
    await conn.commit();
    res.json({ ok: true, net_book_value: nbv, gain_loss: gainLoss });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.post('/:id/post', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[d]] = await conn.query('SELECT * FROM asset_disposals WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status !== 'draft') return res.status(409).json({ error: `This disposal is already ${d.status}.` });
    await assertPeriodOpen(d.disposal_date, 'other_gl', conn);

    const [[asset]] = await conn.query('SELECT id, reference_no, is_capitalized, asset_class_id FROM assets WHERE id = ?', [d.asset_id]);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });

    // A capitalised asset has to know which accounts to relieve, or the entry cannot balance.
    if (asset.is_capitalized) {
      if (!d.cost_account_id || !d.accumulated_account_id) {
        return res.status(400).json({ error: 'This asset\'s class is missing its cost or accumulated depreciation account, so the disposal cannot post.' });
      }
      if (!d.gain_loss_account_id) return res.status(400).json({ error: 'A gain/loss account is required to post a disposal.' });
    }

    await conn.beginTransaction();
    // Freeze the figures as at posting. Everything derived is re-read one last time here, and from
    // this moment the document reports these numbers and not the live ones.
    const cost = await capitalizedCost(d.asset_id, conn);
    const accumulated = await accumulatedDepreciation(d.asset_id, { conn });
    const nbv = money(cost - accumulated);
    const gainLoss = money(Number(d.proceeds) - nbv);

    await conn.query(
      `UPDATE asset_disposals SET status = 'posted', cost_at_disposal = ?, accumulated_at_disposal = ?,
              net_book_value = ?, gain_loss = ?, posted_by_user_id = ?, posted_at = NOW() WHERE id = ?`,
      [cost, accumulated, nbv, gainLoss, req.user.id, d.id],
    );

    // Retire it in the custody register too, so it leaves audit sheets and transfer pickers.
    const before = await resolveCustody(d.asset_id, conn);
    await conn.query("UPDATE assets SET status = 'disposed', updated_at = NOW() WHERE id = ?", [d.asset_id]);
    await recordMovement(conn, {
      assetId: d.asset_id,
      movementType: 'disposed',
      fromLocationId: before.location_id,
      fromCustodianEmployeeId: before.custodian_employee_id,
      toLocationId: null,
      toCustodianEmployeeId: null,
      remarks: `Disposed by ${d.disposal_no} (${d.disposal_type})`,
      userId: req.user.id,
    });
    await logAudit(conn, { disposalId: d.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: 'draft', newValue: 'posted' });
    await conn.commit();
    res.json({ ok: true, status: 'posted', net_book_value: nbv, gain_loss: gainLoss });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.post('/:id/void', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const reason = req.body?.reason;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required to void a posted disposal.' });
    const [[d]] = await conn.query('SELECT * FROM asset_disposals WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status !== 'posted') return res.status(409).json({ error: 'Only a posted disposal can be voided.' });
    await assertPeriodOpen(d.disposal_date, 'other_gl', conn);

    await conn.beginTransaction();
    await conn.query(
      "UPDATE asset_disposals SET status = 'voided', voided_by_user_id = ?, voided_at = NOW(), void_reason = ? WHERE id = ?",
      [req.user.id, trunc(reason, 500), d.id],
    );
    // Bring it back into service. Its location and custodian were never cleared -- only its status
    // changed -- so undoing the status is enough to restore custody exactly as it was.
    await conn.query("UPDATE assets SET status = 'active', updated_at = NOW() WHERE id = ?", [d.asset_id]);
    const custody = await resolveCustody(d.asset_id, conn);
    await recordMovement(conn, {
      assetId: d.asset_id,
      movementType: 'status_change',
      fromLocationId: custody.location_id,
      fromCustodianEmployeeId: custody.custodian_employee_id,
      toLocationId: custody.location_id,
      toCustodianEmployeeId: custody.custodian_employee_id,
      remarks: `Disposal ${d.disposal_no} voided: ${String(reason).trim()}`,
      userId: req.user.id,
    });
    await logAudit(conn, { disposalId: d.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'posted', newValue: 'voided' });
    await conn.commit();
    res.json({ ok: true, status: 'voided' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query('SELECT id, status FROM asset_disposals WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status !== 'draft') return res.status(409).json({ error: 'Only a draft disposal can be deleted. Void a posted one instead.' });
    await pool.query('DELETE FROM asset_disposals WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
