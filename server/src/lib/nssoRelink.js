// Relinks an NSSO's items to the job orders already created from them (2026-11-05).
//
// Saving an NSSO's items deletes and re-inserts them, which cut each item off from its job order:
// the job order (nsso_id still set) stayed, but the new item had no created_job_order_id, so the
// NSSO showed "Create JO" again and Create JO failed on the duplicate number (NSSO-INT-2050).
// Re-saving is now refused once a job order exists; this repairs the NSSOs already affected.
//
// An item is matched to the job order of the same NSSO numbered for it --
// NSJO-<TYPE>-<nssoNum>-<line_no>-<item count>, as create-jo numbers it -- or, failing that, the
// one whose nsso_line_id is the item. Only a job order no other item of the NSSO holds is used.
//
// relinkNsso(q, nssoId, { dryRun }) -> [{ line_id, line_no, job_order_id, job_order_no }]
async function relinkNsso(q, nssoId, { dryRun = false } = {}) {
  const [[n]] = await q.query('SELECT id, nsso_no FROM non_standard_sales_orders WHERE id = ?', [nssoId]);
  if (!n) return [];
  const [lines] = await q.query(
    'SELECT id, line_no, created_job_order_id FROM non_standard_sales_order_lines WHERE nsso_id = ? ORDER BY line_no, id', [nssoId]);
  const open = lines.filter((l) => !l.created_job_order_id);
  if (!open.length) return [];
  const [jos] = await q.query('SELECT id, job_order_no, nsso_line_id FROM job_orders WHERE nsso_id = ? ORDER BY id', [nssoId]);
  if (!jos.length) return [];

  const held = new Set(lines.filter((l) => l.created_job_order_id).map((l) => Number(l.created_job_order_id)));
  const [, abbr, ...numParts] = String(n.nsso_no || '').split('-');
  const prefix = `NSJO-${abbr}-${numParts.join('-')}-`;
  const done = [];
  for (const l of open) {
    const free = jos.filter((j) => !held.has(Number(j.id)));
    const byNumber = free.filter((j) => j.job_order_no === `${prefix}${l.line_no}-${lines.length}`);
    const byLine = free.filter((j) => Number(j.nsso_line_id) === Number(l.id));
    const match = byNumber.length === 1 ? byNumber[0] : (byLine.length === 1 ? byLine[0] : null);
    if (!match) continue;
    held.add(Number(match.id));
    if (!dryRun) {
      await q.query('UPDATE non_standard_sales_order_lines SET created_job_order_id = ? WHERE id = ? AND created_job_order_id IS NULL', [match.id, l.id]);
      await q.query('UPDATE job_orders SET nsso_line_id = ? WHERE id = ?', [l.id, match.id]);
    }
    done.push({ line_id: l.id, line_no: l.line_no, job_order_id: match.id, job_order_no: match.job_order_no });
  }
  return done;
}

module.exports = { relinkNsso };
