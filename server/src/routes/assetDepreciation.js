const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { eligibleAssets, periodStart, money } = require('../lib/fixedAssets');

const router = express.Router();

// Monthly depreciation runs (DEP-####).
//
// A run is a DOCUMENT, not a calculation, because this ERP derives the general ledger from source
// documents rather than storing journal rows -- so for the Trial Balance to show depreciation there
// has to be something dated, numbered and postable to derive it from. See lib/glImpact.js.
//
// Draft -> posted. A draft can be recalculated and deleted freely; posting is what puts it in the
// ledger. Voiding reverses it by taking the run out of the ledger entirely, which is safe precisely
// because accumulated depreciation is summed from posted lines rather than stored on the asset.
//
// Two controls matter more than anything else here:
//   - one posted run per month, or every asset depreciates twice and nothing downstream notices
//   - runs go in period order, because each month's charge is computed from what earlier months
//     already took
const ROUTE = '/asset-depreciation';

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;

async function logAudit(conn, { runId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('AssetDepreciationRun', ?, ?, ?, ?, ?, ?)`,
    [runId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId],
  );
}

// The month a run covers is stored as its first day, and posted on its LAST day -- depreciation is
// the expense of a period that has finished, so dating it to the first would put September's charge
// in a period that had barely started.
function periodEndDate(period) {
  const d = new Date(`${periodStart(period)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[last]] = await pool.query("SELECT period_month FROM asset_depreciation_runs WHERE status = 'posted' ORDER BY period_month DESC LIMIT 1");
    const [open] = await pool.query("SELECT id, run_no, period_month FROM asset_depreciation_runs WHERE status = 'draft' ORDER BY period_month");
    // The month after the last posted one is what almost every run wants to be.
    let suggested = null;
    if (last?.period_month) {
      const d = new Date(`${periodStart(last.period_month)}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      suggested = d.toISOString().slice(0, 7);
    } else {
      suggested = new Date().toISOString().slice(0, 7);
    }
    res.json({ last_posted_period: last?.period_month || null, suggested_period: suggested, open_drafts: open });
  } catch (err) { next(err); }
});

// What a run for this period WOULD contain, without creating anything. Lets accounting see the
// charge before committing to a document.
router.get('/preview', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    if (!req.query.period_month) return res.status(400).json({ error: 'A period is required.' });
    const period = periodStart(req.query.period_month);
    const assets = await eligibleAssets(period);
    res.json({
      period_month: period,
      asset_count: assets.length,
      total_amount: money(assets.reduce((n, a) => n + a.amount, 0)),
      lines: assets,
    });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { status, period_month: periodMonth, search } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));
    const where = [];
    const params = [];
    if (status) { where.push('r.status = ?'); params.push(status); }
    if (periodMonth) { where.push('r.period_month = ?'); params.push(periodStart(periodMonth)); }
    if (search) { where.push('(r.run_no LIKE ? OR r.memo LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM asset_depreciation_runs r ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT r.*, cu.display_name AS created_by_name, pu.display_name AS posted_by_name
         FROM asset_depreciation_runs r
         LEFT JOIN users cu ON cu.id = r.created_by_user_id
         LEFT JOIN users pu ON pu.id = r.posted_by_user_id
         ${whereSql} ORDER BY r.period_month DESC, r.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[r]] = await pool.query(
      `SELECT r.*, cu.display_name AS created_by_name, pu.display_name AS posted_by_name, vu.display_name AS voided_by_name
         FROM asset_depreciation_runs r
         LEFT JOIN users cu ON cu.id = r.created_by_user_id
         LEFT JOIN users pu ON pu.id = r.posted_by_user_id
         LEFT JOIN users vu ON vu.id = r.voided_by_user_id
        WHERE r.id = ?`,
      [req.params.id],
    );
    if (!r) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT l.*, a.reference_no, ai.display_name AS item_name, c.name AS class_name
         FROM asset_depreciation_lines l
         JOIN assets a ON a.id = l.asset_id
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
         LEFT JOIN asset_classes c ON c.id = l.asset_class_id
        WHERE l.run_id = ? ORDER BY l.line_no`,
      [req.params.id],
    );
    // Grouped by the account pair each line posts to -- this is exactly the journal entry the run
    // produces, which is what someone reviewing it before posting actually wants to see.
    const byAccount = new Map();
    for (const l of lines) {
      const key = `${l.expense_account_code}|${l.accumulated_account_code}`;
      if (!byAccount.has(key)) {
        byAccount.set(key, { expense_account_code: l.expense_account_code, accumulated_account_code: l.accumulated_account_code, amount: 0, asset_count: 0 });
      }
      const g = byAccount.get(key);
      g.amount = money(g.amount + Number(l.amount));
      g.asset_count += 1;
    }
    res.json({ ...r, lines, summary: [...byAccount.values()] });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'AssetDepreciationRun' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Guards shared by create and recalculate.
async function assertPeriodUsable(conn, period, { excludeRunId = null } = {}) {
  const [[clash]] = await conn.query(
    `SELECT run_no, status FROM asset_depreciation_runs
      WHERE period_month = ? AND status <> 'voided' AND id <> ? LIMIT 1`,
    [period, excludeRunId || 0],
  );
  if (clash) return `${clash.run_no} already covers ${String(period).slice(0, 7)} (${clash.status}). Void it before running that month again.`;

  const [[later]] = await conn.query(
    "SELECT run_no, period_month FROM asset_depreciation_runs WHERE status = 'posted' AND period_month >= ? ORDER BY period_month DESC LIMIT 1",
    [period],
  );
  if (later) return `${later.run_no} has already posted ${String(later.period_month).slice(0, 7)}. Depreciation must run in period order.`;
  return null;
}

async function writeRunLines(conn, runId, assets) {
  await conn.query('DELETE FROM asset_depreciation_lines WHERE run_id = ?', [runId]);
  let lineNo = 0;
  let total = 0;
  for (const a of assets) {
    lineNo += 1;
    total = money(total + a.amount);
    await conn.query(
      `INSERT INTO asset_depreciation_lines
         (run_id, line_no, asset_id, asset_class_id, depreciable_base, opening_accumulated, amount,
          closing_accumulated, remaining_life_months, expense_account_id, expense_account_code,
          accumulated_account_id, accumulated_account_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [runId, lineNo, a.id, a.asset_class_id, a.depreciable_base, a.opening_accumulated, a.amount,
        a.closing_accumulated, a.remaining_life_months, a.depreciation_expense_account_id, a.expense_account_code,
        a.accumulated_depreciation_account_id, a.accumulated_account_code],
    );
  }
  await conn.query('UPDATE asset_depreciation_runs SET total_amount = ?, asset_count = ? WHERE id = ?', [total, lineNo, runId]);
  return { total, count: lineNo };
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    if (!req.body?.period_month) return res.status(400).json({ error: 'A period is required.' });
    const period = periodStart(req.body.period_month);
    await assertPeriodOpen(periodEndDate(period), 'other_gl', conn);

    const problem = await assertPeriodUsable(conn, period);
    if (problem) return res.status(409).json({ error: problem });

    const assets = await eligibleAssets(period, conn);
    if (!assets.length) return res.status(400).json({ error: `No assets are due depreciation for ${String(period).slice(0, 7)}.` });

    await conn.beginTransaction();
    const [r] = await conn.query(
      "INSERT INTO asset_depreciation_runs (run_no, period_month, status, memo, created_by_user_id) VALUES ('', ?, 'draft', ?, ?)",
      [period, trunc(req.body.memo, 1000), req.user.id],
    );
    const runId = r.insertId;
    const runNo = `DEP-${runId}`;
    await conn.query('UPDATE asset_depreciation_runs SET run_no = ? WHERE id = ?', [runNo, runId]);
    const { total, count } = await writeRunLines(conn, runId, assets);
    await logAudit(conn, { runId, userId: req.user.id, eventType: 'Created', fieldName: 'run_no', newValue: runNo });
    await conn.commit();
    res.status(201).json({ id: runId, run_no: runNo, total_amount: total, asset_count: count });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Recompute a draft against the register as it stands now -- an asset capitalised or a cost line
// added after the draft was created should be picked up without losing the document.
router.post('/:id/recalculate', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[run]] = await conn.query('SELECT * FROM asset_depreciation_runs WHERE id = ?', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (run.status !== 'draft') return res.status(409).json({ error: 'Only a draft run can be recalculated.' });

    const assets = await eligibleAssets(run.period_month, conn);
    await conn.beginTransaction();
    const { total, count } = await writeRunLines(conn, run.id, assets);
    await logAudit(conn, { runId: run.id, userId: req.user.id, eventType: 'Updated', fieldName: 'total_amount', oldValue: run.total_amount, newValue: total });
    await conn.commit();
    res.json({ ok: true, total_amount: total, asset_count: count });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.post('/:id/post', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[run]] = await conn.query('SELECT * FROM asset_depreciation_runs WHERE id = ?', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (run.status !== 'draft') return res.status(409).json({ error: `This run is already ${run.status}.` });
    await assertPeriodOpen(periodEndDate(run.period_month), 'other_gl', conn);

    // Re-checked at posting, not just at creation: another run for the same month could have been
    // created and posted while this draft sat waiting for review.
    const problem = await assertPeriodUsable(conn, run.period_month, { excludeRunId: run.id });
    if (problem) return res.status(409).json({ error: problem });

    const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM asset_depreciation_lines WHERE run_id = ?', [run.id]);
    if (!n) return res.status(400).json({ error: 'This run has no lines to post.' });

    await conn.beginTransaction();
    await conn.query("UPDATE asset_depreciation_runs SET status = 'posted', posted_by_user_id = ?, posted_at = NOW() WHERE id = ?", [req.user.id, run.id]);
    await logAudit(conn, { runId: run.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', oldValue: 'draft', newValue: 'posted' });
    await conn.commit();
    res.json({ ok: true, status: 'posted' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Voiding takes the run out of the ledger. Safe to do because accumulated depreciation is summed
// from posted lines rather than stored on the asset -- nothing has to be unwound.
//
// Only the most recent posted period may be voided: voiding an older one would leave every month
// after it computed from an opening balance that no longer exists.
router.post('/:id/void', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const reason = req.body?.reason;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required to void a posted run.' });
    const [[run]] = await conn.query('SELECT * FROM asset_depreciation_runs WHERE id = ?', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (run.status !== 'posted') return res.status(409).json({ error: 'Only a posted run can be voided.' });
    await assertPeriodOpen(periodEndDate(run.period_month), 'other_gl', conn);

    const [[later]] = await conn.query(
      "SELECT run_no, period_month FROM asset_depreciation_runs WHERE status = 'posted' AND period_month > ? ORDER BY period_month LIMIT 1",
      [run.period_month],
    );
    if (later) {
      return res.status(409).json({ error: `${later.run_no} has posted a later period (${String(later.period_month).slice(0, 7)}). Void that first -- later months are computed from this one.` });
    }

    await conn.beginTransaction();
    await conn.query(
      "UPDATE asset_depreciation_runs SET status = 'voided', voided_by_user_id = ?, voided_at = NOW(), void_reason = ? WHERE id = ?",
      [req.user.id, trunc(reason, 500), run.id],
    );
    await logAudit(conn, { runId: run.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'posted', newValue: 'voided' });
    await conn.commit();
    res.json({ ok: true, status: 'voided' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[run]] = await conn.query('SELECT id, status FROM asset_depreciation_runs WHERE id = ?', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (run.status !== 'draft') return res.status(409).json({ error: 'Only a draft run can be deleted. Void a posted run instead, so the record survives.' });
    await conn.beginTransaction();
    await conn.query('DELETE FROM asset_depreciation_lines WHERE run_id = ?', [req.params.id]);
    await conn.query('DELETE FROM asset_depreciation_runs WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
