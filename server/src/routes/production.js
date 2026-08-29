const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { isNonStockItem } = require('../lib/itemTypes');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { getJobLocationScope, isJobLocationVisible } = require('../lib/jobLocationVisibility');
const { deriveOnHand } = require('../lib/stockLedger');
const { maySalesReviseJobOrder } = require('../lib/jobOrderRevision');
const { PLANNER_COLUMNS, isPlanner } = require('../lib/plannerRoles');

// Completing a process and building both move stock dated today (the Assembly Build row
// is inserted with CURDATE()), so today's period is what has to be open for them.
const today = () => new Date().toISOString().slice(0, 10);

const router = express.Router();
const ROUTE = '/production';

// The floor roles below (the department planners, Production Supervisor) carry their capability
// as a per-user tag rather than as a /production permission row, and a capability on a screen the
// holder cannot open is no capability at all -- a planner has no /production row whatsoever.
// So reading this module follows the same rule its writes do. It widens nothing else: the
// department warehouse filter on the list, and assertJobOrderInScope on the detail, both still
// apply, so a Signage planner reads Signage's work and a DPOD planner DPOD's.
async function requireProductionView(req, res, next) {
  try {
    const [[u]] = await pool.query(
      `SELECT ${PLANNER_COLUMNS}, is_production_supervisor FROM users WHERE id = ?`, [req.user.id]
    );
    if (isPlanner(u) || u?.is_production_supervisor) return next();
    return requirePermission(ROUTE, 'can_view')(req, res, next);
  } catch (err) { return next(err); }
}

// Mirrors the real system's "Production > Production" ("Saved Job Order Stages")
// screen's 8 tab stages -- "Hold" is a 9th tab there but is handled as a cross-cutting
// is_on_hold filter here, matching how Hold/Resume already work elsewhere in this JO
// module rather than being its own production_stage value.
const STAGE_VALUES = [
  'pending_for_scheduling', 'for_revision', 'in_process_with_revision', 'in_process',
  'for_qi', 'partially_completed', 'completed', 'invoiced',
];

// Every write in this module is reachable by id whether or not the job order shows on this
// user's list, so each one re-asks the question the list already asked -- otherwise hiding a
// job order is decoration and an out-of-department user can still schedule, build or rework it
// by pasting an id. Answers 404 and returns false when it refuses, matching the detail view;
// callers do `if (!(await assertJobOrderInScope(req, res))) return;`.
async function assertJobOrderInScope(req, res) {
  const scopeLocationId = await getJobLocationScope(req.user.id);
  if (!scopeLocationId) return true;
  const [[row]] = await pool.query('SELECT job_location_id FROM job_orders WHERE id = ?', [req.params.id]);
  if (row && isJobLocationVisible(row, scopeLocationId)) return true;
  res.status(404).json({ error: 'Not found' });
  return false;
}

