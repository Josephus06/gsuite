// Where an asset actually is, and how it is allowed to get somewhere else.
//
// The whole module hangs on one rule: an asset that is ATTACHED to another asset has no location
// of its own. The UPS with reference 1542 is plugged into the System Unit "PC 1"; PC 1 is held by
// a user at Warehouse - Central; therefore the UPS is at Warehouse - Central. Storing a location
// on the UPS as well would give two answers to one question, and the stale one always wins an
// argument at audit time -- move PC 1 to the Admin Office and a UPS carrying its own copy of the
// location is still, on paper, in the warehouse.
//
// So: assets.location_id / custodian_employee_id are authoritative ONLY on a root asset (one with
// parent_asset_id IS NULL). For anything else they are ignored, and every read goes through
// resolveCustody() below.
const pool = require('../db');

// A chain longer than this is a data error, not a deep rack. The walk is also cycle-guarded by
// the visited set below; this is the belt to that pair of braces, so a corrupted parent pointer
// can never spin a request forever.
const MAX_CHAIN_DEPTH = 20;

const ATTACHABLE_STATUSES = new Set(['active', 'for_repair']);

// Statuses that take an asset out of circulation. A transfer of one of these is refused: moving
// a disposed asset between offices is either a mistake or a paper trail nobody should be able to
// create quietly.
const TRANSFERABLE_STATUSES = new Set(['active', 'for_repair']);

function db(conn) { return conn || pool; }

// Walks parent_asset_id up to the root and returns the custody that applies to `assetId`.
//
// `chain` is the path from the asset itself up to (and including) the root, which is what the UI
// shows as "UPS 1542 -> PC 1 -> Warehouse - Central" so a custodian can see why an asset they
// never touched is counted against them.
async function resolveCustody(assetId, conn) {
  const q = db(conn);
  const chain = [];
  const visited = new Set();
  let currentId = assetId;

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (currentId == null || visited.has(String(currentId))) break;
    visited.add(String(currentId));
    const [[row]] = await q.query(
      `SELECT a.id, a.reference_no, a.parent_asset_id, a.location_id, a.custodian_employee_id,
              a.department_id, a.status, ai.display_name AS item_name
         FROM assets a
         LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
        WHERE a.id = ?`,
      [currentId],
    );
    if (!row) break;
    chain.push(row);
    if (row.parent_asset_id == null) {
      return {
        root_asset_id: row.id,
        is_attached: chain.length > 1,
        location_id: row.location_id,
        custodian_employee_id: row.custodian_employee_id,
        department_id: row.department_id,
        chain,
      };
    }
    currentId = row.parent_asset_id;
  }

  // Only reachable through a cycle or a parent pointer at a row that no longer exists. Falling
  // back to the asset's own columns keeps the record readable instead of 500-ing a list page,
  // and is_broken_chain lets the caller flag it rather than present it as fact.
  const self = chain[0] || null;
  return {
    root_asset_id: self?.id ?? assetId,
    is_attached: chain.length > 1,
    is_broken_chain: true,
    location_id: self?.location_id ?? null,
    custodian_employee_id: self?.custodian_employee_id ?? null,
    department_id: self?.department_id ?? null,
    chain,
  };
}

// Would setting `parentId` as the parent of `assetId` close a loop? Checked before every attach:
// a cycle makes resolveCustody() unable to name a location at all, which silently drops both
// assets out of every audit sheet.
async function wouldCreateCycle(assetId, parentId, conn) {
  if (!parentId) return false;
  if (String(assetId) === String(parentId)) return true;
  const q = db(conn);
  const visited = new Set([String(assetId)]);
  let currentId = parentId;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (currentId == null) return false;
    if (visited.has(String(currentId))) return true;
    visited.add(String(currentId));
    const [[row]] = await q.query('SELECT parent_asset_id FROM assets WHERE id = ?', [currentId]);
    if (!row) return false;
    currentId = row.parent_asset_id;
  }
  return true;
}

