const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/assembly-builds';

// GL Impact: a standard manufacturing cost-absorption entry, derived live (not
// persisted as real ledger rows -- no Journal/GL module in this build, same convention
// already used by Inventory Adjustment's GL Impact tab). Reverse-engineered directly
// from the real system's sandbox (Assembly Build > GL Impact tab, live API's
// transaction_transactionledgerentries): debit Finished Goods Inventory (the build's
// Job Type's own asset account) for the total cost; credit each process line's material
// cost to that item's own asset account (falling back to a generic "Direct Materials"
// account for non-inventory items like a labor placeholder); credit the labor/overhead
// portion of each line's process cost split across Direct Labor / Indirect Labor /
// Depreciation-FOH / Repairs&Maintenance-FOH / Electricity Expense / Materials-Tools&
// Supplies, using the *ratio* of those components on the process's current cost bracket
// (matched by this line's Total Qty to Build) -- ratios only, applied to the already-
// stored process_cost, so the split always sums exactly to the real persisted total even
// if bracket rates changed since the line's cost was first computed.
const FIXED_GL_CODES = {
  directLabor: '30402', indirectLabor: '30501', powerEquipment: '30627',
  depreciation: '30507', repairsMaintenance: '30513', indirectMaterials: '30504',
  // click_charge/ink_cost/other_charges have no confirmed real-system mapping (never
  // observed non-zero on the live sandbox samples used to reverse-engineer this) --
  // bucketed into Direct Materials as the closest sensible account, same fallback used
  // for material cost on non-inventory items.
  directMaterials: '30401',
};

async function computeGlImpact(conn, ab, lines) {
  if (!ab.fg_account_id) return [];

  const [coaRows] = await conn.query(
    'SELECT id, account_code, account_name FROM chart_of_accounts WHERE id = ? OR account_code IN (?)',
    [ab.fg_account_id, Object.values(FIXED_GL_CODES)]
  );
  const itemAccountIds = [...new Set(lines.map((l) => l.item_asset_account_id).filter(Boolean))];
  if (itemAccountIds.length) {
    const [itemCoaRows] = await conn.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [itemAccountIds]);
    coaRows.push(...itemCoaRows);
  }
  const coaById = new Map(coaRows.map((c) => [c.id, c]));
  const coaByCode = new Map(coaRows.map((c) => [c.account_code, c]));

  const processIds = [...new Set(lines.map((l) => l.process_id).filter(Boolean))];
  const bracketsByProcess = new Map();
  if (processIds.length) {
    const [brackets] = await conn.query(
      'SELECT * FROM process_cost_brackets WHERE process_id IN (?) AND is_active = TRUE ORDER BY qty_min',
      [processIds]
    );
    for (const b of brackets) {
      if (!bracketsByProcess.has(b.process_id)) bracketsByProcess.set(b.process_id, []);
      bracketsByProcess.get(b.process_id).push(b);
    }
  }

  const credits = new Map(); // account_id -> amount
  function credit(accountId, amount) {
    if (!accountId || !amount) return;
    credits.set(accountId, (credits.get(accountId) || 0) + amount);
  }

  let debitTotal = 0;
  for (const line of lines) {
    debitTotal += Number(line.total_cost) || 0;

    const materialCost = Number(line.material_cost) || 0;
    if (materialCost) {
      const acct = line.item_asset_account_id ? coaById.get(line.item_asset_account_id) : null;
      credit(acct ? acct.id : coaByCode.get(FIXED_GL_CODES.directMaterials)?.id, materialCost);
    }

    const processCost = Number(line.process_cost) || 0;
    if (processCost) {
      const bracketList = bracketsByProcess.get(line.process_id) || [];
      const qtyBasis = Number(line.total_qty_to_build) || 0;
      const bracket = bracketList.find((b) => qtyBasis >= Number(b.qty_min) && qtyBasis <= Number(b.qty_max)) || bracketList[0];

      const components = bracket ? {
        [FIXED_GL_CODES.directLabor]: Number(bracket.direct_labor) || 0,
        [FIXED_GL_CODES.indirectLabor]: Number(bracket.moh_indirect_labor) || 0,
        [FIXED_GL_CODES.powerEquipment]: Number(bracket.moh_power_equipment) || 0,
        [FIXED_GL_CODES.depreciation]: Number(bracket.moh_depreciation) || 0,
        [FIXED_GL_CODES.repairsMaintenance]: Number(bracket.moh_repairs_maintenance) || 0,
        [FIXED_GL_CODES.indirectMaterials]: Number(bracket.moh_indirect_materials) || 0,
        [FIXED_GL_CODES.directMaterials]: (Number(bracket.click_charge) || 0) + (Number(bracket.ink_cost) || 0) + (Number(bracket.other_charges) || 0),
      } : {};
      const componentTotal = Object.values(components).reduce((a, b) => a + b, 0);

      if (componentTotal > 0) {
        for (const [code, amount] of Object.entries(components)) {
          if (!amount) continue;
          credit(coaByCode.get(code)?.id, processCost * (amount / componentTotal));
        }
      } else {
        // No bracket found (or every component is zero) -- can't split, so don't
        // silently drop the cost: land it all on Direct Labor as the single most
        // common component rather than fabricating a breakdown we don't have data for.
        credit(coaByCode.get(FIXED_GL_CODES.directLabor)?.id, processCost);
      }
    }
  }

  const rows = [];
  for (const [accountId, amount] of credits) {
    const acct = coaById.get(accountId);
    if (!acct) continue;
    rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: Number(amount.toFixed(2)) });
  }
  const fgAcct = coaById.get(ab.fg_account_id);
  if (fgAcct && debitTotal) {
    rows.unshift({ account_code: fgAcct.account_code, account_name: fgAcct.account_name, debit: Number(debitTotal.toFixed(2)), credit: 0 });
  }
  return rows;
}

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
              jt.display_name AS job_type_name, c.name AS customer_name,
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
              loc.location_name AS job_location_name, jt.display_name AS job_type_name, jt.asset_account_id AS fg_account_id,
              c.name AS customer_name, cc.contact_name,
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

// Reverses the build: adds the deducted material back to on-hand and subtracts what
// this transaction contributed from each process line's Total Built and the JO's
// overall Qty Built. Can't be reversed twice.
router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ab]] = await conn.query('SELECT status, job_order_id, quantity_built FROM assembly_builds WHERE id = ?', [req.params.id]);
    if (!ab) { return res.status(404).json({ error: 'Not found' }); }
    if (ab.status === 'cancelled') { return res.status(409).json({ error: 'This Assembly Build is already cancelled.' }); }

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
