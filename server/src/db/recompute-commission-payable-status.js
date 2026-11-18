// Recomputes every Commission Payable's status from what has actually been released against it.
//
// PAID is supposed to mean the rep has been paid in full. It did not: /pay was a plain flag that
// set status='paid' on any open payable, and the voucher path compared releases against
// commissionable_amount -- Confirmed minus what has already gone out, which shrinks with every
// release, so a partial payment could satisfy it. CP-1 is the visible case: marked PAID showing
// an Expected Commission of 20,240.00 against 3,546.43 released, still owing the rep 16,693.57.
//
// The rule now, in the routes and here:
//
//   released <= 0                 -> unpaid
//   released >= expected          -> paid      (half a centavo of rounding tolerance)
//   anything between              -> partial
//
// Both figures come from the Commission report for the payable's month (2026-11-18), so the status
// agrees with what the report shows:
//   - Expected is the LIVE Expected Commission, not the figure stored on the payable when it was
//     raised. The stored figure goes stale as more job orders reach the passing rate, and releases
//     past it flipped payables to PAID while the report still showed commission unpaid -- CP-36:
//     9,680.00 stored, 14,960.00 live, 10,611.78 released. The stored expected_commission itself is
//     not touched (it is the payable's GL accrual).
//   - Released is the report's Released Commission: what the vouchers paid against the month before
//     their expense deductions, less paybacks (the 2026-10-03 rule). An earlier version of this
//     script used the net figure after deductions, which disagreed with the report and the vouchers.
//
// Void payables are left alone: void is not a payment state.
//
// amount_paid is realigned to the gross total of the non-void voucher lines against the payable --
// what the voucher create / edit / void paths maintain it as.
//
// IDEMPOTENT: recomputes from source data, so re-running changes nothing further.
//
//   node src/db/recompute-commission-payable-status.js --dry-run
//   node src/db/recompute-commission-payable-status.js
const pool = require('../db');
const { payableStatus: statusFor, liveFiguresByPayable } = require('../lib/commissionPayableStatus');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const money = (n) => round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const [payables] = await pool.query(
    `SELECT id, commission_payable_no, status, expected_commission, amount_paid
       FROM commission_payables
      WHERE status <> 'void'
      ORDER BY id`
  );
  console.log(`commission payables (excluding void): ${payables.length}`);

  const reportCache = new Map();
  const changes = [];
  const [grossRows] = await pool.query(
    `SELECT cvl.commission_payable_id AS pid, SUM(cvl.released_amount) AS gross
       FROM commission_voucher_lines cvl
       JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
      WHERE cv.status <> 'void'
      GROUP BY cvl.commission_payable_id`
  );
  const grossByPayable = new Map(grossRows.map((r) => [Number(r.pid), round2(r.gross)]));

  let skipped = 0;
  for (const cp of payables) {
    const live = (await liveFiguresByPayable([cp.id], { reportCache })).get(Number(cp.id));
    if (!live) { skipped += 1; continue; } // no report for this employee -- leave it as it is
    cp.stored_expected = cp.expected_commission;
    cp.expected_commission = live.expected;
    const released = live.released;
    const gross = grossByPayable.get(Number(cp.id)) || 0;
    const want = statusFor(cp.expected_commission, released);
    const paidDrift = round2(cp.amount_paid) !== gross;
    if (want !== cp.status || paidDrift) {
      changes.push({ ...cp, released, gross, want });
    }
  }
  if (skipped) console.log(`skipped (no Commission report for the employee): ${skipped}`);

  const moves = {};
  for (const c of changes) {
    const k = `${c.status} -> ${c.want}`;
    moves[k] = (moves[k] || 0) + 1;
  }
  console.log(`\nrows to correct: ${changes.length}`);
  for (const [k, n] of Object.entries(moves)) console.log(`  ${k.padEnd(22)} ${n}`);

  const overstated = changes.filter((c) => c.status === 'paid' && c.want !== 'paid');
  if (overstated.length) {
    console.log(`\n${overstated.length} payable(s) were marked PAID while still owing the rep:`);
    for (const c of overstated.slice(0, 15)) {
      console.log(`  ${String(c.commission_payable_no).padEnd(10)} expected ${money(c.expected_commission).padStart(12)} (stored ${money(c.stored_expected)})`
        + ` | released ${money(c.released).padStart(12)} | still owed ${money(Number(c.expected_commission) - c.released).padStart(12)} -> ${c.want}`);
    }
    if (overstated.length > 15) console.log(`  ... and ${overstated.length - 15} more`);
    const owed = overstated.reduce((s, c) => s + (Number(c.expected_commission) - c.released), 0);
    console.log(`  total still owed across them: ${money(owed)}`);
  }
  const otherMoves = changes.filter((c) => c.want !== c.status && !(c.status === 'paid' && c.want !== 'paid'));
  if (otherMoves.length) {
    console.log(`\nother status changes (${otherMoves.length}):`);
    for (const c of otherMoves) {
      console.log(`  ${String(c.commission_payable_no).padEnd(10)} ${c.status} -> ${c.want} | expected ${money(c.expected_commission)} (stored ${money(c.stored_expected)}) | released ${money(c.released)}`);
    }
  }
  const driftOnly = changes.filter((c) => c.want === c.status);
  if (driftOnly.length) console.log(`\namount_paid realigned only (status unchanged): ${driftOnly.length}`);

  if (!DRY_RUN) {
    for (const c of changes) {
      await pool.query(
        'UPDATE commission_payables SET status = ?, amount_paid = ?, updated_at = NOW() WHERE id = ?',
        [c.want, c.gross, c.id]
      );
    }
  }

  const [after] = await pool.query(
    "SELECT status, COUNT(*) n FROM commission_payables GROUP BY status ORDER BY n DESC"
  );
  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'} ${changes.length} payable(s).`);
  console.log('status distribution now:', after.map((r) => `${r.status} ${r.n}`).join(' | '));

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
