const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/production';

// Mirrors the real system's "Production > Production" ("Saved Job Order Stages")
// screen's 8 tab stages -- "Hold" is a 9th tab there but is handled as a cross-cutting
// is_on_hold filter here, matching how Hold/Resume already work elsewhere in this JO
// module rather than being its own production_stage value.
const STAGE_VALUES = [
  'pending_for_scheduling', 'for_revision', 'in_process_with_revision', 'in_process',
  'for_qi', 'partially_completed', 'completed', 'invoiced',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      stage, hold, search, sales_rep_id: salesRepId, job_location_id: jobLocationId, customer_id: customerId,
    } = req.query;

    const commonWhere = ['jo.production_stage IS NOT NULL'];
    const commonParams = [];
    if (salesRepId) { commonWhere.push('so.sales_rep_id = ?'); commonParams.push(salesRepId); }
    if (jobLocationId) { commonWhere.push('jo.job_location_id = ?'); commonParams.push(jobLocationId); }
    if (customerId) { commonWhere.push('so.customer_id = ?'); commonParams.push(customerId); }
    if (search) {
      commonWhere.push('(jo.job_order_no LIKE ? OR so.sales_order_no LIKE ? OR c.name LIKE ? OR jo.description LIKE ?)');
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = [...commonWhere];
    const params = [...commonParams];
    if (hold === '1') {
      where.push('jo.is_on_hold = 1');
    } else if (stage && STAGE_VALUES.includes(stage)) {
      where.push('jo.production_stage = ?');
      where.push('jo.is_on_hold = 0');
      params.push(stage);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const baseFrom = `FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees ar ON ar.id = jo.artist_id`;

    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.created_at, jo.date_forwarded,
              jo.quantity, jo.quantity_built, jo.units, jo.delivery_date, jo.delivery_time,
              jo.production_stage, jo.is_on_hold,
              so.sales_order_no, c.name AS customer_name, jt.display_name AS job_type_name,
              loc.location_name AS job_location_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
       ${baseFrom} ${whereSql}
       ORDER BY jo.date_forwarded DESC`,
      params
    );

    const [countRows] = await pool.query(
      `SELECT jo.production_stage, jo.is_on_hold, COUNT(*) AS count ${baseFrom} WHERE ${commonWhere.join(' AND ')}
       GROUP BY jo.production_stage, jo.is_on_hold`,
      commonParams
    );
    const counts = Object.fromEntries(STAGE_VALUES.map((s) => [s, 0]));
    counts.hold = 0;
    countRows.forEach((r) => {
      if (r.is_on_hold) { counts.hold += r.count; return; }
      if (counts[r.production_stage] !== undefined) counts[r.production_stage] = r.count;
    });

    res.json({ rows, counts });
  } catch (err) {
    next(err);
  }
});

// The Production module's own JO detail view -- same underlying job_orders /
// job_order_processes rows as the Sales-side Job Order view, but with the wider
// production-floor Processes column set (On Hand/Committed read live from
// inventory_locations, Total Built/Total Completed/Back Order, Sales vs Production
// Remarks) and no Design/Sales-approval action buttons (those only apply pre-Release).
router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[jo]] = await pool.query(
      `SELECT jo.*, so.sales_order_no, so.status AS sales_order_status, so.office_location_id, so.sales_division_id,
              sol.subtotal AS line_subtotal, sol.disc_amount AS line_disc_amount,
              c.name AS customer_name, cc.contact_name,
              jt.display_name AS job_type_name, loc.location_name AS job_location_name,
              oloc.location_name AS office_location_name, sd.name AS sales_division_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
              ljt.display_name AS layout_job_type_name
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations loc ON loc.id = jo.job_location_id
       LEFT JOIN locations oloc ON oloc.id = so.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN employees sr ON sr.id = jo.sales_rep_id
       LEFT JOIN employees ar ON ar.id = jo.artist_id
       LEFT JOIN pms_job_types ljt ON ljt.id = jo.layout_job_type_id
       WHERE jo.id = ?`,
      [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });

    // Back Order is a materials-shortage figure, not a production-progress one: it's how
    // much of this line's total material requirement (qty x area, already summed into
    // `total`) isn't covered by what's currently on hand at the line's location -- e.g.
    // needing 300 sqft with only 200 sqft on hand leaves a back order of 100. Floored at
    // 0 so having enough (or excess) stock never shows a negative back order.
    // A process line doesn't always carry its own location_id (e.g. imported/edited
    // without one) -- COALESCE to the JO's own job_location_id so a missing location
    // doesn't read as a false "0 on hand everywhere" shortage.
    const [processes] = await pool.query(
      `SELECT jop.*, pr.process_name, pr.minutes_per_unit, i.display_name AS item_name, loc.location_name,
              il.qty_on_hand AS on_hand, il.qty_committed AS committed,
              GREATEST(COALESCE(jop.total, 0) - COALESCE(il.qty_on_hand, 0), 0) AS back_order,
              COALESCE(jop.total, 0) * COALESCE(pr.minutes_per_unit, 0) AS allotted_minutes
       FROM job_order_processes jop
       LEFT JOIN job_orders parent_jo ON parent_jo.id = jop.job_order_id
       LEFT JOIN processes pr ON pr.id = jop.process_id
       LEFT JOIN inventories i ON i.id = jop.item_id
       LEFT JOIN locations loc ON loc.id = COALESCE(jop.location_id, parent_jo.job_location_id)
       LEFT JOIN inventory_locations il ON il.inventory_id = jop.item_id AND il.location_id = COALESCE(jop.location_id, parent_jo.job_location_id)
       WHERE jop.job_order_id = ? ORDER BY jop.line_no`,
      [req.params.id]
    );

    // Every Assembly Build transaction saved against this JO -- surfaced on the Related
    // Records tab alongside the originating Sales Order.
    const [assemblyBuilds] = await pool.query(
      `SELECT id, ab_no, date_created, quantity_built, passed_qty, rma_qty, status
       FROM assembly_builds WHERE job_order_id = ? ORDER BY id DESC`,
      [req.params.id]
    );

    res.json({ ...jo, processes, assembly_builds: assemblyBuilds });
  } catch (err) {
    next(err);
  }
});

// Records production output against a process line's material requirement -- mirrors
// the real system's "Completed" progress-bar modal: the amount entered is added on top
// of whatever's already completed (not a replacement). Rejected outright (not silently
// clamped) if it would push the running total past the line's total material
// requirement (`total`) or past what's actually on hand -- you can never mark more
// completed than what the job actually needs or than what's physically in stock.
router.put('/:id/processes/:processId/complete', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[proc]] = await pool.query(
      `SELECT jop.total, jop.total_completed, jop.item_id, jop.location_id, il.qty_on_hand AS on_hand
       FROM job_order_processes jop
       LEFT JOIN job_orders parent_jo ON parent_jo.id = jop.job_order_id
       LEFT JOIN inventory_locations il ON il.inventory_id = jop.item_id AND il.location_id = COALESCE(jop.location_id, parent_jo.job_location_id)
       WHERE jop.id = ? AND jop.job_order_id = ?`,
      [req.params.processId, req.params.id]
    );
    if (!proc) return res.status(404).json({ error: 'Not found' });

    const amount = Number(req.body.amount || 0);
    if (amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });

    const total = Number(proc.total || 0);
    const onHand = Number(proc.on_hand || 0);
    const current = Number(proc.total_completed || 0);
    const remaining = total - current;

    if (amount > remaining) {
      return res.status(400).json({ error: `Amount exceeds the remaining total needed (${remaining}).` });
    }
    if (amount > onHand) {
      return res.status(400).json({ error: `Amount exceeds what's on hand (${onHand}).` });
    }

    const newCompleted = current + amount;
    await pool.query('UPDATE job_order_processes SET total_completed = ? WHERE id = ?', [newCompleted, req.params.processId]);
    res.json({ total_completed: newCompleted });
  } catch (err) {
    next(err);
  }
});

