// "Direct to Production" on a job type (job_types.is_direct_to_prod): a Job Order of that type has no
// layout to make -- installation, mobilization, site inspection, accessories -- so it skips Design and
// the artist altogether and goes straight to Production, Pending for Scheduling (asked 2026-10-08).
//
// It lands exactly where Sales's sign-off of a designed JO puts one (routes/jobOrders.js
// approve-sales): status Released, sub status Approved, production_stage pending_for_scheduling.
// Forward to Design only acts on a JO still at sub status Pending, so a released one cannot be
// forwarded by mistake.
const RELEASED = { status: 'Released', sub_status: 'Approved', production_stage: 'pending_for_scheduling' };

async function isDirectToProduction(conn, jobTypeId) {
  if (!jobTypeId) return false;
  const [[jt]] = await conn.query('SELECT is_direct_to_prod FROM job_types WHERE id = ?', [jobTypeId]);
  return !!(jt && Number(jt.is_direct_to_prod));
}

// Releases a just-created Job Order to Production when its job type is Direct to Production.
// Runs inside the caller's transaction. Returns true when it released the JO.
async function releaseIfDirectToProduction(conn, { jobOrderId, jobTypeId, userId, fromStatus = null, fromSubStatus = null }) {
  if (!(await isDirectToProduction(conn, jobTypeId))) return false;
  await conn.query(
    `UPDATE job_orders SET status = ?, sub_status = ?, production_stage = ?, date_forwarded = NOW(), updated_at = NOW()
      WHERE id = ?`,
    [RELEASED.status, RELEASED.sub_status, RELEASED.production_stage, jobOrderId],
  );
  for (const [field, oldValue, newValue] of [
    ['status', fromStatus, RELEASED.status],
    ['sub_status', fromSubStatus, RELEASED.sub_status],
    ['production_stage', null, `${RELEASED.production_stage} (job type is Direct to Production)`],
  ]) {
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', ?, ?, ?, ?)`,
      [jobOrderId, field, oldValue, newValue, userId],
    );
  }
  return true;
}

module.exports = { isDirectToProduction, releaseIfDirectToProduction, RELEASED };
