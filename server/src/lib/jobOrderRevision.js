const pool = require('../db');

// Who may act on a job order Production has handed back to Sales ("For Revision").
//
// Both actions that stage exists for -- deciding on a suggested delivery date and returning the
// job to Production -- belong to Sales. They were gated on can_edit for /job-orders, which is
// wrong in both directions at once. Too narrow, because almost no sales account holds it: of 27
// sales users, 24 sit on can_view, so the revision landed in their queue with no way out of it
// and an admin as the only way to clear it. And too wide, because can_edit on /job-orders is not
// a sales permission -- three Production accounts hold it, so the people who RAISED the revision
// were being offered the button that ends it.
//
// So the rule is stated in terms of who these actions belong to rather than in terms of a
// permission that happens to correlate with it:
//
//   System Admin              -- always, as everywhere else in the app
//   the job order's sales rep -- their own job order, no further rights needed. This is the
//                                path that matters: it is what the revision loop is for.
//   any other Sales account   -- needs can_edit on /job-orders, i.e. a sales user trusted to
//                                edit job orders generally, covering for a colleague
//
// Everyone else is refused, Production included, whatever permissions they hold. Mirrored on the
// client by utils/salesRevision.js, which draws the buttons.
//
// `jo` only has to carry sales_rep_id.
const SALES_ACCOUNT_TYPE = 'Sales';

// Why a job order was sent back. Kept in step with REVISION_REASONS in
// client/src/utils/salesRevision.js.
const REVISION_MATERIAL_PROCESS = 'material_process';
const REVISION_DELIVERY_DATE = 'delivery_date';
const REVISION_REASONS = [REVISION_MATERIAL_PROCESS, REVISION_DELIVERY_DATE];

// WHY the promised delivery date cannot be met, picked from a fixed list rather than typed.
// These are the answers the business already gives, and as codes they can be counted -- "how
// many jobs slipped for lack of material this quarter" is a question a column can answer and
// a paragraph cannot. The free-text remark stays alongside, for the detail a list cannot
// carry.
//
// Only meaningful for a delivery_date revision. A material/process revision is a request to
// re-specify the job, and the reason for that is the spec change itself.
//
// Codes are stored; the labels are presentation and are mirrored in
// client/src/utils/salesRevision.js. Keep the two in step -- the client draws the dropdown
// from its copy and the server validates against this one.
const DATE_CHANGE_REASONS = [
  'lack_of_material',
  'machine_maintenance',
  'volume_exceeds_lead_time',
  'power_interruption',
  'change_material',
  'additional_process',
  'shortage_of_consumables',
];

const REVISION_APPROVED = 'approved';
const REVISION_DECLINED = 'declined';

async function maySalesReviseJobOrder(userId, jo) {
  const [[me]] = await pool.query('SELECT account_type, employee_id FROM users WHERE id = ?', [userId]);
  if (!me) return false;
  if (me.account_type === 'System Admin') return true;
  // The rep named on the job order. Checked before the account type deliberately: whoever the
  // job order says owns it is the person the revision came back to.
  if (me.employee_id && String(jo?.sales_rep_id) === String(me.employee_id)) return true;
  if (me.account_type !== SALES_ACCOUNT_TYPE) return false;

  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', ['/job-orders']);
  const [[perm]] = await pool.query(
    'SELECT can_edit AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page?.id]
  );
  return !!perm?.allowed;
}

// A "change material/process" revision is a request to Sales to re-specify the job, so it has to
// carry the rights to do that -- and almost no sales rep holds can_edit on /job-orders, which is
// what the edit form and the process endpoints ask for. Rather than widen anyone's permissions
// permanently, the right is attached to THIS job order for as long as it is in revision for THIS
// reason, and closes the moment it goes back to Production.
//
// Deliberately not granted for a delivery-date revision: nothing about the spec is in question
// there, and Sales answers it by approving or declining the suggested date.
function isOpenForSalesRework(jo) {
  return jo?.production_stage === 'for_revision'
    && jo?.revision_reason === REVISION_MATERIAL_PROCESS
    && jo?.status !== 'Cancelled';
}

// The fields that grant does NOT open. The full edit form posts every field it holds, so a rep
// working under it could otherwise move the delivery date -- the one thing this whole flow exists
// to route through Production's suggestion and Sales's decision -- or reassign the job to another
// warehouse, artist or rep. Enforced only when a value actually CHANGES (the form resubmits
// everything unchanged), the same way the artist_id check on that route already works.
const REWORK_PROTECTED_FIELDS = [
  'job_location_id', 'artist_id', 'sales_rep_id',
  'delivery_date', 'delivery_time', 'planned_start_date', 'planned_end_date',
];

module.exports = {
  maySalesReviseJobOrder,
  isOpenForSalesRework,
  REWORK_PROTECTED_FIELDS,
  SALES_ACCOUNT_TYPE,
  REVISION_MATERIAL_PROCESS,
  REVISION_DELIVERY_DATE,
  REVISION_REASONS,
  DATE_CHANGE_REASONS,
  REVISION_APPROVED,
  REVISION_DECLINED,
};
