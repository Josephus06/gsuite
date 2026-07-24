const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Commission Table (Commission > Setups > Commission Table). Admin-maintained rate
// schemes -- a named ladder of Total Weighted Sales brackets, each mapping to a fixed
// Commission Amount. Registered by src/db/create-commission-module.js.
const ROUTE = '/commission-schemes';

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = [];
    const params = [];
    if (search) { where.push('cs.name LIKE ?'); params.push(`%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT cs.id, cs.name, cs.is_active, cs.created_at, cs.updated_at,
              COUNT(csb.id) AS bracket_count
       FROM commission_schemes cs
       LEFT JOIN commission_scheme_brackets csb ON csb.commission_scheme_id = cs.id
       ${whereSql}
       GROUP BY cs.id
       ORDER BY cs.name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[scheme]] = await pool.query(
      `SELECT cs.*, u.display_name AS created_by_name
       FROM commission_schemes cs
       LEFT JOIN users u ON u.id = cs.created_by_user_id
       WHERE cs.id = ?`,
      [req.params.id]
    );
    if (!scheme) return res.status(404).json({ error: 'Not found' });
    const [brackets] = await pool.query(
      `SELECT id, min_weighted_sales, max_weighted_sales, commission_amount, commission_rate
       FROM commission_scheme_brackets WHERE commission_scheme_id = ?
       ORDER BY sort_order, id`,
      [req.params.id]
    );
    res.json({ ...scheme, brackets });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Scheme name is required.' });
    const [result] = await pool.query(
      'INSERT INTO commission_schemes (name, created_by_user_id) VALUES (?, ?)',
      [name, req.user.id]
    );
    const [[row]] = await pool.query('SELECT * FROM commission_schemes WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// Edit replaces the whole scheme in one shot: rename plus the entire bracket grid. The
// real screen edits the ladder as a single page rather than row by row, so this deletes
// and re-inserts the brackets inside one transaction -- simpler than diffing, and the
// grids are tiny.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[scheme]] = await conn.query('SELECT id FROM commission_schemes WHERE id = ?', [req.params.id]);
    if (!scheme) { conn.release(); return res.status(404).json({ error: 'Not found' }); }

    const name = (req.body.name || '').trim();
    if (!name) { conn.release(); return res.status(400).json({ error: 'Scheme name is required.' }); }

    const brackets = Array.isArray(req.body.brackets) ? req.body.brackets : [];
    for (const b of brackets) {
      const min = Number(b.min_weighted_sales);
      const max = Number(b.max_weighted_sales);
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        conn.release();
        return res.status(400).json({ error: 'Every bracket needs a numeric From and To.' });
      }
      if (max < min) {
        conn.release();
        return res.status(400).json({ error: `A bracket's To (${max}) can't be less than its From (${min}).` });
      }
    }

    await conn.beginTransaction();
    await conn.query('UPDATE commission_schemes SET name = ?, is_active = ?, updated_at = NOW() WHERE id = ?',
      [name, req.body.is_active === false ? 0 : 1, req.params.id]);
    await conn.query('DELETE FROM commission_scheme_brackets WHERE commission_scheme_id = ?', [req.params.id]);
    let order = 0;
    for (const b of brackets) {
      await conn.query(
        `INSERT INTO commission_scheme_brackets
           (commission_scheme_id, sort_order, min_weighted_sales, max_weighted_sales, commission_amount, commission_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.params.id, order++, Number(b.min_weighted_sales), Number(b.max_weighted_sales),
          Number(b.commission_amount) || 0, Number(b.commission_rate) || 0]
      );
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM commission_schemes WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM commission_scheme_brackets WHERE commission_scheme_id = ?', [req.params.id]);
    await conn.query('DELETE FROM commission_schemes WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
