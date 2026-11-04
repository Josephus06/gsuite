const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeInk, syncNewInkCost } = require('../lib/processInk');

// Master Lists > Lookups > Processes, view and edit (2026-11-04): the header the lookup already had,
// plus the source's Materials tab, Ink tab and Ink Calculation (process_items and the ink_* columns
// on processes; db/import-process-inks.js adds them and copies the source's). Same rights as the
// lookup: /lookups can_view to read, can_add to create, can_edit to change.
const router = express.Router();
const LOOKUPS = '/lookups';

const INK_FIELDS = ['ink_media_usage', 'ink_media_weight_wo_print', 'ink_media_weight_w_print', 'ink_weight_full', 'ink_weight_empty', 'ink_volume',
  'ink_usage_costing', 'ink_price_per_ml_costing'];
const dec = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

let hasDefaultLocation = null;
async function defaultLocationCol() {
  if (hasDefaultLocation === null) {
    const [c] = await pool.query("SHOW COLUMNS FROM processes LIKE 'default_location_id'");
    hasDefaultLocation = c.length > 0;
  }
  return hasDefaultLocation;
}

// For the Add Material / Add Ink picker: the item master is too big to load whole.
router.get('/inventory-search', requireAuth, requirePermission(LOOKUPS, 'can_view'), async (req, res, next) => {
  try {
    const q = `%${String(req.query.q || '').trim()}%`;
    const [rows] = await pool.query(
      `SELECT id, item_code, display_name, last_purchase_price, average_cost FROM inventories
        WHERE (is_active IS NULL OR is_active = 1) AND (item_code LIKE ? OR display_name LIKE ?)
        ORDER BY item_code LIMIT 50`, [q, q]);
    res.json(rows);
  } catch (err) { next(err); }
});

async function loadProcess(id) {
  const withLoc = await defaultLocationCol();
  const [[p]] = await pool.query(
    `SELECT p.*, u.title AS base_unit_title, u.code AS base_unit_code
            ${withLoc ? ', loc.location_name AS default_location_name' : ''}
       FROM processes p
       LEFT JOIN units_of_measure u ON u.id = p.base_unit_id
       ${withLoc ? 'LEFT JOIN locations loc ON loc.id = p.default_location_id' : ''}
      WHERE p.id = ?`, [id]);
  if (!p) return null;
  const [items] = await pool.query(
    `SELECT pi.id, pi.module, pi.seq, pi.inventory_id, pi.ink_price, pi.volume_ml, i.item_code, i.display_name,
            i.last_purchase_price, i.average_cost
       FROM process_items pi JOIN inventories i ON i.id = pi.inventory_id
      WHERE pi.process_id = ? ORDER BY pi.module, pi.seq, pi.id`, [id]);
  const inks = items.filter((i) => i.module === 'Ink');
  return { ...p, materials: items.filter((i) => i.module === 'Material'), inks, ink: computeInk(p, inks) };
}

router.get('/:id', requireAuth, requirePermission(LOOKUPS, 'can_view'), async (req, res, next) => {
  try {
    const p = await loadProcess(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch (err) { next(err); }
});

// Header, ink calculation inputs, and the full Materials / Ink lists (replaced as sent).
async function save(req, res, next, id) {
  const b = req.body || {};
  const code = String(b.process_code || '').trim();
  const name = String(b.process_name || '').trim();
  if (!code || !name) return res.status(400).json({ error: 'Process Code and Process Name are required.' });
  if (!b.base_unit_id) return res.status(400).json({ error: 'UOM is required.' });
  const materials = Array.isArray(b.materials) ? b.materials : [];
  const inks = Array.isArray(b.inks) ? b.inks : [];
  for (const r of [...materials, ...inks]) {
    if (!Number(r.inventory_id)) return res.status(400).json({ error: 'Every material and ink needs an item.' });
  }
  const [[dup]] = await pool.query('SELECT id FROM processes WHERE process_code = ? AND id <> ?', [code, id || 0]);
  if (dup) return res.status(409).json({ error: `Process Code ${code} is already used.` });

  const withLoc = await defaultLocationCol();
  const ink = computeInk(b, inks);
  const head = {
    process_code: code, process_name: name, base_unit_id: b.base_unit_id,
    minutes_per_unit: dec(b.minutes_per_unit), is_active: b.is_active === false || b.is_active === 0 ? 0 : 1,
    ...(withLoc ? { default_location_id: b.default_location_id || null } : {}),
    ...Object.fromEntries(INK_FIELDS.map((f) => [f, dec(b[f])])),
    // What the rest of the system reads without redoing the sum; empty when there is no ink set-up.
    ink_cost_per_sqft: inks.length ? Number(ink.costPerUnit.toFixed(4)) : null,
    ink_cost_per_sqft_costing: inks.length ? Number(ink.costPerUnitCosting.toFixed(4)) : null,
  };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (id) {
      const [r] = await conn.query(`UPDATE processes SET ${Object.keys(head).map((k) => `${k} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
        [...Object.values(head), id]);
      if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    } else {
      const [r] = await conn.query(`INSERT INTO processes (${Object.keys(head).join(', ')}) VALUES (${Object.keys(head).map(() => '?').join(', ')})`,
        Object.values(head));
      id = r.insertId;
    }
    // Saved here, so no longer the source's copy: import-process-inks.js leaves it alone from now on.
    await conn.query('DELETE FROM process_items WHERE process_id = ?', [id]);
    let seq = 0;
    for (const [module, list] of [['Material', materials], ['Ink', inks]]) {
      for (const r of list) {
        seq += 1;
        await conn.query('INSERT INTO process_items (process_id, module, seq, inventory_id, ink_price, volume_ml) VALUES (?, ?, ?, ?, ?, ?)',
          [id, module, seq, r.inventory_id, module === 'Ink' ? dec(r.ink_price) : null, module === 'Ink' ? dec(r.volume_ml) : null]);
      }
    }
    // Process Costing's New INK Cost follows the new figure straight away (INK waits for Update there).
    await syncNewInkCost(conn, id);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally { conn.release(); }
  res.status(req.method === 'POST' ? 201 : 200).json(await loadProcess(id));
}

router.post('/', requireAuth, requirePermission(LOOKUPS, 'can_add'), (req, res, next) => save(req, res, next, null));
router.put('/:id', requireAuth, requirePermission(LOOKUPS, 'can_edit'), (req, res, next) => save(req, res, next, Number(req.params.id)));

module.exports = router;
