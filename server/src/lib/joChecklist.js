// The JO punchlist (asked 2026-11-16) -- see db/create-jo-checklists.js for the table.
//
// The checklist IS the Job Order's own lines: one item per row of its Processes table, plus any
// extra item typed in for that job. Regular Job Orders only: an NSJO (nsso_id) and the RWIP / RFQC
// rework orders have none.
function isChecklistJobOrder(jo) {
  if (!jo || jo.nsso_id) return false;
  const no = String(jo.job_order_no || '');
  return !no.startsWith('RWIP-') && !no.startsWith('RFQC-');
}

// Keeps the checklist in step with the Processes table: a line added since gets its item (required),
// a line deleted since loses its. Process lines are only ever deleted one by one (never wiped and
// re-inserted), so a tick stays with its line through every edit. INSERT IGNORE + the unique key
// on job_order_process_id make two concurrent reads harmless.
async function syncChecklist(conn, jobOrderId) {
  await conn.query(
    `INSERT IGNORE INTO job_order_checklist_items (job_order_id, job_order_process_id, is_required)
     SELECT p.job_order_id, p.id, TRUE FROM job_order_processes p
      WHERE p.job_order_id = ?
        AND NOT EXISTS (SELECT 1 FROM job_order_checklist_items i WHERE i.job_order_process_id = p.id)`,
    [jobOrderId]);
  await conn.query(
    `DELETE i FROM job_order_checklist_items i
      WHERE i.job_order_id = ? AND i.job_order_process_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM job_order_processes p WHERE p.id = i.job_order_process_id)`,
    [jobOrderId]);
}

// A process line reads as "LFP - Printing Solvent - Tarpaulin: TARPAULIN 13 OZ" -- the process, then the item.
const LABEL_SQL = `COALESCE(i.item_text, CONCAT_WS(': ', pr.process_name, inv.display_name), CONCAT('Line ', p.line_no))`;
const ITEMS_FROM = `FROM job_order_checklist_items i
  LEFT JOIN job_order_processes p ON p.id = i.job_order_process_id
  LEFT JOIN processes pr ON pr.id = p.process_id
  LEFT JOIN inventories inv ON inv.id = p.item_id
  LEFT JOIN locations loc ON loc.id = p.location_id`;
// Process lines in their own line order, the extra items after them in the order they were added.
const ITEMS_ORDER = 'ORDER BY (i.job_order_process_id IS NULL), p.line_no, i.sort_order, i.id';

async function getChecklist(conn, jo) {
  await syncChecklist(conn, jo.id);
  const [items] = await conn.query(
    `SELECT i.*, ${LABEL_SQL} AS label, p.line_no, pr.process_name, inv.display_name AS item_name,
            loc.location_name, p.process_qty, p.process_uom, p.qty, p.uom,
            COALESCE(u.display_name, u.username) AS done_by_name
       ${ITEMS_FROM}
       LEFT JOIN users u ON u.id = i.done_by_user_id
      WHERE i.job_order_id = ?
      ${ITEMS_ORDER}`,
    [jo.id]);
  return items;
}

// The required items still open -- what stops the JO from being Completed. [] when it has no checklist.
async function openRequiredItems(conn, jo) {
  if (!isChecklistJobOrder(jo)) return [];
  await syncChecklist(conn, jo.id);
  const [rows] = await conn.query(
    `SELECT i.id, ${LABEL_SQL} AS label ${ITEMS_FROM}
      WHERE i.job_order_id = ? AND i.is_required = TRUE AND i.is_done = FALSE ${ITEMS_ORDER}`,
    [jo.id]);
  return rows;
}

// For the Saved Job Orders list: "done/total" per row without syncing every row it shows -- a
// process line with no checklist row yet counts as open.
const CHECKLIST_LIST_COLUMNS = `
  CASE WHEN jo.nsso_id IS NOT NULL OR jo.job_order_no LIKE 'RWIP-%' OR jo.job_order_no LIKE 'RFQC-%' THEN NULL
       ELSE (SELECT COUNT(*) FROM job_order_processes p WHERE p.job_order_id = jo.id)
          + (SELECT COUNT(*) FROM job_order_checklist_items i WHERE i.job_order_id = jo.id AND i.job_order_process_id IS NULL) END AS checklist_total,
  (SELECT COUNT(*) FROM job_order_checklist_items i
     LEFT JOIN job_order_processes p ON p.id = i.job_order_process_id
    WHERE i.job_order_id = jo.id AND i.is_done = TRUE AND (i.job_order_process_id IS NULL OR p.id IS NOT NULL)) AS checklist_done`;

module.exports = { isChecklistJobOrder, syncChecklist, getChecklist, openRequiredItems, CHECKLIST_LIST_COLUMNS };
