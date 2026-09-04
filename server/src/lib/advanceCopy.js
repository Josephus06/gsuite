// An "advance copy" is a job order Sales has forwarded so Production can SEE it before it is
// approved -- and only see it. See db/add-jo-advance-copy.js for why this is a column rather
// than a production_stage value.
//
// The test is deliberately in one place, because it is asked in three different contexts that
// must agree: the Production list (which rows are advance copies), every mutating Production
// endpoint (refuse), and the client (which buttons to draw). Mirrored in
// client/src/utils/advanceCopy.js -- a button the server will refuse is worse than no button.
//
// production_stage IS NULL is half the definition, and it is the half that expires the flag.
// Sales approval sets production_stage to 'pending_for_scheduling', so the job stops being an
// advance copy at that instant without anything having to clear advance_copy_at -- which also
// means the flag stays as a record of when Production was first shown the job.
function isAdvanceCopy(jo) {
  return !!jo && !!jo.advance_copy_at && !jo.production_stage;
}

// The SQL form of the same test, for the Production list and its tab counts. Takes the alias so
// it reads the same as the rest of those queries.
function advanceCopySql(alias = 'jo') {
  return `(${alias}.advance_copy_at IS NOT NULL AND ${alias}.production_stage IS NULL)`;
}

// The one thing Production may do to an advance copy is raise a Transfer Order, which lives in
// its own module. Everything in the Production module itself is refused, so the guard is stated
// once and used by every mutating route rather than restated per handler.
const ADVANCE_COPY_REFUSAL = 'This Job Order is an advance copy. Production can raise a Transfer '
  + 'Order against it, but nothing else until Sales approves it.';

module.exports = { isAdvanceCopy, advanceCopySql, ADVANCE_COPY_REFUSAL };
