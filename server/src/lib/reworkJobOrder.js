// Shared creation of a "rework" job order -- RWIP (raised from an in-process mother JO) or RFQC
// (raised during Quality Inspection for the RMA/damaged qty). Both are job_orders rows linked to
// their mother via parent_job_order_id, numbered <PREFIX>-<n>, starting "Pending RMA Approval",
// copying the mother's header + processes. They then go through the same approve -> build -> QI
// lifecycle as any production JO.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const trunc = (s, n) => (s == null ? null : String(s).slice(0, n));

async function nextReworkNo(conn, prefix) {
  const [[mx]] = await conn.query(
    'SELECT COALESCE(MAX(CAST(SUBSTRING(job_order_no, ?) AS UNSIGNED)), 0) AS n FROM job_orders WHERE job_order_no LIKE ?',
    [prefix.length + 2, `${prefix}-%`] // +2 = skip "<PREFIX>-"
  );
  return `${prefix}-${mx.n + 1}`;
}

async function createReworkJobOrder(conn, { mother, prefix, quantity, reason = null, action = null, reasonCodeId = null, deliveryDate = null, deliveryTime = null, userId, processes = null }) {
  const jobOrderNo = await nextReworkNo(conn, prefix);
  const [r] = await conn.query(
    `INSERT INTO job_orders (job_order_no, parent_job_order_id, sales_order_id, sales_order_line_id, job_type_id, job_location_id,
       description, quantity, units, length, width, height, memo, contact_email, contact_title, contact_phone, shipping_address,
       sales_rep_id, delivery_date, delivery_time, reason_code_id, reason, action_to_be_taken, production_stage, sub_status, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'Pending RMA Approval')`,
    [jobOrderNo, mother.id, mother.sales_order_id, mother.sales_order_line_id, mother.job_type_id, mother.job_location_id,
     mother.description, num(quantity), mother.units, mother.length, mother.width, mother.height, mother.memo, mother.contact_email,
     mother.contact_title, mother.contact_phone, mother.shipping_address, mother.sales_rep_id,
     deliveryDate || mother.delivery_date || null, deliveryTime || mother.delivery_time || null,
     reasonCodeId, trunc(reason, 500), trunc(action, 500)]
  );
  const id = r.insertId;

  // Processes: explicit rows if given (RWIP modal edits), else copy the mother's verbatim (RFQC).
  if (Array.isArray(processes) && processes.length) {
    let ln = 0;
    for (const pr of processes) {
      ln += 1;
      await conn.query(
        `INSERT INTO job_order_processes (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, length, width, uom, qty, unit, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, ln, pr.process_id || null, num(pr.process_qty), trunc(pr.process_uom, 50), trunc(pr.category, 100), trunc(pr.parts, 255),
         pr.item_id || null, (pr.length === '' || pr.length == null ? null : Number(pr.length)), (pr.width === '' || pr.width == null ? null : Number(pr.width)),
         trunc(pr.uom, 50), num(pr.qty), trunc(pr.unit, 50), trunc(pr.remarks, 500)]
      );
    }
  } else {
    const [pcols] = await conn.query('SHOW COLUMNS FROM job_order_processes');
    const copy = pcols.map((c) => c.Field).filter((f) => f !== 'id' && f !== 'job_order_id');
    await conn.query(
      `INSERT INTO job_order_processes (job_order_id, ${copy.join(', ')}) SELECT ?, ${copy.join(', ')} FROM job_order_processes WHERE job_order_id = ?`,
      [id, mother.id]
    );
  }

  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('JobOrder', ?, 'Created', 'status', NULL, 'Pending RMA Approval', ?)`,
    [id, userId]
  );
  return { id, job_order_no: jobOrderNo };
}

// How many rework children of a JO are still open (not completed/invoiced, not cancelled).
async function countOpenRework(conn, parentJobOrderId) {
  const [[{ n }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM job_orders WHERE parent_job_order_id = ? AND status <> 'Cancelled' AND (production_stage IS NULL OR production_stage NOT IN ('completed','invoiced'))",
    [parentJobOrderId]
  );
  return n;
}

module.exports = { createReworkJobOrder, nextReworkNo, countOpenRework };
