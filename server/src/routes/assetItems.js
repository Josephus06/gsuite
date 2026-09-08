const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Asset types -- "UPS", "RAM 8 GB", "System Unit", "Monitor". The type is what you buy six of;
// the reference numbers underneath it are the six things you can actually point at, and those
// live in routes/assets.js. Keeping the type separate is what lets the register group the way the
// equipment is talked about, and stops "UPS" being re-typed (and mis-spelled) once per unit.
const ROUTE = '/asset-items';

const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, category, active } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));

    const where = [];
    const params = [];
    if (category) { where.push('ai.category = ?'); params.push(category); }
    if (active === 'yes') where.push('ai.is_active = TRUE');
    if (active === 'no') where.push('ai.is_active = FALSE');
    if (search) {
      where.push('(ai.item_code LIKE ? OR ai.display_name LIKE ? OR ai.brand LIKE ? OR ai.model LIKE ? OR ai.category LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM asset_items ai ${whereSql}`, params);
    // unit_count is a correlated subquery rather than a GROUP BY join: the page shows one row per
    // type whether or not any references exist under it yet, and a join would need care to keep
    // the zero-unit types visible.
    const [rows] = await pool.query(
      `SELECT ai.*, (SELECT COUNT(*) FROM assets a WHERE a.asset_item_id = ai.id) AS unit_count
         FROM asset_items ai ${whereSql} ORDER BY ai.display_name LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

router.get('/categories', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT category FROM asset_items WHERE category IS NOT NULL AND category <> '' ORDER BY category",
    );
    res.json(rows.map((r) => r.category));
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT ai.*, u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM assets a WHERE a.asset_item_id = ai.id) AS unit_count
         FROM asset_items ai LEFT JOIN users u ON u.id = ai.created_by_user_id WHERE ai.id = ?`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    const [units] = await pool.query(
      `SELECT a.id, a.reference_no, a.serial_no, a.status,
              CASE WHEN a.parent_asset_id IS NULL THEN a.location_id ELSE p.location_id END AS location_id,
              loc.location_name, CONCAT(e.first_name, ' ', e.last_name) AS custodian_name
         FROM assets a
         LEFT JOIN assets p ON p.id = a.parent_asset_id
         LEFT JOIN locations loc ON loc.id = CASE WHEN a.parent_asset_id IS NULL THEN a.location_id ELSE p.location_id END
         LEFT JOIN employees e ON e.id = CASE WHEN a.parent_asset_id IS NULL THEN a.custodian_employee_id ELSE p.custodian_employee_id END
        WHERE a.asset_item_id = ? ORDER BY a.reference_no`,
      [req.params.id],
    );
    res.json({ ...row, units });
  } catch (err) { next(err); }
});

// item_code is generated when the form leaves it blank, so nobody has to invent a coding scheme
// before they can register their first UPS. A supplied code is respected as-is.
async function nextItemCode(conn) {
  const [[row]] = await conn.query("SELECT MAX(CAST(SUBSTRING(item_code, 5) AS UNSIGNED)) AS n FROM asset_items WHERE item_code REGEXP '^AST-[0-9]+$'");
  return `AST-${String((row?.n || 0) + 1).padStart(4, '0')}`;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    if (!b.display_name || !String(b.display_name).trim()) return res.status(400).json({ error: 'Asset type name is required.' });

    await conn.beginTransaction();
    const code = b.item_code && String(b.item_code).trim() ? String(b.item_code).trim().slice(0, 40) : await nextItemCode(conn);
    const [[dupe]] = await conn.query('SELECT id FROM asset_items WHERE item_code = ? LIMIT 1', [code]);
    if (dupe) { await conn.rollback(); return res.status(400).json({ error: `Code ${code} is already used.` }); }

    const [r] = await conn.query(
      `INSERT INTO asset_items (item_code, display_name, category, brand, model, specification, description, is_active, created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [code, trunc(b.display_name, 200), trunc(b.category, 100), trunc(b.brand, 120), trunc(b.model, 120),
        trunc(b.specification, 500), trunc(b.description, 1000), b.is_active === false ? 0 : 1, req.user.id],
    );
    await conn.commit();
    res.status(201).json({ id: r.insertId, item_code: code });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.display_name || !String(b.display_name).trim()) return res.status(400).json({ error: 'Asset type name is required.' });
    const [[existing]] = await pool.query('SELECT id FROM asset_items WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (b.item_code) {
      const [[dupe]] = await pool.query('SELECT id FROM asset_items WHERE item_code = ? AND id <> ? LIMIT 1', [String(b.item_code).trim(), req.params.id]);
      if (dupe) return res.status(400).json({ error: `Code ${String(b.item_code).trim()} is already used.` });
    }
    await pool.query(
      `UPDATE asset_items SET item_code = COALESCE(?, item_code), display_name = ?, category = ?, brand = ?, model = ?,
              specification = ?, description = ?, is_active = ?, updated_at = NOW() WHERE id = ?`,
      [trunc(b.item_code, 40), trunc(b.display_name, 200), trunc(b.category, 100), trunc(b.brand, 120), trunc(b.model, 120),
        trunc(b.specification, 500), trunc(b.description, 1000), b.is_active === false ? 0 : 1, req.params.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// A type with units under it is deactivated, never deleted -- deleting it would orphan every
// reference number that points at it and leave the register unable to say what those things are.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM assets WHERE asset_item_id = ?', [req.params.id]);
    if (used.n > 0) return res.status(409).json({ error: `This type has ${used.n} asset(s) registered under it. Set it inactive instead.` });
    await pool.query('DELETE FROM asset_items WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
