// Mirror of server/src/lib/advanceCopy.js -- see there, and db/add-jo-advance-copy.js, for why
// this is a column rather than a production_stage value.
//
// An advance copy is a job order Sales forwarded so Production could SEE it before approval.
// Production may raise a Transfer Order against it and do nothing else. This decides which
// controls are drawn; the server decides which requests are accepted, and a button the server
// will refuse is worse than no button at all.
//
// `production_stage` being null is half the test, and it is the half that expires the flag:
// Sales approval sets the stage, so the job stops being an advance copy at that instant without
// anything having to clear advance_copy_at.
export function isAdvanceCopy(jo) {
  return !!jo && !!jo.advance_copy_at && !jo.production_stage;
}

// Can this job order still be forwarded? Only before Production has it for real, and only once.
export function canForwardAdvanceCopy(jo) {
  return !!jo && !jo.production_stage && !jo.advance_copy_at
    && jo.status !== 'Cancelled' && jo.status !== 'Completed';
}
