// When a Job Order goes In-Process, its Design / Layout process lines are complete.
//
// The layout work is done before a job reaches production -- the artwork is what production
// builds from -- so by the time the JO is In-Process there is nothing left to record on those
// lines. Leaving them at 0% made someone mark each one complete by hand, and until they did,
// Available Qty to Build (capped by the least-complete line) stayed at zero for the whole JO.
//
// A line is a Design line by its own location, or the JO's when the line has none -- the same
// effective location the Production screen's Complete button judges by. Matched by name
// ("Design", "Layout") rather than id, because ids differ between installs.
//
// Same write as that Complete button: total_completed = total. Only lines not already complete
// are touched, so it is safe to call on every transition into In-Process.
async function completeDesignProcesses(conn, jobOrderId) {
  const [r] = await conn.query(
    `UPDATE job_order_processes jop
       JOIN job_orders jo ON jo.id = jop.job_order_id
       JOIN locations l ON l.id = COALESCE(jop.location_id, jo.job_location_id)
        SET jop.total_completed = jop.total
      WHERE jop.job_order_id = ?
        AND (l.location_name LIKE '%design%' OR l.location_name LIKE '%layout%')
        AND jop.total > 0
        AND COALESCE(jop.total_completed, 0) < jop.total`,
    [jobOrderId]
  );
  return r.affectedRows;
}

module.exports = { completeDesignProcesses };
