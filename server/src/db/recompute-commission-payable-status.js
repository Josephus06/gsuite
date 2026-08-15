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
// Released is the net figure from the Commission Vouchers raised against the payable, after the
// deduction/refund waterfall -- the same releaseForPayable() the detail screen shows, so a
// corrected status always matches what the document displays.
//
// Void payables are left alone: void is not a payment state.
//
// amount_paid is realigned to the released figure at the same time. It is meant to track what has
// gone out, but /pay used to slam it to commissionable_amount regardless, which is what let the
// two notions drift apart in the first place.
//
// IDEMPOTENT: recomputes from source data, so re-running changes nothing further.
//
//   node src/db/recompute-commission-payable-status.js --dry-run
//   node src/db/recompute-commission-payable-status.js
const pool = require('../db');
const { releaseForPayable } = require('../lib/commissionRelease');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const money = (n) => round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function statusFor(expected, released) {
  const e = round2(expected); const r = round2(released);
  if (r <= 0) return 'unpaid';
  if (r + 0.005 >= e) return 'paid';
  return 'partial';
}

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

  const changes = [];
  for (const cp of payables) {
    const { released } = await releaseForPayable(cp.id);
    const want = statusFor(cp.expected_commission, released);
    const paidDrift = round2(cp.amount_paid) !== round2(released);
    if (want !== cp.status || paidDrift) {
      changes.push({ ...cp, released: round2(released), want });
    }
  }

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
      console.log(`  ${String(c.commission_payable_no).padEnd(10)} expected ${money(c.expected_commission).padStart(12)}`
        + ` | released ${money(c.released).padStart(12)} | still owed ${money(Number(c.expected_commission) - c.released).padStart(12)} -> ${c.want}`);
    }
    if (overstated.length > 15) console.log(`  ... and ${overstated.length - 15} more`);
    const owed = overstated.reduce((s, c) => s + (Number(c.expected_commission) - c.released), 0);
    console.log(`  total still owed across them: ${money(owed)}`);
  }

  if (!DRY_RUN) {
    for (const c of changes) {
      await pool.query(
        'UPDATE commission_payables SET status = ?, amount_paid = ?, updated_at = NOW() WHERE id = ?',
        [c.want, c.released, c.id]
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
