// An estimate's GP worked out from its own process lines, by the formula T1S uses everywhere else:
// a job line's GP = its Net of Tax - the SUM of its processes' Total Cost (EstimateWizard's
// recalc), and the estimate's = the lines' Net of Tax - every process's Total Cost
// (generateSalesOrderFromEstimate, EstimateView's footer).
//
// Why it is needed: Replicate copied each line's gp_rate / gp_amount verbatim, and a migrated
// estimate's lines carry the SOURCE system's GP, worked on a different cost basis. EST-203231
// (replicated from EST-109917) showed every line passing at 61-74% while T1S's own costs put each
// at 33-52% and the estimate at 48% -- the lines "passed" on numbers nothing in T1S produced.
//
// A line with no process lines is left as it is: with no costs to read, the formula would give a
// flat 100%, which is an invented number, not a recalculation.
async function recalcEstimateGp(conn, estimateId) {
  const [lines] = await conn.query(
    `SELECT jo.id, jo.subtotal, jo.disc_amount, jo.net_of_tax, jo.gp_rate, jo.gp_amount,
            (SELECT COUNT(*) FROM estimate_job_order_processes p WHERE p.estimate_job_order_id = jo.id) AS nproc,
            (SELECT COALESCE(SUM(p.total_cost), 0) FROM estimate_job_order_processes p WHERE p.estimate_job_order_id = jo.id) AS cost
       FROM estimate_job_orders jo WHERE jo.estimate_id = ?`,
    [estimateId]);
  const n = (v) => Number(v) || 0;
  const changes = [];
  for (const l of lines) {
    if (!Number(l.nproc)) continue;
    const net = n(l.net_of_tax);
    const gpAmount = Number((net - n(l.cost)).toFixed(2));
    const gpRate = net ? Number((gpAmount / net * 100).toFixed(2)) : null;
    if (gpRate !== (l.gp_rate == null ? null : Number(l.gp_rate)) || gpAmount !== n(l.gp_amount)) {
      changes.push({ id: l.id, from: l.gp_rate, to: gpRate });
      await conn.query('UPDATE estimate_job_orders SET gp_rate = ?, gp_amount = ? WHERE id = ?', [gpRate, gpAmount, l.id]);
    }
  }
  if (lines.some((l) => Number(l.nproc))) {
    const net = lines.reduce((s, l) => s + n(l.subtotal) - n(l.disc_amount), 0);
    const cost = lines.reduce((s, l) => s + n(l.cost), 0);
    const gpAmount = Number((net - cost).toFixed(2));
    const gpRate = net ? Number((gpAmount / net * 100).toFixed(2)) : 0;
    await conn.query('UPDATE estimates SET est_gp_rate = ?, est_gp_amount = ? WHERE id = ?', [gpRate, gpAmount, estimateId]);
  }
  return changes;
}

module.exports = { recalcEstimateGp };
