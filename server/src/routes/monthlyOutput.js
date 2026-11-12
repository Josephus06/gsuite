const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendXlsx } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/monthly-output-reports';

// Inventory > Reports > Monthly Output (asked 2026-11-12, the source's /monthly-output-reports):
// what each item put into production over a period -- the material on Assembly Build lines, summed
// per item, location and unit. One row per Item Code / Display Name / Type / Sum of Qty / Sales
// Unit / Location, as the source lists it. Quantities are the lines' Total Qty to Build in the
// line's own unit (PC / SHT / LINCH ...), which is the unit the source's Sales Unit column shows.
// Cancelled builds are left out.
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function filter(q) {
  const where = ['abl.item_id IS NOT NULL', "ab.status <> 'cancelled'"];
  const params = [];
  // Period: As of (up to that day) or Period from .. to, both inclusive.
  const to = ISO.test(String(q.date_to || '')) ? q.date_to : null;
  const from = q.date_mode === 'period' && ISO.test(String(q.date_from || '')) ? q.date_from : null;
  if (from) { where.push('ab.date_created >= ?'); params.push(from); }
  if (to) { where.push('ab.date_created <= ?'); params.push(to); }
  if (Number(q.location_id) > 0) { where.push('abl.location_id = ?'); params.push(Number(q.location_id)); }
  if (Number(q.item_id) > 0) { where.push('abl.item_id = ?'); params.push(Number(q.item_id)); }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

async function load(q) {
  const { whereSql, params } = filter(q);
  const [rows] = await pool.query(
    `SELECT i.id AS item_id, i.item_code, i.display_name, i.item_type,
            COALESCE(NULLIF(TRIM(abl.unit), ''), su.code, su.title) AS unit,
            loc.id AS location_id, loc.location_name,
            SUM(abl.total_qty_to_build) AS qty
       FROM assembly_build_lines abl
       JOIN assembly_builds ab ON ab.id = abl.assembly_build_id
       JOIN inventories i ON i.id = abl.item_id
       LEFT JOIN units_of_measure su ON su.id = i.sales_unit_id
       LEFT JOIN locations loc ON loc.id = abl.location_id
      ${whereSql}
      GROUP BY i.id, i.item_code, i.display_name, i.item_type, unit, loc.id, loc.location_name
      HAVING SUM(abl.total_qty_to_build) <> 0
      ORDER BY loc.location_name, i.item_code`,
    params
  );
  return rows.map((r) => ({ ...r, qty: Number(r.qty || 0) }));
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json({ rows: await load(req.query) }); } catch (err) { next(err); }
});

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await load(req.query);
    await sendXlsx(res, {
      filename: 'monthly-output.xlsx',
      sheet: 'Monthly Output',
      columns: [
        { header: 'Item Code', key: 'item_code', width: 44 },
        { header: 'Display Name', key: 'display_name', width: 60 },
        { header: 'Type', key: 'item_type', width: 14 },
        { header: 'Sum of Qty', key: 'qty', width: 14, numFmt: '#,##0.00' },
        { header: 'Sales Unit', key: 'unit', width: 12 },
        { header: 'Location', key: 'location_name', width: 24 },
      ],
      rows: rows.map((r) => ({ ...r, unit: r.unit || '', location_name: r.location_name || '' })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
