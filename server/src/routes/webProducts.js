const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { costing } = require('../lib/costing');

const router = express.Router();
const ROUTE = '/web-products';

// Master Lists > Website Products: the catalogue behind the customer-facing quote site.
//
// A web product is a pointer at things the ERP already owns -- a job type, and process/material
// lines with default sizes -- not a second pricing model. Pricing always runs through
// shared/costing.js, so what a customer is quoted and what the estimate wizard would produce for
// the same inputs are the same number by construction.
//
// PUBLISHING IS THE POINT OF THIS SCREEN. Products seed unpublished, and a product is invisible to
// the site until someone with can_approve here turns it on, having checked the prices look right.
// Editing is can_edit; publishing is deliberately a separate, higher bar, because it is the step
// that puts a price in front of a customer.

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const nul = (v) => (v === '' || v === undefined ? null : v);

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, jt.display_name AS job_type_name, sd.name AS sales_division_name,
              (SELECT COUNT(*) FROM web_product_lines l WHERE l.web_product_id = p.id) AS line_count
         FROM web_products p
         LEFT JOIN job_types jt ON jt.id = p.job_type_id
         LEFT JOIN sales_divisions sd ON sd.id = p.sales_division_id
        ORDER BY p.sort_order, p.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[product]] = await pool.query(
      `SELECT p.*, jt.display_name AS job_type_name
         FROM web_products p LEFT JOIN job_types jt ON jt.id = p.job_type_id
        WHERE p.id = ?`, [req.params.id]
    );
    if (!product) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT l.*, pr.process_name, i.display_name AS item_name
         FROM web_product_lines l
         LEFT JOIN processes pr ON pr.id = l.process_id
         LEFT JOIN inventories i ON i.id = l.item_id
        WHERE l.web_product_id = ? ORDER BY l.line_no, l.id`, [req.params.id]
    );
    return res.json({ ...product, lines });
  } catch (err) { return next(err); }
});

// A live price for the product's own defaults, so the admin can see what a customer would be
// quoted before publishing it. Same code path the public API uses.
router.get('/:id/preview-price', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { computeAutoPricing } = await costing();
    const [lines] = await pool.query('SELECT * FROM web_product_lines WHERE web_product_id = ? ORDER BY line_no', [req.params.id]);
    const out = [];
    let total = 0;
    for (const l of lines) {
      const [brackets] = l.process_id
        ? await pool.query('SELECT * FROM process_cost_brackets WHERE process_id = ? ORDER BY qty_min', [l.process_id])
        : [[]];
      const [[inventory]] = l.item_id
        ? await pool.query('SELECT * FROM inventories WHERE id = ?', [l.item_id]) : [[null]];
      const c = computeAutoPricing({
        brackets, inventory: inventory || null,
        processQty: l.default_process_qty, qty: l.default_qty,
        length: l.default_length, width: l.default_width, uom: l.uom,
      }) || {};
      const price = round2(c.total_price);
      total += price;
      out.push({
        line_id: l.id, label: l.label, price,
        // A line that cannot price is the thing that makes a product unsafe to publish, so say so
        // rather than showing a confident 0.00.
        problem: !l.process_id ? 'No process set'
          : !brackets.length ? 'That process has no costing brackets'
            : price === 0 ? 'Prices at zero — check the defaults' : null,
      });
    }
    return res.json({ lines: out, total: round2(total) });
  } catch (err) { return next(err); }
});

const PRODUCT_FIELDS = ['slug', 'name', 'tagline', 'description', 'image_url', 'job_type_id',
  'sales_division_id', 'department_id', 'default_qty', 'min_qty', 'max_qty', 'lead_time_days', 'sort_order'];

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.slug || !b.name) return res.status(400).json({ error: 'A slug and a name are required.' });
    const [r] = await pool.query(
      `INSERT INTO web_products (${PRODUCT_FIELDS.join(', ')}, is_published)
       VALUES (${PRODUCT_FIELDS.map(() => '?').join(', ')}, 0)`,
      PRODUCT_FIELDS.map((f) => nul(b[f]))
    );
    const [[row]] = await pool.query('SELECT * FROM web_products WHERE id = ?', [r.insertId]);
    return res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That slug is already in use.' });
    return next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE web_products SET ${PRODUCT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...PRODUCT_FIELDS.map((f) => nul(b[f])), req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM web_products WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That slug is already in use.' });
    return next(err);
  }
});

// Publish / unpublish. Separate from edit, and separately permissioned: this is what puts a price
// in front of a customer.
router.put('/:id/publish', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const publish = req.body?.is_published !== false;
    const [[product]] = await pool.query('SELECT id, name FROM web_products WHERE id = ?', [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Not found' });

    if (publish) {
      // Refuse to publish something a customer cannot actually be quoted for. Without this the
      // site would offer the product and then show 0.00, or nothing at all.
      const [lines] = await pool.query('SELECT id, process_id FROM web_product_lines WHERE web_product_id = ?', [req.params.id]);
      if (!lines.length) return res.status(409).json({ error: `${product.name} has no lines, so there is nothing to price.` });
      const missing = lines.filter((l) => !l.process_id);
      if (missing.length) return res.status(409).json({ error: `${missing.length} line(s) have no process set, so they cannot be priced.` });
      const ids = lines.map((l) => l.process_id);
      const [withBrackets] = await pool.query(
        `SELECT DISTINCT process_id FROM process_cost_brackets WHERE process_id IN (?)`, [ids]
      );
      const have = new Set(withBrackets.map((r) => Number(r.process_id)));
      const unpriceable = ids.filter((id) => !have.has(Number(id)));
      if (unpriceable.length) {
        return res.status(409).json({ error: 'A process on this product has no costing brackets, so it would price at zero.' });
      }
    }

    await pool.query('UPDATE web_products SET is_published = ? WHERE id = ?', [publish ? 1 : 0, req.params.id]);
    const [[row]] = await pool.query('SELECT * FROM web_products WHERE id = ?', [req.params.id]);
    return res.json(row);
  } catch (err) { return next(err); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    // Lines cascade on the foreign key, so the product row is all that needs removing.
    const [r] = await pool.query('DELETE FROM web_products WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.status(204).send();
  } catch (err) { return next(err); }
});

// --- lines ---------------------------------------------------------------------------------
const LINE_FIELDS = ['line_no', 'label', 'process_id', 'item_id', 'default_process_qty', 'default_qty',
  'default_length', 'default_width', 'uom', 'allow_qty', 'allow_size',
  'min_length', 'max_length', 'min_width', 'max_width'];

router.post('/:id/lines', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const [r] = await pool.query(
      `INSERT INTO web_product_lines (web_product_id, ${LINE_FIELDS.join(', ')})
       VALUES (?, ${LINE_FIELDS.map(() => '?').join(', ')})`,
      [req.params.id, ...LINE_FIELDS.map((f) => nul(b[f]))]
    );
    const [[row]] = await pool.query('SELECT * FROM web_product_lines WHERE id = ?', [r.insertId]);
    return res.status(201).json(row);
  } catch (err) { return next(err); }
});

router.put('/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE web_product_lines SET ${LINE_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...LINE_FIELDS.map((f) => nul(b[f])), req.params.lineId]
    );
    const [[row]] = await pool.query('SELECT * FROM web_product_lines WHERE id = ?', [req.params.lineId]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
  } catch (err) { return next(err); }
});

router.delete('/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM web_product_lines WHERE id = ?', [req.params.lineId]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    return res.status(204).send();
  } catch (err) { return next(err); }
});

module.exports = router;
