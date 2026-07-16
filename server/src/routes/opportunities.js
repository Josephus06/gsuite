const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/opportunities';
const STAGES = ['prospecting', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { stage, customer_id: customerId, search } = req.query;
    const where = [];
    const params = [];
    if (stage && STAGES.includes(stage)) { where.push('o.stage = ?'); params.push(stage); }
    if (customerId) { where.push('o.customer_id = ?'); params.push(customerId); }
    if (search) {
      where.push('(o.opportunity_no LIKE ? OR o.name LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT o.*, c.name AS customer_name, l.company_name AS lead_company_name,
              CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name, est.estimate_no
       FROM opportunities o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN leads l ON l.id = o.lead_id
       LEFT JOIN employees e ON e.id = o.sales_rep_id
       LEFT JOIN estimates est ON est.id = o.estimate_id
       ${whereSql}
       ORDER BY o.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[opp]] = await pool.query(
      `SELECT o.*, c.name AS customer_name, l.company_name AS lead_company_name,
              CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name,
              est.estimate_no, u.display_name AS created_by_name
       FROM opportunities o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN leads l ON l.id = o.lead_id
       LEFT JOIN employees e ON e.id = o.sales_rep_id
       LEFT JOIN estimates est ON est.id = o.estimate_id
       LEFT JOIN users u ON u.id = o.created_by_user_id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!opp) return res.status(404).json({ error: 'Not found' });
    res.json(opp);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const {
      name, customer_id: customerId, lead_id: leadId, estimated_value: estimatedValue,
      expected_close_date: expectedCloseDate, sales_rep_id: salesRepId, estimate_id: estimateId, memo,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!customerId && !leadId) return res.status(400).json({ error: 'Select a Customer or a Lead.' });

    const [result] = await pool.query(
      `INSERT INTO opportunities
         (opportunity_no, name, customer_id, lead_id, estimated_value, expected_close_date, sales_rep_id, estimate_id, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, customerId || null, leadId || null, estimatedValue || 0, expectedCloseDate || null,
        salesRepId || null, estimateId || null, memo || null, req.user.id]
    );
    const oppId = result.insertId;
    await pool.query('UPDATE opportunities SET opportunity_no = ? WHERE id = ?', [`OPP-${oppId}`, oppId]);

    const [[row]] = await pool.query('SELECT * FROM opportunities WHERE id = ?', [oppId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const {
      name, customer_id: customerId, lead_id: leadId, estimated_value: estimatedValue,
      expected_close_date: expectedCloseDate, sales_rep_id: salesRepId, estimate_id: estimateId, memo,
    } = req.body;
    await pool.query(
      `UPDATE opportunities SET
         name = ?, customer_id = ?, lead_id = ?, estimated_value = ?, expected_close_date = ?,
         sales_rep_id = ?, estimate_id = ?, memo = ?, updated_at = NOW()
       WHERE id = ?`,
      [name, customerId || null, leadId || null, estimatedValue || 0, expectedCloseDate || null,
        salesRepId || null, estimateId || null, memo || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Moving stage is the core pipeline action -- kept as its own endpoint (rather than
// folded into the general PUT /:id) since Won/Lost both need to stamp closed_at, and
// Lost specifically requires a reason (mirrors how this codebase always requires a
// reason/memo alongside any other terminal status change, e.g. Purchase Order Cancel).
router.put('/:id/stage', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { stage, lost_reason: lostReason } = req.body;
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage.' });
    if (stage === 'lost' && !lostReason) return res.status(400).json({ error: 'Enter a reason for marking this Opportunity Lost.' });

    const closedAt = stage === 'won' || stage === 'lost' ? new Date() : null;
    await pool.query(
      'UPDATE opportunities SET stage = ?, lost_reason = ?, closed_at = ?, updated_at = NOW() WHERE id = ?',
      [stage, stage === 'lost' ? lostReason : null, closedAt, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