router.get('/', requireAuth, requireProductionView, async (req, res, next) => {
  try {
    const {
      stage, hold, search, sales_rep_id: salesRepId, job_location_id: jobLocationId, customer_id: customerId,
    } = req.query;

    const commonWhere = ['jo.production_stage IS NOT NULL'];
    const commonParams = [];

    // A production department only sees its own warehouse's work. Applied to commonWhere rather
    // than to `where`, so the stage tab counts are taken over the same rows the listing shows -- a
    // signage user must not read "For QI 14" and then open the tab to three job orders.
    // "Its own warehouse's work" is not the same as "the job orders FILED there". A job order
    // routinely carries lines worked somewhere else -- 27,333 carry a Design line filed under a
    // different warehouse, 5,055 an LFP one, 940 a SIGN one -- and matching on the filing alone
    // hid every one of those from the department actually doing that part of the job. An LFP user
    // could staff and schedule their LFP line on a SIGN job order from Scheduled JO, which has
    // always read it this way, yet could not find that job on the floor view it belongs to: not in
    // any stage tab, not by search, not by pasting the URL.
    //
    // So a job order is visible here if it is filed at this warehouse OR carries a line worked at
    // it. READ only -- nothing about what they may do changes. can_complete below stays per line,
    // and assertJobOrderInScope still holds the job-level writes (planned dates, acknowledge,
    // build, hold, rework) to the warehouse the job order is filed under.
    // Written as a join against a UNION of the two visible id sets rather than the
    // `job_location_id = ? OR EXISTS (...)` it reads as, purely for speed: the OR defeats every
    // index on job_orders and forces a full scan (123,571 rows), which measured 3.4x slower than
    // this and ~12x slower than the old department-only filter. Each branch of the UNION uses its
    // own index instead, and UNION (not UNION ALL) dedupes, so a job order both filed here AND
    // carrying a line here still joins to exactly one row.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    const visibleJoin = scopeLocationId
      ? `JOIN (SELECT id FROM job_orders WHERE job_location_id = ?
               UNION
               SELECT job_order_id FROM job_order_processes WHERE location_id = ?) vis ON vis.id = jo.id`
      : '';
    // The join sits in the FROM clause, ahead of every WHERE placeholder, so its parameters have
    // to lead both queries below.
    const visibleParams = scopeLocationId ? [scopeLocationId, scopeLocationId] : [];
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
       ${visibleJoin}
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
      [...visibleParams, ...params]
    );

    // The tab counts select nothing but two job_orders columns, so they carry only the joins their
    // own filters actually reference -- sales_orders for the sales-rep/customer filters and the
    // search, customers for the search, and nothing else. Dragging job_types, locations and two
    // copies of employees through a GROUP BY that never reads them measured 770ms against 137ms.
    const needsSo = !!(salesRepId || customerId || search);
    const countFrom = `FROM job_orders jo
       ${visibleJoin}
       ${needsSo ? 'LEFT JOIN sales_orders so ON so.id = jo.sales_order_id' : ''}
       ${search ? 'LEFT JOIN customers c ON c.id = so.customer_id' : ''}`;

    const [countRows] = await pool.query(
      `SELECT jo.production_stage, jo.is_on_hold, COUNT(*) AS count ${countFrom} WHERE ${commonWhere.join(' AND ')}
       GROUP BY jo.production_stage, jo.is_on_hold`,
      [...visibleParams, ...commonParams]
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
router.get('/:id', requireAuth, requireProductionView, async (req, res, next) => {
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
    // Out of this user's department: 404 rather than 403, so a job order they may not see reads as
    // one that isn't there rather than one worth going looking for. Same widened test the list
    // above applies -- a job carrying a line worked here is reachable, or the row the list now
    // shows would 404 on being opened.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    if (scopeLocationId && !isJobLocationVisible(jo, scopeLocationId)) {
      const [[lineHere]] = await pool.query(
        'SELECT 1 AS ok FROM job_order_processes WHERE job_order_id = ? AND location_id = ? LIMIT 1',
        [req.params.id, scopeLocationId]
      );
      if (!lineHere) return res.status(404).json({ error: 'Not found' });
    }

    // Back Order is a materials-shortage figure, not a production-progress one: it's how
    // much of this line's total material requirement (qty x area, already summed into
    // `total`) isn't covered by what's currently on hand at the line's location -- e.g.
    // needing 300 sqft with only 200 sqft on hand leaves a back order of 100. Floored at
    // 0 so having enough (or excess) stock never shows a negative back order.
    // A process line doesn't always carry its own location_id (e.g. imported/edited
    // without one) -- COALESCE to the JO's own job_location_id so a missing location
    // doesn't read as a false "0 on hand everywhere" shortage.
    const [processes] = await pool.query(
      `SELECT jop.*, pr.process_name, pr.minutes_per_unit, i.display_name AS item_name, i.item_type, loc.location_name,
              il.qty_committed AS committed,
              COALESCE(jop.total, 0) * COALESCE(pr.minutes_per_unit, 0) AS allotted_minutes,
              -- Where this line is actually worked. Same COALESCE the location_name and on-hand
              -- joins below use, so a line carrying no location of its own is treated as sitting
              -- in its job order's warehouse rather than nowhere.
              COALESCE(jop.location_id, parent_jo.job_location_id) AS effective_location_id
       FROM job_order_processes jop
       LEFT JOIN job_orders parent_jo ON parent_jo.id = jop.job_order_id
       LEFT JOIN processes pr ON pr.id = jop.process_id
       LEFT JOIN inventories i ON i.id = jop.item_id
       LEFT JOIN locations loc ON loc.id = COALESCE(jop.location_id, parent_jo.job_location_id)
       LEFT JOIN inventory_locations il ON il.inventory_id = jop.item_id AND il.location_id = COALESCE(jop.location_id, parent_jo.job_location_id)
       WHERE jop.job_order_id = ? ORDER BY jop.line_no`,
      [req.params.id]
    );

    // On Hand is the running total of the item's movements at this line's warehouse -- the same
    // rows, summed, that the Bin Card lists one by one, so the two screens cannot quote different
    // stock for the same item. It used to read inventory_locations, a snapshot the year
    // migrations never populated, which left almost every line reading 0.0000 and therefore
    // short by its full requirement while the Bin Card plainly showed stock.
    //
    // Service items are left out of the aggregate entirely, not just blanked afterwards. They
    // have no shelf, so their total is meaningless -- and SERVICE LABOR is a single shared item
    // sitting on a large share of all 433,850 assembly build lines, so including it makes the
    // item_id index useless and MySQL scans that whole table: measured 2.5s a job order against
    // ~200ms without it. Nothing is lost, since the loop below blanks them regardless.
    const onHandByPair = await deriveOnHand(pool, processes.filter((p) => !isNonStockItem(p.item_type)).map((p) => p.item_id));
    for (const p of processes) {
      p.on_hand = p.item_id && p.effective_location_id
        ? (onHandByPair.get(`${p.item_id}|${p.effective_location_id}`) ?? 0)
        : null;
      // Back Order is the part of this line's requirement the on-hand does not cover. Floored at
      // 0 so having enough (or excess) never reads as a negative shortage -- though the on-hand
      // it is measured against can itself be negative where the movement history is incomplete,
      // in which case the shortage is the whole requirement and then some.
      p.back_order = Math.max(Number(p.total || 0) - Number(p.on_hand || 0), 0);
    }

    // A Service line (SERVICE LABOR and the like) consumes no material, so the shortage
    // arithmetic above is meaningless for it: it moves no stock, so it has no movements to sum
    // and always reads as short by its full requirement, which then offers a Create TO for
    // labor. Zeroed here rather than in the SQL so lib/itemTypes.js stays the single definition
    // of what counts as non-stock.
    for (const p of processes) {
      if (!isNonStockItem(p.item_type)) continue;
      p.back_order = 0;
      // And no on-hand either. SERVICE LABOR is one shared item that appears on assembly build
      // lines across the whole catalogue, so summing its movements produces a large negative
      // number that means nothing -- a service has no shelf. Null, the same as before this
      // column was derived, so the screen keeps printing an em dash for it.
      p.on_hand = null;
    }

    // can_complete says whether THIS user may record output on THIS line. A line worked at
    // another warehouse is that department's to complete -- it stays visible with its figures,
    // because the whole job has to be readable, but its Completed control is locked.
    for (const p of processes) {
      p.can_complete = !scopeLocationId || Number(p.effective_location_id) === Number(scopeLocationId);
    }

    // Every Assembly Build transaction saved against this JO -- surfaced on the Related
    // Records tab alongside the originating Sales Order.
    const [assemblyBuilds] = await pool.query(
      `SELECT id, ab_no, date_created, quantity_built, passed_qty, rma_qty, status
       FROM assembly_builds WHERE job_order_id = ? ORDER BY id DESC`,
      [req.params.id]
    );

    // RWIP (rework) job orders raised off this JO -- shown on the RWIP JO tab. `open_rwip_count`
    // is how many aren't finished yet: the mother JO can't be built until they all complete.
    const [rwips] = await pool.query(
      `SELECT id, job_order_no, created_at, quantity, units, status, production_stage
       FROM job_orders WHERE parent_job_order_id = ? ORDER BY id DESC`,
      [req.params.id]
    );
    const openRwipCount = rwips.filter((r) => r.status !== 'Cancelled' && !['completed', 'invoiced'].includes(r.production_stage)).length;

    res.json({ ...jo, processes, assembly_builds: assemblyBuilds, rwips, open_rwip_count: openRwipCount });
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
// ---------------------------------------------------------------------------------------
// Scheduling: planned dates, then Acknowledge
// ---------------------------------------------------------------------------------------
//
// Both live on the production screen rather than the Job Order edit form, because the person
// who schedules a job is looking at the shop floor view, not the sales-side record. Forecast
// is not stored -- it is the span between these two dates, so setting them is what "defines
// the forecast".

// A department planner may schedule without holding can_edit on /production -- that permission
// also carries RWIP and the rest of production's edits, which planning does not need. Anyone who
// genuinely has production edit rights keeps the capability too. Which job orders a planner may
// schedule is bounded by assertJobOrderInScope, i.e. by their department's warehouse.
async function requireScheduler(req, res, next) {
  try {
    const [[u]] = await pool.query(`SELECT ${PLANNER_COLUMNS} FROM users WHERE id = ?`, [req.user.id]);
    if (isPlanner(u)) return next();
    return requirePermission(ROUTE, 'can_edit')(req, res, next);
  } catch (err) { return next(err); }
}

// Who may work the floor: record output on a process line and turn it into an Assembly Build.
// can_edit on /production carries that today, but no production account holds it -- Anne and
// Velbeth are can_view only, and the planner has no /production row at all -- so the two people
// actually doing the work could not do it, while the Assembly Build button was still drawn for
// them off the wrong permission (/job-orders can_edit) and then refused here.
//
// Granting them /production can_edit would also grant RWIP and every other production edit, so
// the floor roles carry their own tags instead, same shape as requireScheduler above. No tag
// widens WHICH job orders they may touch: assembly builds still go through assertJobOrderInScope
// and completion through the per-line location check, so a Signage production supervisor works
// Signage's warehouse and nothing else.
async function requireProductionFloor(req, res, next) {
  try {
    const [[u]] = await pool.query(
      `SELECT ${PLANNER_COLUMNS}, is_production_supervisor FROM users WHERE id = ?`, [req.user.id]
    );
    if (isPlanner(u) || u?.is_production_supervisor) return next();
    return requirePermission(ROUTE, 'can_edit')(req, res, next);
  } catch (err) { return next(err); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = String(v).slice(0, 10);
  return DATE_RE.test(d) ? d : undefined; // undefined = malformed, distinct from a cleared date
}

router.put('/:id/planned-dates', requireAuth, requireScheduler, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const start = parseDate(req.body?.planned_start_date);
    const end = parseDate(req.body?.planned_end_date);
    if (start === undefined || end === undefined) {
      return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
    }
    if (start && end && end < start) {
      return res.status(400).json({ error: 'Planned End cannot be before Planned Start.' });
    }

    const [[jo]] = await conn.query(
      'SELECT planned_start_date, planned_end_date, delivery_date, status FROM job_orders WHERE id = ?', [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await assertJobOrderInScope(req, res))) return;
    if (jo.status === 'Cancelled') return res.status(409).json({ error: 'This job order is cancelled.' });
    // The delivery date is the promise Sales made to the customer. A plan that starts or ends
    // after it is a plan to deliver late, agreed with nobody -- so it is refused here rather
    // than discovered on the delivery date. A job order with no delivery date on it constrains
    // nothing (plenty of migrated ones have none), and clearing a planned date is always fine.
    const deliveryDay = jo.delivery_date ? String(jo.delivery_date).slice(0, 10) : null;
    if (deliveryDay) {
      const late = [['Planned Start', start], ['Planned End', end]].find(([, d]) => d && d > deliveryDay);
      if (late) {
        return res.status(400).json({ error: `${late[0]} cannot be later than the Delivery Date (${deliveryDay}).` });
      }
    }

    await conn.beginTransaction();
    await conn.query(
      'UPDATE job_orders SET planned_start_date = ?, planned_end_date = ?, updated_at = NOW() WHERE id = ?',
      [start, end, req.params.id]
    );
    const asDay = (v) => (v ? String(v).slice(0, 10) : '');
    for (const [field, before, after] of [
      ['planned_start_date', asDay(jo.planned_start_date), start || ''],
      ['planned_end_date', asDay(jo.planned_end_date), end || ''],
    ]) {
      if (before === after) continue;
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('JobOrder', ?, 'Updated', ?, ?, ?, ?)`,
        [req.params.id, field, before, after, req.user.id]
      );
    }
    await conn.commit();
    res.json({ planned_start_date: start, planned_end_date: end });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Acknowledge: the scheduler accepts the forecast and the job moves onto the floor.
router.put('/:id/acknowledge', requireAuth, requireScheduler, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query(
      'SELECT planned_start_date, planned_end_date, production_stage, is_on_hold, status FROM job_orders WHERE id = ?',
      [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await assertJobOrderInScope(req, res))) return;
    if (!jo.planned_start_date || !jo.planned_end_date) {
      return res.status(400).json({ error: 'Set Planned Start and Planned End before acknowledging.' });
    }
    if (jo.is_on_hold) return res.status(409).json({ error: 'This job order is on hold. Resume it before acknowledging.' });
    // Only from scheduling. Acknowledging a job already building, inspected or invoiced would
    // walk its stage backwards and lose the progress those stages represent.
    if (jo.production_stage !== 'pending_for_scheduling') {
      return res.status(409).json({ error: 'Only a job order pending scheduling can be acknowledged.' });
    }

    await conn.beginTransaction();
    await conn.query(
      "UPDATE job_orders SET production_stage = 'in_process', updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'production_stage', ?, 'in_process', ?)`,
      [req.params.id, jo.production_stage, req.user.id]
    );
    await conn.commit();
    res.json({ production_stage: 'in_process' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------------------
// The Sales revision loop
// ---------------------------------------------------------------------------------------
//
// 'for_revision' has been one of this module's eight stages from the start -- it has a tab on
// the Production list, a label on every JO view, a filter on the Job Orders list -- and nothing
// in the build ever set it. Production could see a job order was wrong (wrong quantity, wrong
// spec, a material that will not do what the customer asked) and had no way to say so: the job
// either went ahead wrong or was stopped by walking over to Sales, with nothing recorded.
//
// Sales Revision hands it back. Sales edits the job order -- the generic edit endpoint's
// auto-advance only fires from 'pending_for_scheduling', so a job sitting in revision does not
// jump stage under them -- and Approve to Production returns it to 'pending_for_scheduling',
// where Production acknowledges it as usual. The loop is:
//
//   Released / pending_for_scheduling --Sales Revision--> for_revision
//   --Approve to Production--> pending_for_scheduling --Acknowledge--> in_process
//
// Each direction is gated on the right that names it: sending back needs Production edit
// rights, returning it needs Job Order edit rights (Sales's own).

// Released / Pending for Sched. only -- the window between Sales handing the job over and
// Production accepting it. That is exactly when sending it back costs nothing: no plan has been
// acknowledged, no line has been staffed, no stock has moved. Once it is In-Process the job is
// on the floor, and pulling it back to Sales would walk its stage backwards past work already
// under way; 'in_process_with_revision' is the stage that exists for changing a job at that
// point, and it is a different flow from this one.
router.put('/:id/sales-revision', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query(
      'SELECT production_stage, is_on_hold, status, quantity_built FROM job_orders WHERE id = ?',
      [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await assertJobOrderInScope(req, res))) return;
    if (jo.status === 'Cancelled') return res.status(409).json({ error: 'This job order is cancelled.' });
    if (jo.is_on_hold) return res.status(409).json({ error: 'This job order is on hold. Resume it before sending it for revision.' });
    if (jo.production_stage === 'for_revision') {
      return res.status(409).json({ error: 'This job order is already with Sales for revision.' });
    }
    if (jo.status !== 'Released' || jo.production_stage !== 'pending_for_scheduling') {
      return res.status(409).json({ error: 'Only a Released job order pending scheduling can be sent for revision.' });
    }
    // Belt and braces: a job still pending scheduling should have built nothing, and if one
    // somehow has, it is not a job to hand back for re-specification.
    if (Number(jo.quantity_built || 0) > 0) {
      return res.status(409).json({ error: 'This job order has already built quantity and cannot be sent back for revision.' });
    }

    await conn.beginTransaction();
    await conn.query("UPDATE job_orders SET production_stage = 'for_revision', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'production_stage', ?, 'for_revision', ?)`,
      [req.params.id, jo.production_stage, req.user.id]
    );
    await conn.commit();
    res.json({ production_stage: 'for_revision' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Sales returns it. Back to pending_for_scheduling rather than straight to in_process, because
// the point of the round trip is that Production gets to look at the changed job and acknowledge
// it -- dropping it back on the floor unseen would skip the very step that caught the problem.
// Planned dates are left as they were: they may still be right, and silently clearing a
// scheduler's plan because Sales fixed a typo would be its own surprise.
router.put('/:id/approve-revision', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT production_stage, status, sales_rep_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await assertJobOrderInScope(req, res))) return;
    if (!(await maySalesReviseJobOrder(req.user.id, jo))) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    if (jo.status === 'Cancelled') return res.status(409).json({ error: 'This job order is cancelled.' });
    if (jo.production_stage !== 'for_revision') {
      return res.status(409).json({ error: 'Only a job order for revision can be approved back to production.' });
    }

    await conn.beginTransaction();
    await conn.query("UPDATE job_orders SET production_stage = 'pending_for_scheduling', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', 'production_stage', 'for_revision', 'pending_for_scheduling', ?)`,
      [req.params.id, req.user.id]
    );
    await conn.commit();
    res.json({ production_stage: 'pending_for_scheduling' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/processes/:processId/complete', requireAuth, requireProductionFloor, async (req, res, next) => {
  try {
    const [[proc]] = await pool.query(
      `SELECT jop.total, jop.total_completed, jop.item_id, jop.location_id, i.item_type,
              COALESCE(jop.location_id, parent_jo.job_location_id) AS effective_location_id
       FROM job_order_processes jop
       LEFT JOIN job_orders parent_jo ON parent_jo.id = jop.job_order_id
       LEFT JOIN inventories i ON i.id = jop.item_id
       WHERE jop.id = ? AND jop.job_order_id = ?`,
      [req.params.processId, req.params.id]
    );
    if (!proc) return res.status(404).json({ error: 'Not found' });
    // Completing is per process line, and a line can be worked in a different warehouse from its
    // job order -- a SIGN job routinely carries a Design or an LFP line. So it is the LINE's
    // location that decides, not the job order's. 403 rather than 404 because the line is visible
    // on the Processes table, just not this user's to record output on.
    const scopeLocationId = await getJobLocationScope(req.user.id);
    if (scopeLocationId && Number(proc.effective_location_id) !== Number(scopeLocationId)) {
      return res.status(403).json({ error: 'That process line is worked at another location.' });
    }
    await assertPeriodOpen(today(), 'non_gl');

    const amount = Number(req.body.amount || 0);
    if (amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });

    const total = Number(proc.total || 0);
    // The same figure the Processes tab shows for this line -- a ceiling the user cannot see is
    // one they cannot act on, and the two used to come from different places. Not computed at all
    // for a Service line: the ceiling does not apply to it (see below) and pricing SERVICE LABOR's
    // movements is both meaningless and slow.
    const onHand = isNonStockItem(proc.item_type)
      ? 0
      : Number((await deriveOnHand(pool, [proc.item_id])).get(`${proc.item_id}|${proc.effective_location_id}`) || 0);
    const current = Number(proc.total_completed || 0);
    const remaining = total - current;

    if (amount > remaining) {
      return res.status(400).json({ error: `Amount exceeds the remaining total needed (${remaining}).` });
    }
    // The on-hand ceiling is about not marking material consumed that isn't there --
    // it can't apply to a Service line, which draws down no material at all. Left in
    // place it strands the line at 0% forever (on hand is always 0), and because
    // Available Qty to Build is capped by the least-complete line, one un-completable
    // SERVICE LABOR line blocks the whole Job Order from ever being built.
    if (!isNonStockItem(proc.item_type) && amount > onHand) {
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
router.put('/:id/assembly-build', requireAuth, requireProductionFloor, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT quantity, quantity_built, production_stage, job_location_id FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await assertJobOrderInScope(req, res))) return;
    await assertPeriodOpen(today(), 'non_gl', conn);

    const jobQty = Number(jo.quantity || 0);
    if (jobQty <= 0) return res.status(409).json({ error: 'This Job Order has no quantity to build against.' });

    // A mother JO can't be built while any of its RWIP (rework) job orders is still open --
    // the rework has to finish before the parent is assembled.
    const [[{ open_rwip: openRwip }]] = await conn.query(
      "SELECT COUNT(*) AS open_rwip FROM job_orders WHERE parent_job_order_id = ? AND status <> 'Cancelled' AND (production_stage IS NULL OR production_stage NOT IN ('completed','invoiced'))",
      [req.params.id]
    );
    if (openRwip > 0) return res.status(409).json({ error: 'Complete the RWIP job order(s) before building this Job Order.' });

    // A process line doesn't always carry its own location_id -- COALESCE to the JO's
    // own job_location_id, same fallback as the on-hand/back-order figures above,
    // so a line missing one isn't silently treated as needing no material at all.
    const [processes] = await conn.query(
      `SELECT jop.id, jop.process_id, jop.category, jop.parts, jop.item_id,
              COALESCE(jop.location_id, ?) AS location_id,
              jop.process_qty, jop.qty, jop.total, jop.total_completed, jop.total_built, jop.unit,
              jop.process_cost, jop.material_cost, jop.total_cost,
              i.display_name AS item_name, i.item_type
       FROM job_order_processes jop
       LEFT JOIN inventories i ON i.id = jop.item_id
       WHERE jop.job_order_id = ?`,
      [jo.job_location_id, req.params.id]
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

    // `required` is how much this build consumes off the line; `nonStock` splits that
    // into its two halves for Service lines -- the build still records progress against
    // them (Total Built moves), but there is no material to check for or deduct.
    const lines = processes.map((p) => {
      const totalQtyToBuild = (Number(p.total || 0) / jobQty) * quantityToBuild;
      const required = p.item_id && p.location_id ? totalQtyToBuild : 0;
      return { ...p, totalQtyToBuild, required, nonStock: isNonStockItem(p.item_type) };
    });
    // Checked against the same derived figure the Processes tab shows, so a build is refused for
    // a shortage the user can actually see on screen.
    const buildOnHand = await deriveOnHand(conn, lines.filter((l) => !l.nonStock && l.required).map((l) => l.item_id));
    for (const l of lines) {
      if (!l.required || l.nonStock) continue;
      const onHand = Number(buildOnHand.get(`${l.item_id}|${l.location_id}`) || 0);
      if (l.required > onHand) {
        return res.status(409).json({ error: `Not enough on hand for ${l.item_name}: need ${l.required.toFixed(4)}, only ${onHand.toFixed(4)} on hand.` });
      }
    }

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.required) {
        if (!l.nonStock) {
          await conn.query(
            'UPDATE inventory_locations SET qty_on_hand = qty_on_hand - ? WHERE inventory_id = ? AND location_id = ?',
            [l.required, l.item_id, l.location_id]
          );
        }
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

// ---- RWIP (rework) job orders raised off a mother JO ----
const rwipNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const rwipTrunc = (s, n) => (s == null ? null : String(s).slice(0, n));
const rwipDec = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

async function rwipAudit(conn, jobOrderId, userId, eventType, field, oldV, newV) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('JobOrder', ?, ?, ?, ?, ?, ?)`,
    [jobOrderId, eventType, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), userId]
  );
}

// Draft for the "Create RWIP" modal: the mother JO's header + its processes (pre-filled, editable).
router.get('/:id/rwip-draft', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[jo]] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.quantity, jo.units, jo.length, jo.width, jo.height,
              jo.job_type_id, jt.display_name AS job_type_name, jo.job_location_id, jl.location_name AS job_location_name,
              jo.delivery_date, jo.delivery_time, so.sales_order_no, c.name AS customer_name, cc.contact_name AS contact_person_name,
              jo.contact_phone, oloc.location_name AS office_location_name, sd.name AS sales_division_name,
              CONCAT(sr.first_name,' ',sr.last_name) AS sales_rep_name
       FROM job_orders jo
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       LEFT JOIN locations jl ON jl.id = jo.job_location_id
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN locations oloc ON oloc.id = so.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN employees sr ON sr.id = jo.sales_rep_id
       WHERE jo.id = ?`,
      [req.params.id]
    );
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await assertJobOrderInScope(req, res))) return;
    const [processes] = await pool.query(
      `SELECT jop.line_no, jop.process_id, p.process_name, jop.process_qty, jop.process_uom, jop.category, jop.parts,
              jop.item_id, i.display_name AS item_name, jop.length, jop.width, jop.uom, jop.qty, jop.unit, jop.remarks
       FROM job_order_processes jop
       LEFT JOIN processes p ON p.id = jop.process_id
       LEFT JOIN inventories i ON i.id = jop.item_id
       WHERE jop.job_order_id = ? ORDER BY jop.line_no`,
      [req.params.id]
    );
    res.json({ jo, processes });
  } catch (err) { next(err); }
});

// Create an RWIP job order from a mother JO that's in process. Number RWIP-###, starts in
// "Pending RMA Approval" (production_stage NULL). Reuses the mother's SO + line and copies its
// header; the (edited) processes come from the modal. Only when the mother JO is in process.
router.post('/:id/rwip', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[jo]] = await conn.query('SELECT * FROM job_orders WHERE id = ?', [req.params.id]);
    if (!jo) return res.status(404).json({ error: 'Not found' });
    if (!(await assertJobOrderInScope(req, res))) return;
    if (jo.production_stage !== 'in_process') {
      return res.status(409).json({ error: 'RWIP can only be raised while the Job Order is In-Process.' });
    }
    const { reason_code_id: reasonCodeId, reason, action_to_be_taken: actionTaken, delivery_date: deliveryDate, delivery_time: deliveryTime, processes } = req.body;
    await conn.beginTransaction();
    // RWIP-### -- next number after the highest existing RWIP.
    const [[mx]] = await conn.query(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(job_order_no, 6) AS UNSIGNED)), 0) AS n FROM job_orders WHERE job_order_no LIKE 'RWIP-%'"
    );
    const jobOrderNo = `RWIP-${mx.n + 1}`;
    const [r] = await conn.query(
      `INSERT INTO job_orders (job_order_no, parent_job_order_id, sales_order_id, sales_order_line_id, job_type_id, job_location_id,
         description, quantity, units, length, width, height, memo, contact_email, contact_title, contact_phone, shipping_address,
         sales_rep_id, delivery_date, delivery_time, reason_code_id, reason, action_to_be_taken, production_stage, sub_status, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'Pending RMA Approval')`,
      [jobOrderNo, jo.id, jo.sales_order_id, jo.sales_order_line_id, jo.job_type_id, jo.job_location_id,
       jo.description, rwipNum(jo.quantity), jo.units, jo.length, jo.width, jo.height, jo.memo, jo.contact_email, jo.contact_title,
       jo.contact_phone, jo.shipping_address, jo.sales_rep_id, deliveryDate || jo.delivery_date || null, deliveryTime || jo.delivery_time || null,
       reasonCodeId || null, rwipTrunc(reason, 500), rwipTrunc(actionTaken, 500)]
    );
    const rwipId = r.insertId;
    if (Array.isArray(processes) && processes.length) {
      let ln = 0;
      for (const pr of processes) {
        ln += 1;
        await conn.query(
          `INSERT INTO job_order_processes (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, length, width, uom, qty, unit, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [rwipId, ln, pr.process_id || null, rwipNum(pr.process_qty), rwipTrunc(pr.process_uom, 50), rwipTrunc(pr.category, 100), rwipTrunc(pr.parts, 255),
           pr.item_id || null, rwipDec(pr.length), rwipDec(pr.width), rwipTrunc(pr.uom, 50), rwipNum(pr.qty), rwipTrunc(pr.unit, 50), rwipTrunc(pr.remarks, 500)]
        );
      }
    }
    await rwipAudit(conn, rwipId, req.user.id, 'Created', 'status', null, 'Pending RMA Approval');
    await rwipAudit(conn, jo.id, req.user.id, 'Updated', 'rwip', null, jobOrderNo);
    await conn.commit();
    res.status(201).json({ job_order_id: rwipId, job_order_no: jobOrderNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
