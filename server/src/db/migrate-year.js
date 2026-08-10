// Runs the full transaction migration for one date window, in dependency order, for EVERY
// sales rep -- the whole-company version of the per-division chain described in the README of
// import-sales.js. Void and cancelled documents are excluded by every step.
//
// Order matters: each step needs the rows the previous one created.
//   1. import-sales.js              Estimate -> Sales Order -> Job Order -> Invoice
//   2. import-jo-processes.js       each Job Order's process/material lines
//   3. import-production-stages.js  Assembly Build -> Quality Inspection -> Item Delivery
//   4. import-delivery-tickets.js   Delivery Tickets (+ the invoices converted DTs became)
//   5. import-customer-payments.js  the real PAY-#### headers
//   6. generate-invoice-payments.js the CPAY-INV links that tie payments to invoices
//   7. import-purchase-orders.js    Purchase Orders
//   8. import-purchasing-related.js Receiving Reports + Vendor Returns (per PO)
//   9. import-vendor-bills.js       Vendor Bills (per PO)
//
// Step 2 must precede step 3: assembly-build lines are built from job_order_processes, so a
// build imported before the processes exist gets a correct header but no lines.
//
// Every step is independently resumable, so a crashed or interrupted run can simply be
// re-run: completed documents are skipped or replaced in place, never duplicated.
//
//   node src/db/migrate-year.js --year=2021
//   node src/db/migrate-year.js --from=2021-01-01 --to=2021-12-31
//   node src/db/migrate-year.js --year=2021 --only=sales,production
//   node src/db/migrate-year.js --year=2021 --dry-run
const path = require('path');
const { spawn } = require('child_process');

const argVal = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const YEAR = argVal('year', null);
const FROM = argVal('from', YEAR ? `${YEAR}-01-01` : null);
const TO = argVal('to', YEAR ? `${YEAR}-12-31` : null);
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = new Set(argVal('only', '').split(',').map((s) => s.trim()).filter(Boolean));

if (!FROM || !TO) {
  console.error('Specify the window: --year=2021 (or --from=YYYY-MM-DD --to=YYYY-MM-DD)');
  process.exit(1);
}

// `dry` marks the steps that support --dry-run; the rest are simply skipped in a dry run.
const STEPS = [
  { key: 'sales', script: 'import-sales.js', args: ['--preset=all', `--from=${FROM}`, `--to=${TO}`], dry: true,
    label: 'Estimates, Sales Orders, Job Orders, Invoices' },
  { key: 'jo-processes', script: 'import-jo-processes.js', args: [`--from=${FROM}`, `--to=${TO}`], dry: true,
    label: 'Job Order processes / materials (feeds assembly-build lines)' },
  { key: 'production', script: 'import-production-stages.js', args: ['--preset=all', `--from=${FROM}`, `--to=${TO}`], dry: true,
    label: 'Assembly Builds, Quality Inspections, Item Deliveries' },
  { key: 'delivery-tickets', script: 'import-delivery-tickets.js', args: ['--preset=all', `--from=${FROM}`, `--to=${TO}`], dry: true,
    label: 'Delivery Tickets (+ converted-DT invoices)' },
  { key: 'payments', script: 'import-customer-payments.js', args: [`--from=${FROM}`, `--to=${TO}`], dry: true,
    label: 'Customer Payments (live PAY-#### headers)' },
  { key: 'invoice-payments', script: 'generate-invoice-payments.js', args: ['--all-reps', `--from=${FROM}`, `--to=${TO}`], dry: true,
    label: 'Invoice settlements (CPAY-INV links)' },
  { key: 'purchase-orders', script: 'import-purchase-orders.js', args: [`--from=${FROM}`, `--to=${TO}`], dry: false,
    label: 'Purchase Orders' },
  { key: 'receiving', script: 'import-purchasing-related.js', args: [`--from=${FROM}`, `--to=${TO}`], dry: false,
    label: 'Receiving Reports + Vendor Returns' },
  { key: 'vendor-bills', script: 'import-vendor-bills.js', args: [`--from=${FROM}`, `--to=${TO}`], dry: false,
    label: 'Vendor Bills' },
];

function run(step) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, step.script), ...step.args, ...(DRY_RUN && step.dry ? ['--dry-run'] : [])];
    const started = Date.now();
    console.log(`\n${'='.repeat(78)}\n>> ${step.key}: ${step.label}\n   node ${step.script} ${args.slice(1).join(' ')}\n${'='.repeat(78)}`);
    const p = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
    p.on('close', (code) => {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`<< ${step.key} exited ${code} after ${mins} min`);
      resolve(code);
    });
  });
}

(async () => {
  console.log(`Migrating live transactions for ${FROM}..${TO} (all reps, excluding void/cancelled)`);
  if (DRY_RUN) console.log('DRY RUN -- steps that support it report only; the rest are skipped.');
  const selected = STEPS.filter((s) => !ONLY.size || ONLY.has(s.key));
  console.log(`Steps: ${selected.map((s) => s.key).join(' -> ')}\n`);

  const failures = [];
  for (const step of selected) {
    if (DRY_RUN && !step.dry) { console.log(`\n-- ${step.key}: skipped (no --dry-run support)`); continue; }
    const code = await run(step);
    // Keep going: a later step can still do useful work, and every step is re-runnable.
    if (code !== 0) failures.push(step.key);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(failures.length
    ? `Finished with ${failures.length} failed step(s): ${failures.join(', ')}. Re-run them individually -- each is resumable.`
    : 'All steps finished.');
})();