// Converts tracked production progress (Total Completed) into finished-good Built qty,
// deducting the raw materials actually consumed from on-hand inventory. Available Qty
// to Build is gated by whichever process line is furthest behind: each line's
// completion fraction (total_completed / total) caps how many whole JO units can be
// built, since a unit isn't really done until every one of its processes is. Lines with
// no material tracked (total <= 0) don't gate anything. Validates every material line
// has enough on hand for the FULL requested build qty before writing anything -- never
// partially deduct and never let on-hand go negative.
// Saving doesn't just mutate the JO in place -- it creates its own persisted
// "AB-{id}" transaction (assembly_builds + assembly_build_lines, mirroring the real
// system's Production > Assembly Build module), linked back to this JO so it shows up
// in the JO's Related Records tab. Every process line is snapshotted into the
// transaction (not just material lines), matching the real screenshot showing a
// labor-only "Layout Fee" line alongside material lines.
router.put('/:id/assembly-build', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT quantity, quantity_built, production_stage, job_location_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });

    const jobQty = Number(jo.quantity || 0);
    if (jobQty <= 0) return res.status(409).json({ error: 'This Job Order has no quantity to build against.' });

    // A process line doesn't always carry its own location_id -- COALESCE to the JO's
    // own job_location_id, same fallback as the on-hand/back-order figures above,
    // so a line missing one isn't silently treated as needing no material at all.
    const [processes] = await conn.query(
      `SELECT jop.id, jop.process_id, jop.category, jop.parts, jop.item_id,
              COALESCE(jop.location_id, ?) AS location_id,
              jop.process_qty, jop.qty, jop.total, jop.total_completed, jop.total_built, jop.unit,
              jop.process_cost, jop.material_cost, jop.total_cost,
              il.qty_on_hand, i.display_name AS item_name
       FROM job_order_processes jop
       LEFT JOIN inventory_locations il ON il.inventory_id = jop.item_id AND il.location_id = COALESCE(jop.location_id, ?)
       LEFT JOIN inventories i ON i.id = jop.item_id
       WHERE jop.job_order_id = ?`,
      [jo.job_location_id, jo.job_location_id, req.params.id]
    );

    const fractions = processes.map((p) => (Number(p.total) > 0 ? Number(p.total_completed) / Number(p.total) : 1));
    const minFraction = fractions.length ? Math.min(...fractions) : 0;
    const currentBuilt = Number(jo.quantity_built || 0);
    const availableQtyToBuild = Math.max(Math.floor(minFraction * jobQty) - currentBuilt, 0);

    const quantityToBuild = Number(req.body.quantity_to_build || 0);
    if (quantityToBuild <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
    if (quantityToBuild > availableQtyToBuild) {
      return res.status(409).json({ error: `Quantity to Build exceeds the Available Qty to Build (${availableQtyToBuild}).` });
    }

    const lines = processes.map((p) => {
      const totalQtyToBuild = (Number(p.total || 0) / jobQty) * quantityToBuild;
      const required = p.item_id && p.location_id ? totalQtyToBuild : 0;
      return { ...p, totalQtyToBuild, required };
    });
    for (const l of lines) {
      if (!l.required) continue;
      const onHand = Number(l.qty_on_hand || 0);
      if (l.required > onHand) {
        return res.status(409).json({ error: `Not enough on hand for ${l.item_name}: need ${l.required.toFixed(4)}, only ${onHand.toFixed(4)} on hand.` });
      }
    }

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.required) {
        await conn.query(
          'UPDATE inventory_locations SET qty_on_hand = qty_on_hand - ? WHERE inventory_id = ? AND location_id = ?',
          [l.required, l.item_id, l.location_id]
        );
        await conn.query('UPDATE job_order_processes SET total_built = total_built + ? WHERE id = ?', [l.required, l.id]);
      }
    }
    const newQuantityBuilt = currentBuilt + quantityToBuild;
    await conn.query(
      "UPDATE job_orders SET quantity_built = ?, production_stage = 'for_qi', updated_at = NOW() WHERE id = ?",
      [newQuantityBuilt, req.params.id]
    );
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'quantity_built', ?, ?, ?)`,
      [req.params.id, String(currentBuilt), String(newQuantityBuilt), req.user.id]
    );
    // Every batch built needs its own inspection -- so a build always pushes the stage
    // back to "For QI", even if an earlier batch on this same JO already cleared it.
    if (jo.production_stage !== 'for_qi') {
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('JobOrder', ?, 'Updated', 'production_stage', ?, 'for_qi', ?)`,
        [req.params.id, jo.production_stage, req.user.id]
      );
    }

    const totalAmount = lines.reduce((s, l) => s + Number(l.process_cost || 0) + Number(l.material_cost || 0), 0);
    const [abResult] = await conn.query(
      `INSERT INTO assembly_builds (ab_no, job_order_id, date_created, quantity_built, total_amount, created_by_user_id)
       VALUES ('', ?, CURDATE(), ?, ?, ?)`,
      [req.params.id, quantityToBuild, totalAmount, req.user.id]
    );
    const abId = abResult.insertId;
    await conn.query('UPDATE assembly_builds SET ab_no = ? WHERE id = ?', [`AB-${abId}`, abId]);
    for (const l of lines) {
      await conn.query(
        `INSERT INTO assembly_build_lines
           (assembly_build_id, job_order_process_id, process_id, item_id, location_id, category, parts,
            process_qty, qty, qty_rwip, total_qty_to_build, total_completed, total_build, unit,
            process_cost, material_cost, total_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [abId, l.id, l.process_id, l.item_id, l.location_id, l.category, l.parts,
          l.process_qty, l.qty, l.totalQtyToBuild, l.total_completed, Number(l.total_built || 0) + l.required, l.unit,
          l.process_cost, l.material_cost, l.total_cost]
      );
    }
    await conn.commit();

    res.json({ quantity_built: newQuantityBuilt, assembly_build_id: abId });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
