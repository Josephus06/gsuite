// Who may see an asset, and who may do anything to it.
//
// An asset is OWNED by a department -- stated on its type (UPS -> Support - IT, Aircon -> Building
// & Maintenance) and overridable on the individual unit. From that one fact:
//
//   * people in that department SEE its assets and may register them
//   * only the department HEAD may transfer, dispose of, edit or capitalise them
//   * everyone else does not see them at all
//
// So the IT head cannot touch an aircon, and the engineering head cannot touch a UPS, which is the
// whole point.
//
// The user's department is read the same way the rest of the app reads it -- the department on
// their DEFAULT branch (user_branches.is_default) -- so a user with several branch rows gets one
// predictable answer instead of a union that would quietly widen the scope. Same discipline as
// lib/jobLocationVisibility.js, including checking fresh against the database rather than trusting
// the JWT: moving someone between departments has to take effect on their next request, not at
// their next login.
//
// CAN VIEW ALL widens the first of those and nothing else. A user holding can_view_all on
// /assets sees every department's assets -- that is what the flag has meant since it was
// introduced ("can_view answers may you open this screen at all; can_view_all answers whose
// records do you see once you are in"), and asset custody is exactly the case it was made for:
// an auditor, an accountant or an admin assistant has to see the whole register while having no
// business moving anyone's equipment.
//
// It does NOT let them act. Transfer, disposal, edit and capitalisation stay with the owning
// department's head, and registering an asset stays inside the registrant's own department. A
// permission called "view all" that quietly also granted disposal would be a trap.
//
// Fails CLOSED. A type with no owning department is visible to System Admin alone. Being unable to
// see your own asset is a confusing five minutes; the wrong department quietly transferring
// equipment is a real loss.
const pool = require('../db');
const { userCan } = require('../middleware/auth');

// The page whose can_view_all governs this. One flag, checked on the Assets page itself, rather
// than one per asset screen: the rule it widens is "whose assets exist for you", which is the
// same question on the register, the transfer picker and the detail page. Granting it per screen
// would let someone see a unit on one and not the other.
const ASSETS_ROUTE = '/assets';

function db(conn) { return conn || pool; }

// The department that owns an asset: its own override, else its type's.
const OWNING_DEPARTMENT_SQL = 'COALESCE(a.owning_department_id, ai.owning_department_id)';

// Does this user hold can_view_all on Assets?
//
// Wrapped, because `userCan` interpolates the action into the SELECT and can_view_all is NOT in
// schema.sql -- it arrives via add-can-view-all-permission.js. Both production installs have the
// column (258 rows on the droplet, 198 on Railway), but a database built straight from schema.sql
// does not, and an unguarded read would turn "no extra permission" into a 500 on every asset
// list. Missing column reads as "no", which is the fail-closed answer.
async function hasViewAll(userId) {
  try {
    return await userCan(userId, ASSETS_ROUTE, 'can_view_all');
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return false;
    throw err;
  }
}

// What this user is allowed to do with assets, resolved once per request.
//
// Returns:
//   { unrestricted: true }                              -> System Admin: sees and acts on everything
//   { viewAll: true, departmentId, isHead }             -> sees every department, acts only as head
//   { unrestricted: false, departmentId, isHead }       -> scoped to one department
//   { unrestricted: false, departmentId: null }         -> no department: sees nothing
//
// `unrestricted` still means BOTH see and act, and every caller that gates an action reads it
// that way -- so can_view_all deliberately does not set it. `viewAll` is a separate flag that
// only the visibility paths look at.
async function getAssetScope(userId, conn) {
  const q = db(conn);
  const [[user]] = await q.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  if (!user) return { unrestricted: false, viewAll: false, departmentId: null, isHead: false };
  if (user.account_type === 'System Admin') return { unrestricted: true, viewAll: true, departmentId: null, isHead: true };

  const viewAll = await hasViewAll(userId);

  const [[branch]] = await q.query(
    `SELECT ub.department_id FROM user_branches ub
      WHERE ub.user_id = ? AND ub.is_default = TRUE AND ub.department_id IS NOT NULL
      LIMIT 1`,
    [userId],
  );
  const departmentId = branch?.department_id || null;
  // A can_view_all holder with no department still sees everything -- the flag is about whose
  // records you may read, and it would be a strange permission that switched itself off because
  // the holder's branch row carries no department.
  if (!departmentId) return { unrestricted: false, viewAll, departmentId: null, isHead: false };

  // Head of their own department. Read off departments.head_user_id, which Lookups > Departments
  // already maintains, so this needs no second place to keep in step.
  const [[dept]] = await q.query('SELECT head_user_id FROM departments WHERE id = ?', [departmentId]);
  const isHead = !!dept?.head_user_id && String(dept.head_user_id) === String(userId);

  return { unrestricted: false, viewAll, departmentId, isHead };
}

