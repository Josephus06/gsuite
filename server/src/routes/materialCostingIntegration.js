const crypto = require('crypto');
const express = require('express');
const pool = require('../db');

// Read-only feed of the Material Costing item list for the Signage Studio (its Material Library).
//
// The studio syncs from this server-to-server with no ERP user behind it, so like the Rewards feed
// (routes/loyaltyIntegration.js) it sends a fixed key instead of the 8h login JWT:
//
//   MATERIAL_COSTING_API_KEY=<long random string>     (same value in the studio's .env)
//
// Unset, every route answers 503 -- the feed is off until someone deliberately turns it on.
// Nothing here writes. Only item identity, units and costs leave the ERP: no stock, accounts or
// suppliers.
//
//   GET /api/integrations/material-costing/items
//       ?status=approved (default) | all
//       ?updated_since=2026-11-01           only items changed on or after this date/time
//       ?item_type=Inventory                one item type (default: stock items only, as the
//                                           Material Costing page lists them)
//   GET /api/integrations/material-costing/items/:itemCode

const router = express.Router();

const keyMatches = (given) => {
  const expected = process.env.MATERIAL_COSTING_API_KEY || '';
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

router.use((req, res, next) => {
  if (!process.env.MATERIAL_COSTING_API_KEY) return res.status(503).json({ error: 'Material Costing integration is disabled' });
  if (!keyMatches(req.get('x-api-key'))) return res.status(401).json({ error: 'Invalid API key' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Same split as routes/inventories.js: Material Costing lists stock items only, and only they go
// through the costing / accounting approvals.
const NON_STOCK_TYPES = "(i.item_type IS NULL OR i.item_type NOT IN ('Service', 'Non-Inventory', 'Landed Cost', 'Discount'))";
const APPROVED_SQL = 'i.is_costing_approved = 1 AND i.is_accounting_approved = 1';

const SELECT = `SELECT i.id, i.item_code, i.display_name, i.sales_description, i.item_type,
         c.name AS category_name,
         u.code AS base_unit_code, u.title AS base_unit_title,
         (SELECT ut.title FROM unit_titles ut WHERE ut.id = i.unit_title_id) AS unit_title,
         i.length, i.width, i.is_length_based, i.is_width_based,
         i.material_cost, i.last_purchase_price, i.last_purchase_date, i.average_cost,
         i.wastage_allowance_pct, i.markup_pct, i.selling_price,
         i.is_active, i.is_costing_approved, i.is_accounting_approved, i.updated_at
    FROM inventories i
    LEFT JOIN inventory_categories c ON c.id = i.category_id
    LEFT JOIN units_of_measure u ON u.id = i.base_unit_id`;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const day = (v) => (!v ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const shape = (r) => ({
  id: r.id,
  item_code: r.item_code,
  name: r.display_name,
  description: r.sales_description || null,
  item_type: r.item_type || null,
  category: r.category_name || null,
  unit: { code: r.base_unit_code || null, title: r.base_unit_title || null },
  unit_title: r.unit_title || null, // e.g. 'LENGTH-LMTR-6.1'
  length: num(r.length),
  width: num(r.width),
  is_length_based: !!r.is_length_based,
  is_width_based: !!r.is_width_based,
  material_cost: num(r.material_cost), // the Base Cost the Material Costing page edits
  last_purchase_price: num(r.last_purchase_price),
  last_purchase_date: day(r.last_purchase_date),
  average_cost: num(r.average_cost),
  wastage_allowance_pct: num(r.wastage_allowance_pct),
  markup_pct: num(r.markup_pct),
  selling_price: num(r.selling_price),
  is_active: !!r.is_active,
  is_approved: !!r.is_costing_approved && !!r.is_accounting_approved,
  // Sessions run in UTC (db.js) and dates come back as strings, so this is UTC: '2026-11-24T03:15:00Z'.
  updated_at: r.updated_at ? `${String(r.updated_at).replace(' ', 'T').slice(0, 19)}Z` : null,
});

// GET /items
// status=approved (default) returns active, fully approved items. status=all adds inactive and
// pending ones, each carrying is_active / is_approved, so a sync can archive what was retired.
router.get('/items', async (req, res, next) => {
  try {
    const status = req.query.status === 'all' ? 'all' : 'approved';
    const where = [];
    const params = [];

    if (req.query.item_type) {
      where.push('i.item_type = ?');
      params.push(String(req.query.item_type));
    } else {
      where.push(NON_STOCK_TYPES);
    }
    if (status === 'approved') where.push(`i.is_active = 1 AND ${APPROVED_SQL}`);

    const since = String(req.query.updated_since || '').trim();
    if (since) {
      if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(since)) {
        return res.status(400).json({ error: 'updated_since must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS' });
      }
      where.push('i.updated_at >= ?');
      params.push(since.replace('T', ' ').replace(/Z$|\.\d+Z?$/, ''));
    }

    const [rows] = await pool.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY i.item_code`, params);
    res.json({ generated_at: new Date().toISOString(), status, count: rows.length, data: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

// GET /items/:itemCode -- one item, whatever its status.
router.get('/items/:itemCode', async (req, res, next) => {
  try {
    const [[row]] = await pool.query(`${SELECT} WHERE i.item_code = ? LIMIT 1`, [req.params.itemCode]);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    res.json({ data: shape(row) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