// Every asset hanging off `assetId`, at any depth. Used when an asset moves: its attached units
// move with it, and each one needs its own ledger row or the audit trail for a UPS would simply
// stop the day it was plugged into a PC.
async function descendantIds(assetId, conn) {
  const q = db(conn);
  const out = [];
  let frontier = [assetId];
  const seen = new Set([String(assetId)]);
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length; depth += 1) {
    const [rows] = await q.query('SELECT id FROM assets WHERE parent_asset_id IN (?)', [frontier]);
    frontier = [];
    for (const r of rows) {
      if (seen.has(String(r.id))) continue;
      seen.add(String(r.id));
      out.push(r.id);
      frontier.push(r.id);
    }
  }
  return out;
}

async function recordMovement(conn, {
  assetId, movementType, transferId = null, auditId = null,
  fromLocationId = null, fromCustodianEmployeeId = null,
  toLocationId = null, toCustodianEmployeeId = null,
  remarks = null, userId = null,
}) {
  await conn.query(
    `INSERT INTO asset_movements
       (asset_id, movement_type, transfer_id, audit_id, from_location_id, from_custodian_employee_id,
        to_location_id, to_custodian_employee_id, remarks, moved_by_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [assetId, movementType, transferId, auditId, fromLocationId, fromCustodianEmployeeId,
      toLocationId, toCustodianEmployeeId, remarks == null ? null : String(remarks).slice(0, 500), userId],
  );
}

// Moves one asset to a new location/custodian and writes the ledger rows -- for the asset itself
// and for everything attached to it.
//
// Detaching is deliberate and unconditional: an asset named on a transfer is being handed to
// someone as a thing in its own right, so if it was plugged into something it comes out. Without
// this, transferring the UPS out of PC 1 would set columns that resolveCustody() then ignores,
// and the UPS would appear not to have moved at all.
async function moveAsset(conn, {
  assetId, toLocationId, toCustodianEmployeeId = null, toDepartmentId = null,
  movementType, transferId = null, auditId = null, remarks = null, userId = null,
}) {
  const before = await resolveCustody(assetId, conn);
  const [[row]] = await conn.query('SELECT parent_asset_id FROM assets WHERE id = ?', [assetId]);

  await conn.query(
    `UPDATE assets
        SET parent_asset_id = NULL, location_id = ?, custodian_employee_id = ?,
            department_id = COALESCE(?, department_id), updated_at = NOW()
      WHERE id = ?`,
    [toLocationId, toCustodianEmployeeId, toDepartmentId, assetId],
  );

  await recordMovement(conn, {
    assetId,
    movementType,
    transferId,
    auditId,
    fromLocationId: before.location_id,
    fromCustodianEmployeeId: before.custodian_employee_id,
    toLocationId,
    toCustodianEmployeeId,
    remarks: row?.parent_asset_id ? `${remarks || ''} (detached from parent asset)`.trim() : remarks,
    userId,
  });

  // Attached units keep their parent pointer -- they did not change hands, their holder did --
  // but each gets a ledger row so "where has this UPS been?" answers correctly for a unit that
  // has never been named on a transfer in its life.
  for (const childId of await descendantIds(assetId, conn)) {
    await recordMovement(conn, {
      assetId: childId,
      movementType: 'carried',
      transferId,
      auditId,
      fromLocationId: before.location_id,
      fromCustodianEmployeeId: before.custodian_employee_id,
      toLocationId,
      toCustodianEmployeeId,
      remarks: 'Moved with its parent asset',
      userId,
    });
  }
}

// The ERP user who signs for an employee. Custody is held by an employee because warehouse staff
// may have no login at all; approval needs a user. Where the two do not line up the route falls
// back to anyone holding can_approve, so an asset held by a person without an account is not
// stuck forever -- see routes/assetTransfers.js.
async function approverUserIdForEmployee(employeeId, conn) {
  if (!employeeId) return null;
  const [[row]] = await db(conn).query(
    'SELECT id FROM users WHERE employee_id = ? AND is_active = TRUE ORDER BY id LIMIT 1',
    [employeeId],
  );
  return row?.id || null;
}

module.exports = {
  resolveCustody,
  wouldCreateCycle,
  descendantIds,
  recordMovement,
  moveAsset,
  approverUserIdForEmployee,
  ATTACHABLE_STATUSES,
  TRANSFERABLE_STATUSES,
  MAX_CHAIN_DEPTH,
};
