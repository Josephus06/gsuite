const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Asset classes: the bridge between a physical asset and the ledger. A class names the three
// accounts every posting for it uses -- cost, accumulated depreciation, depreciation expense -- so
// an individual asset never carries account ids, and re-pointing a class moves all of its assets
// at once instead of one at a time.
//
// This page also owns the capitalisation policy (asset_settings), because the threshold is the
// other half of the same decision: the class says which accounts an asset posts to, the threshold
// says whether it posts at all.
const ROUTE = '/asset-classes';

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const idOrNull = (v) => (v == null || v === '' ? null : v);

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // Cost and contra accounts are both assets; depreciation expense is an expense. Offering the
    // whole 276-account chart for each would invite mapping a class to a payable.
    const [assetAccounts] = await pool.query(
      "SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_type = 'Asset' ORDER BY account_code",
    );
    const [expenseAccounts] = await pool.query(
      "SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_type IN ('Expense', 'Cost of Sales') ORDER BY account_code",
    );
    const [allAccounts] = await pool.query(
      'SELECT id, account_code, account_name, account_type FROM chart_of_accounts ORDER BY account_code',
    );
    res.json({ asset_accounts: assetAccounts, expense_accounts: expenseAccounts, all_accounts: allAccounts });
  } catch (err) { next(err); }
});

router.get('/settings', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[s]] = await pool.query(
      `SELECT s.*, a.account_code AS gain_loss_account_code, a.account_name AS gain_loss_account_name
         FROM asset_settings s LEFT JOIN chart_of_accounts a ON a.id = s.gain_loss_account_id WHERE s.id = 1`,
    );
    res.json(s || { capitalization_threshold: 0, default_useful_life_months: 60, gain_loss_account_id: null });
  } catch (err) { next(err); }
});

router.put('/settings', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { capitalization_threshold: threshold, default_useful_life_months: life, gain_loss_account_id: glAccount } = req.body;
    const t = Number(threshold);
    if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: 'The capitalisation threshold must be zero or more.' });
    const l = Number(life);
    if (!Number.isInteger(l) || l <= 0) return res.status(400).json({ error: 'The default useful life must be a whole number of months.' });

    await pool.query(
      `INSERT INTO asset_settings (id, capitalization_threshold, default_useful_life_months, gain_loss_account_id, updated_at, updated_by_user_id)
       VALUES (1, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE capitalization_threshold = VALUES(capitalization_threshold),
                               default_useful_life_months = VALUES(default_useful_life_months),
                               gain_loss_account_id = VALUES(gain_loss_account_id),
                               updated_at = NOW(), updated_by_user_id = VALUES(updated_by_user_id)`,
      [t, l, idOrNull(glAccount), req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*,
              ca.account_code AS cost_account_code, ca.account_name AS cost_account_name,
              aa.account_code AS accumulated_account_code, aa.account_name AS accumulated_account_name,
              ea.account_code AS expense_account_code, ea.account_name AS expense_account_name,
              (SELECT COUNT(*) FROM assets a WHERE a.asset_class_id = c.id) AS asset_count,
              (SELECT COUNT(*) FROM assets a WHERE a.asset_class_id = c.id AND a.is_capitalized = TRUE) AS capitalized_count
         FROM asset_classes c
         LEFT JOIN chart_of_accounts ca ON ca.id = c.cost_account_id
         LEFT JOIN chart_of_accounts aa ON aa.id = c.accumulated_depreciation_account_id
         LEFT JOIN chart_of_accounts ea ON ea.id = c.depreciation_expense_account_id
        ORDER BY c.name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// A depreciable class must have all three accounts, or it will fail at posting time -- which is
// months after anyone remembers creating it, in the middle of a period close.
function validateClass(b) {
  if (!b.name || !String(b.name).trim()) return 'A class name is required.';
  if (!b.cost_account_id) return 'A cost account is required.';
  const depreciable = b.is_depreciable !== false;
  if (depreciable && !b.accumulated_depreciation_account_id) return 'A depreciable class needs an accumulated depreciation account.';
  if (depreciable && !b.depreciation_expense_account_id) return 'A depreciable class needs a depreciation expense account.';
  if (depreciable) {
    const life = Number(b.default_useful_life_months);
    if (!Number.isInteger(life) || life <= 0) return 'A depreciable class needs a default useful life in whole months.';
  }
  if (b.accumulated_depreciation_account_id && String(b.accumulated_depreciation_account_id) === String(b.cost_account_id)) {
    return 'The accumulated depreciation account must be different from the cost account.';
  }
  return null;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const b = req.body;
    const problem = validateClass(b);
    if (problem) return res.status(400).json({ error: problem });
    const [[dupe]] = await pool.query('SELECT id FROM asset_classes WHERE name = ?', [String(b.name).trim()]);
    if (dupe) return res.status(400).json({ error: `A class named "${String(b.name).trim()}" already exists.` });

    const [r] = await pool.query(
      `INSERT INTO asset_classes (name, cost_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
                                  is_depreciable, default_useful_life_months, is_active)
       VALUES (?,?,?,?,?,?,?)`,
      [trunc(b.name, 150), b.cost_account_id, idOrNull(b.accumulated_depreciation_account_id), idOrNull(b.depreciation_expense_account_id),
        b.is_depreciable !== false, idOrNull(b.default_useful_life_months), b.is_active !== false],
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = req.body;
    const problem = validateClass(b);
    if (problem) return res.status(400).json({ error: problem });
    const [[existing]] = await pool.query('SELECT id, is_depreciable FROM asset_classes WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const [[dupe]] = await pool.query('SELECT id FROM asset_classes WHERE name = ? AND id <> ?', [String(b.name).trim(), req.params.id]);
    if (dupe) return res.status(400).json({ error: `A class named "${String(b.name).trim()}" already exists.` });

    // Turning depreciation off on a class that has already depreciated would strand those postings:
    // the expense is in the ledger and the contra balance is real, but nothing would ever relieve it.
    if (existing.is_depreciable && b.is_depreciable === false) {
      const [[posted]] = await pool.query(
        `SELECT COUNT(*) n FROM asset_depreciation_lines l
           JOIN asset_depreciation_runs r ON r.id = l.run_id
           JOIN assets a ON a.id = l.asset_id
          WHERE a.asset_class_id = ? AND r.status = 'posted'`,
        [req.params.id],
      );
      if (posted.n > 0) return res.status(409).json({ error: `This class already has ${posted.n} posted depreciation line(s), so it cannot be made non-depreciable.` });
    }

    await pool.query(
      `UPDATE asset_classes SET name = ?, cost_account_id = ?, accumulated_depreciation_account_id = ?,
              depreciation_expense_account_id = ?, is_depreciable = ?, default_useful_life_months = ?, is_active = ?, updated_at = NOW()
        WHERE id = ?`,
      [trunc(b.name, 150), b.cost_account_id, idOrNull(b.accumulated_depreciation_account_id), idOrNull(b.depreciation_expense_account_id),
        b.is_depreciable !== false, idOrNull(b.default_useful_life_months), b.is_active !== false, req.params.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query('SELECT COUNT(*) n FROM assets WHERE asset_class_id = ?', [req.params.id]);
    if (used.n > 0) return res.status(409).json({ error: `${used.n} asset(s) are in this class. Set it inactive instead.` });
    await pool.query('DELETE FROM asset_classes WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