// SQL fragment restricting a query to what this scope may see. Callers append it to their WHERE
// and push the returned params. `a` and `ai` must be the assets / asset_items aliases.
//
// An unrestricted scope contributes nothing at all -- deliberately, so a System Admin's query is
// the same query it always was rather than one with a redundant filter the optimiser has to see
// through.
function visibilityClause(scope) {
  if (scope.unrestricted || scope.viewAll) return { sql: null, params: [] };
  if (!scope.departmentId) return { sql: '1 = 0', params: [] }; // no department -> nothing
  return { sql: `${OWNING_DEPARTMENT_SQL} = ?`, params: [scope.departmentId] };
}

// May this user SEE this one asset? Used by the detail endpoints behind the lists -- hiding a row
// from a list while leaving its detail page open to anyone with the id is not a restriction.
async function canViewAsset(userId, assetId, conn) {
  const scope = await getAssetScope(userId, conn);
  if (scope.unrestricted) return { allowed: true, scope };
  // can_view_all reads every department's register, so the detail page opens for any of them --
  // hiding the page while the row is listed would be the same inconsistency in reverse.
  if (scope.viewAll) {
    const [[owned]] = await db(conn).query(
      `SELECT ${OWNING_DEPARTMENT_SQL} AS owning_department_id
         FROM assets a LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
        WHERE a.id = ?`,
      [assetId],
    );
    if (!owned) return { allowed: false, scope, reason: 'Not found' };
    return { allowed: true, scope, owningDepartmentId: owned.owning_department_id };
  }
  if (!scope.departmentId) return { allowed: false, scope, reason: 'You are not assigned to a department, so no assets are visible to you.' };

  const [[row]] = await db(conn).query(
    `SELECT ${OWNING_DEPARTMENT_SQL} AS owning_department_id
       FROM assets a LEFT JOIN asset_items ai ON ai.id = a.asset_item_id
      WHERE a.id = ?`,
    [assetId],
  );
  if (!row) return { allowed: false, scope, reason: 'Not found' };
  const allowed = String(row.owning_department_id ?? '') === String(scope.departmentId);
  return {
    allowed,
    scope,
    owningDepartmentId: row.owning_department_id,
    reason: allowed ? null : 'This asset belongs to another department.',
  };
}

// May this user CHANGE this asset -- transfer, dispose, edit, capitalise?
//
// Seeing is not enough: within the owning department only the head acts. Anyone else in the
// department gets a message naming the head, because "not allowed" without saying who is allowed
// just moves the question to someone's desk.
async function canActOnAsset(userId, assetId, conn) {
  const view = await canViewAsset(userId, assetId, conn);
  if (!view.allowed) return { allowed: false, reason: view.reason, scope: view.scope };
  if (view.scope.unrestricted) return { allowed: true, scope: view.scope };
  // Head OF THIS ASSET'S DEPARTMENT, not head of anything. The department check used to be
  // implied -- canViewAsset only ever allowed your own department's assets through, so reaching
  // this line at all meant the asset was yours. can_view_all breaks that implication: without
  // this comparison, a department head holding it could transfer, dispose of and capitalise
  // every other department's equipment, which is the exact loss the whole module guards against.
  if (view.scope.isHead && String(view.owningDepartmentId ?? '') === String(view.scope.departmentId ?? '')) {
    return { allowed: true, scope: view.scope };
  }

  // The head named is the ASSET'S department's, not the reader's. They were the same thing while
  // you could only see your own department's equipment; with can_view_all they are not, and
  // telling an auditor looking at an aircon to go and see the IT head would be worse than saying
  // nothing. canViewAsset already resolved the owning department, so this costs no extra lookup.
  const departmentId = view.owningDepartmentId ?? view.scope.departmentId;
  const [[head]] = await db(conn).query(
    `SELECT u.display_name, d.name AS department_name
       FROM departments d LEFT JOIN users u ON u.id = d.head_user_id WHERE d.id = ?`,
    [departmentId],
  );
  return {
    allowed: false,
    scope: view.scope,
    reason: head?.display_name
      ? `Only the head of ${head.department_name} (${head.display_name}) can change this asset.`
      : `Only the head of this asset's department can change it, and no head is set. Set one at Lookups > Departments.`,
  };
}

// Express guards. `param` names the route parameter holding the asset id.
function requireAssetView(param = 'id') {
  return async (req, res, next) => {
    try {
      const { allowed, reason } = await canViewAsset(req.user.id, req.params[param]);
      if (!allowed) return res.status(reason === 'Not found' ? 404 : 403).json({ error: reason });
      next();
    } catch (err) { next(err); }
  };
}

function requireAssetAction(param = 'id') {
  return async (req, res, next) => {
    try {
      const { allowed, reason } = await canActOnAsset(req.user.id, req.params[param]);
      if (!allowed) return res.status(reason === 'Not found' ? 404 : 403).json({ error: reason });
      next();
    } catch (err) { next(err); }
  };
}

module.exports = {
  OWNING_DEPARTMENT_SQL,
  getAssetScope,
  visibilityClause,
  canViewAsset,
  canActOnAsset,
  requireAssetView,
  requireAssetAction,
};
