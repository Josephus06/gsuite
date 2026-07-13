const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/process-costing';

const FIELDS = [
  'qty_min', 'qty_max', 'click_charge', 'ink_cost', 'direct_labor',
  'moh_power_equipment', 'moh_depreciation', 'moh_repairs_maintenance',
  'moh_indirect_materials', 'moh_indirect_labor', 'other_charges', 'sub_con',
  'costing_allowance_pct', 'markup_cogs_pct', 'opex_admin_pct', 'opex_selling_pct',
  'disc_ceiling_pct', 'disc_supervisor_pct', 'disc_manager_pct', 'disc_gm_pct',
  'selling_price_override', 'is_active',
];

router.get('/:processId/cost-brackets', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM process_cost_brackets WHERE process_id = ? ORDER BY qty_min',
      [req.params.processId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:processId/cost-brackets', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const values = FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    const [result] = await pool.query(
      `INSERT INTO process_cost_brackets (process_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`,
      [req.params.processId, ...values]
    );
    const [[row]] = await pool.query('SELECT * FROM process_cost_brackets WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:processId/cost-brackets/:bracketId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const values = FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    await pool.query(
      `UPDATE process_cost_brackets SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ? AND process_id = ?`,
      [...values, req.params.bracketId, req.params.processId]
    );
    const [[row]] = await pool.query('SELECT * FROM process_cost_brackets WHERE id = ?', [req.params.bracketId]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:processId/cost-brackets/:bracketId', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM process_cost_brackets WHERE id = ? AND process_id = ?', [req.params.bracketId, req.params.processId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
