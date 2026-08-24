// Notifications for the design hand-off, shared by Job Orders and Non-Standard Job Orders
// so both halves of the same workflow read identically in the bell.
//
// Two moments matter, and they are the two where work changes hands:
//   1. an order is forwarded to Design and needs an artist picked -> tell the supervisors;
//   2. an artist is picked -> tell that artist.
// Before this, both hand-offs were silent: a forwarded order sat in the design queue until
// somebody happened to look at the list, and an assigned artist only discovered the work by
// opening Assigned JO.
//
// Every function takes the caller's transaction `conn` so a notification can never outlive a
// rolled-back assignment.
const NOTIFY_TYPE_PENDING_ASSIGNMENT = 'design_assignment_pending';
const NOTIFY_TYPE_ARTIST_ASSIGNED = 'design_artist_assigned';

// Recipients are the users flagged `is_design_supervisor` -- the same flag assign-design and
// assign-artist gate on, so the people told about the work are exactly the people who can act
// on it. Deliberately NOT including the can_edit admin fallback those endpoints also accept:
// an admin can unstick a stuck order, but making every admin a recipient of every forward
// would bury the supervisors' own queue in noise.
//
// The forwarder is skipped -- a supervisor who forwards an order to themselves does not need
// to be told they did it.
async function notifyDesignSupervisors(conn, { title, message, relatedType, relatedId, excludeUserId = null }) {
  const [supervisors] = await conn.query(
    'SELECT id FROM users WHERE is_design_supervisor = TRUE AND is_active = TRUE',
  );
  const recipients = supervisors.filter((u) => !excludeUserId || String(u.id) !== String(excludeUserId));
  for (const { id } of recipients) {
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, NOTIFY_TYPE_PENDING_ASSIGNMENT, title, message, relatedType, relatedId],
    );
  }
  return recipients.length;
}

// The artist is an employee record; the notification has to go to the *user* account linked
// to it. An artist with no user account (or a deactivated one) simply gets no notification
// rather than failing the assignment -- the supervisor's action must still succeed.
async function notifyAssignedArtist(conn, { artistEmployeeId, title, message, relatedType, relatedId }) {
  if (!artistEmployeeId) return false;
  const [[artistUser]] = await conn.query(
    'SELECT id FROM users WHERE employee_id = ? AND is_active = TRUE LIMIT 1',
    [artistEmployeeId],
  );
  if (!artistUser) return false;
  await conn.query(
    `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [artistUser.id, NOTIFY_TYPE_ARTIST_ASSIGNED, title, message, relatedType, relatedId],
  );
  return true;
}

// The third hand-off, and the one that was still silent: the artist finishes the layout and
// sends it to Sales for sign-off. Nothing told Sales, so a finished Job Order sat at "Sales
// Approval" until somebody happened to scan the list -- the same failure the two above were
// written to fix, in the one place it had been missed.
//
// A Job Order has no raiser to notify. Unlike a Non-Standard Job Order, which somebody creates
// by hand, a JO descends from a Sales Order and an Estimate, so the person who owns it is its
// sales_rep_id. That is an employee record; the notification has to reach the *user* account
// linked to it, the same indirection notifyAssignedArtist deals with.
const NOTIFY_TYPE_SALES_APPROVAL = 'jo_sales_approval';

async function notifySalesRep(conn, { salesRepEmployeeId, title, message, relatedType, relatedId }) {
  if (!salesRepEmployeeId) return false;
  const [[repUser]] = await conn.query(
    'SELECT id FROM users WHERE employee_id = ? AND is_active = TRUE ORDER BY id LIMIT 1',
    [salesRepEmployeeId],
  );
  // A rep with no user account, or a deactivated one, simply gets no notification rather than
  // failing the hand-off. The artist's work must still be submitted.
  if (!repUser) return false;
  await conn.query(
    `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [repUser.id, NOTIFY_TYPE_SALES_APPROVAL, title, message, relatedType, relatedId],
  );
  return true;
}

module.exports = {
  notifyDesignSupervisors,
  notifyAssignedArtist,
  notifySalesRep,
  NOTIFY_TYPE_PENDING_ASSIGNMENT,
  NOTIFY_TYPE_ARTIST_ASSIGNED,
  NOTIFY_TYPE_SALES_APPROVAL,
};
