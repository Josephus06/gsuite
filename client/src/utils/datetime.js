// server/src/db.js sets `dateStrings: true` on the MySQL pool, so DATETIME columns come
// back as raw "YYYY-MM-DD HH:MM:SS" strings -- true UTC wall-clock values, but with no
// 'Z'/offset marker. `new Date(thatString)` parses a marker-less string as the BROWSER's
// local time instead of UTC, silently shifting it by the browser's UTC offset (e.g. -8h
// for a Philippines-timezone user). That's invisible for pure display (parse-as-local
// then re-display-as-local round-trips back to the same numbers), but corrupts any math
// that compares the parsed value against a real `Date.now()` -- e.g. a live countdown
// inflates by exactly the timezone offset the longer a session stays open. Use this
// wherever a DB timestamp needs to be diffed against "now", not just displayed.
export function parseUtc(v) {
  if (!v) return null;
  return new Date(`${String(v).replace(' ', 'T')}Z`);
}
