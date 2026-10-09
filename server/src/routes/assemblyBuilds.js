const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeAssemblyBuildGl } = require('../lib/glImpact');
const { getJobLocationScope, isJobLocationVisible } = require('../lib/jobLocationVisibility');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { isNonStockItem } = require('../lib/itemTypes');
const { deriveOnHand } = require('../lib/stockLedger');

const router = express.Router();
const ROUTE = '/assembly-builds';

// GL Impact computation lives in server/src/lib/glImpact.js (computeAssemblyBuildGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeAssemblyBuildGl;

async function logAudit(conn, { assemblyBuildId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('AssemblyBuild', ?, ?, ?, ?, ?, ?)`,
    [assemblyBuildId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Mirrors the real system's "Production > Assembly Build" ("Saved Assembly Build")
// list -- a flat table (no status tabs) with a filter panel, same pattern as the
// Job Orders list.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      search, sales_rep_id: salesRepId, job_location_id: jobLocationId, customer_id: customerId,
      as_of: asOf, page = '1', limit = '10',
    } = req.query;

    const where = [];
    const params = [];
    // An assembly build belongs to its job order's warehouse, so a production department sees
    // only its own builds -- same rule as the Job Orders and Production lists.
    const scopeLocationId = await getJobLocationScope(req.user.id, ROUTE);
    if (scopeLocationId) { where.push('jo.job_location_id = ?'); params.push(scopeLocationId); }
    if (salesRepId) { where.push('so.sales_rep_id = ?'); params.push(salesRepId); }
    if (jobLocationId) { where.push('jo.job_location_id = ?'); params.push(jobLocationId); }
    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
    if (asOf) { where.push('ab.date_created <= ?'); params.push(asOf); }
    if (search) {
      where.push('(ab.ab_no LIKE ? OR jo.job_order_no LIKE ? OR c.name LIKE ? OR jo.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM assembly_builds ab
       JOIN job_orders jo ON jo.id = ab.job_order_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT ab.id, ab.ab_no, ab.date_created, ab.quantity_built, ab.status,
              jo.job_order_no, jo.description AS job_desc, loc.location_name AS job_location_name,
              jt.display_name AS job_type_name, c.id AS customer_id, c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name
       ${baseFrom} ${whereSql}
       ORDER BY ab.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ab]] = await pool.query(
      `SELECT ab.*, jo.job_order_no, jo.description AS job_desc, jo.quantity, jo.units, jo.quantity_inspected,
              jo.length, jo.width, jo.height, jo.memo AS jo_memo,
              jo.job_location_id,
              loc.location_name AS job_location_name, jt.display_name AS job_type_name, jt.asset_account_id AS fg_account_id,
              c.id AS customer_id, c.name AS customer_name, cc.contact_name,
              so.contact_email, so.contact_title, so.contact_phone,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(cu.first_name, ' ', cu.last_name) AS created_by_name
       FROM assembly_builds ab
       JOIN job_orders jo ON jo.id = ab.job_order_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN users cbu ON cbu.id = ab.created_by_user_id
       LEFT JOIN employees cu ON cu.id = cbu.employee_id
       WHERE ab.id = ?`,
      [req.params.id]
    );
    if (!ab) return res.status(404).json({ error: 'Not found' });
    // Out of this user's department -- 404 rather than 403, matching the JO detail views.
    if (!isJobLocationVisible(ab, await getJobLocationScope(req.user.id, ROUTE))) {
      return res.status(404).json({ error: 'Not found' });
    }

    const [processes] = await pool.query(
      `SELECT abl.*, pr.process_name, i.display_name AS item_name, i.asset_account_id AS item_asset_account_id, loc.location_name
       FROM assembly_build_lines abl
       LEFT JOIN processes pr ON pr.id = abl.process_id
       LEFT JOIN inventories i ON i.id = abl.item_id
       LEFT JOIN locations loc ON loc.id = abl.location_id
       WHERE abl.assembly_build_id = ?
       ORDER BY abl.id`,
      [req.params.id]
    );

    const glImpact = await computeGlImpact(pool, ab, processes);
    res.json({ ...ab, processes, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'AssemblyBuild' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Editing a saved build (asked 2026-10-09): its Date, Memo and Quantity Built. A new quantity rescales
// every line by the same factor -- each line consumed (its JO process Total / JO Qty) x Qty Built when
// it was saved -- and moves on-hand, the process lines' Total Built and the JO's Qty Built by the
// difference, exactly as building or cancelling that difference would. The stock card and GL Impact
// read the lines, so they follow.
//
// Refused: a cancelled build; more than the JO can still build (the same Available Qty to Build the
// Production screen offers); less than this build has already been inspected for; material short
// for an increase; a date in a locked period (old or new).
const isIsoDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ab]] = await conn.query(
      `SELECT ab.*, jo.quantity AS jo_qty, jo.quantity_built AS jo_built, jo.quantity_inspected AS jo_inspected,
              jo.production_stage, jo.job_location_id
         FROM assembly_builds ab JOIN job_orders jo ON jo.id = ab.job_order_id WHERE ab.id = ?`, [req.params.id]);
    if (!ab) return res.status(404).json({ error: 'Not found' });
    if (!isJobLocationVisible(ab, await getJobLocationScope(req.user.id, ROUTE))) return res.status(404).json({ error: 'Not found' });
    if (ab.status === 'cancelled') return res.status(409).json({ error: 'A cancelled Assembly Build cannot be edited.' });

    const oldQty = Number(ab.quantity_built || 0);
    const newQty = req.body.quantity_built === undefined || req.body.quantity_built === '' ? oldQty : Number(req.body.quantity_built);
    if (!Number.isFinite(newQty) || newQty <= 0) return res.status(400).json({ error: 'Enter a Quantity Built greater than 0.' });
    const oldDate = dayOf(ab.date_created);
    const newDate = req.body.date_created ? String(req.body.date_created).slice(0, 10) : oldDate;
    if (!isIsoDay(newDate)) return res.status(400).json({ error: 'Enter a valid date.' });
    const newMemo = req.body.memo === undefined ? ab.memo : (String(req.body.memo || '').trim().slice(0, 2000) || null);

    if (newDate !== oldDate || newQty !== oldQty) {
      await assertPeriodOpen(oldDate, 'non_gl', conn);
      if (newDate !== oldDate) await assertPeriodOpen(newDate, 'non_gl', conn);
    }

    const delta = newQty - oldQty;
    const jobQty = Number(ab.jo_qty || 0);
    if (delta !== 0) {
      // Not below what has already been inspected -- on this build, or on the JO as a whole.
      const inspectedHere = Number(ab.passed_qty || 0) + Number(ab.rma_qty || 0);
      if (newQty < inspectedHere) return res.status(409).json({ error: `This build has already been inspected for ${inspectedHere}; Quantity Built cannot go below that.` });
      if (Number(ab.jo_built || 0) + delta < Number(ab.jo_inspected || 0)) {
        return res.status(409).json({ error: `The Job Order has ${Number(ab.jo_inspected)} inspected; its Qty Built cannot go below that.` });
      }
      if (delta > 0) {
        // The same Available Qty to Build the Production screen works out.
        const [procs] = await conn.query(
          `SELECT jop.id, jop.total, jop.total_completed, pr.process_name, pr.process_code
             FROM job_order_processes jop LEFT JOIN processes pr ON pr.id = jop.process_id WHERE jop.job_order_id = ?`, [ab.job_order_id]);
        const inProduction = !!ab.production_stage && ab.production_stage !== 'for_revision';
        const isFilePrep = (x) => {
          const name = String(x.process_name || '').trim().toUpperCase(); const code = String(x.process_code || '').trim().toUpperCase();
          return name.startsWith('FILE PREPARATION') || name.startsWith('LAYOUT') || code.startsWith('LYT-');
        };
        const fractions = procs.map((x) => ((inProduction && isFilePrep(x)) ? 1 : Number(x.total) > 0 ? Number(x.total_completed) / Number(x.total) : 1));
        const minFraction = fractions.length ? Math.min(...fractions) : 0;
        const available = Math.max(Math.floor(minFraction * jobQty) - Number(ab.jo_built || 0), 0);
        if (delta > available) return res.status(409).json({ error: `Only ${available} more can be built on this Job Order (Available Qty to Build).` });
      }
    }

    const [lines] = await conn.query(
      `SELECT abl.id, abl.job_order_process_id, abl.item_id, abl.location_id, abl.total_qty_to_build, i.display_name AS item_name, i.item_type
         FROM assembly_build_lines abl LEFT JOIN inventories i ON i.id = abl.item_id WHERE abl.assembly_build_id = ?`, [ab.id]);
    const moves = lines.map((l) => {
      const oldTotal = Number(l.total_qty_to_build || 0);
      const newTotal = oldQty ? (oldTotal / oldQty) * newQty : oldTotal;
      return { ...l, newTotal, diff: newTotal - oldTotal, stock: !!(l.item_id && l.location_id), nonStock: isNonStockItem(l.item_type) };
    });
    if (delta > 0) {
      const onHand = await deriveOnHand(conn, moves.filter((m) => m.stock && !m.nonStock).map((m) => m.item_id));
      for (const m of moves) {
        if (!m.stock || m.nonStock || m.diff <= 0) continue;
        const have = Number(onHand.get(`${m.item_id}|${m.location_id}`) || 0);
        if (m.diff > have + 1e-9) return res.status(409).json({ error: `Not enough on hand for ${m.item_name}: need ${m.diff.toFixed(4)} more, only ${have.toFixed(4)} on hand.` });
      }
    }

    await conn.beginTransaction();
    if (delta !== 0) {
      for (const m of moves) {
        await conn.query('UPDATE assembly_build_lines SET total_qty_to_build = ?, total_build = total_build + ? WHERE id = ?',
          [m.newTotal, m.stock ? m.diff : 0, m.id]);
        if (!m.stock) continue;
        if (!m.nonStock) {
          await conn.query('UPDATE inventory_locations SET qty_on_hand = qty_on_hand - ? WHERE inventory_id = ? AND location_id = ?',
            [m.diff, m.item_id, m.location_id]);
        }
        await conn.query('UPDATE job_order_processes SET total_built = total_built + ? WHERE id = ?', [m.diff, m.job_order_process_id]);
      }
      await conn.query('UPDATE job_orders SET quantity_built = quantity_built + ?, updated_at = NOW() WHERE id = ?', [delta, ab.job_order_id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('JobOrder', ?, 'Updated', 'quantity_built', ?, ?, ?)`,
        [ab.job_order_id, String(Number(ab.jo_built || 0)), String(Number(ab.jo_built || 0) + delta), req.user.id]);
    }
    await conn.query('UPDATE assembly_builds SET quantity_built = ?, date_created = ?, memo = ?, updated_at = NOW() WHERE id = ?',
      [newQty, newDate, newMemo, ab.id]);
    const audit = (field, a, b) => logAudit(conn, { assemblyBuildId: ab.id, userId: req.user.id, eventType: 'Updated', fieldName: field, oldValue: a, newValue: b });
    if (delta !== 0) await audit('quantity_built', oldQty, newQty);
    if (newDate !== oldDate) await audit('date_created', oldDate, newDate);
    if ((newMemo || '') !== (ab.memo || '')) await audit('memo', ab.memo, newMemo);
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM assembly_builds WHERE id = ?', [ab.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Reverses the build: adds the deducted material back to on-hand and subtracts what
// this transaction contributed from each process line's Total Built and the JO's
// overall Qty Built. Can't be reversed twice.
router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ab]] = await conn.query('SELECT status, job_order_id, quantity_built, date_created FROM assembly_builds WHERE id = ?', [req.params.id]);
    if (!ab) { return res.status(404).json({ error: 'Not found' }); }
    if (ab.status === 'cancelled') { return res.status(409).json({ error: 'This Assembly Build is already cancelled.' }); }
    // Cancelling puts the consumed material back and unwinds the built qty -- a stock
    // movement dated in the original build's period, so the same lock applies.
    await assertPeriodOpen(ab.date_created, 'non_gl', conn);

    const [lines] = await conn.query(
      'SELECT job_order_process_id, item_id, location_id, total_qty_to_build FROM assembly_build_lines WHERE assembly_build_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.item_id && l.location_id) {
        await conn.query(
          'UPDATE inventory_locations SET qty_on_hand = qty_on_hand + ? WHERE inventory_id = ? AND location_id = ?',
          [l.total_qty_to_build, l.item_id, l.location_id]
        );
        await conn.query('UPDATE job_order_processes SET total_built = total_built - ? WHERE id = ?', [l.total_qty_to_build, l.job_order_process_id]);
      }
    }
    await conn.query('UPDATE job_orders SET quantity_built = quantity_built - ?, updated_at = NOW() WHERE id = ?', [ab.quantity_built, ab.job_order_id]);
    await conn.query(
      "UPDATE assembly_builds SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { assemblyBuildId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'saved', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM assembly_builds WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
