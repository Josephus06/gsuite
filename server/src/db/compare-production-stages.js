// READ-ONLY. Finds Job Orders whose built / inspected / delivered quantities in T1S differ from
// the source, so a gap like JO-63045-1-1 (source 500 built, T1S 178) is caught by a check instead
// of by someone noticing it on screen.
//
// Source figures are worked out the same way import-production-stages.js imports them:
//   built      = SUM(Quantity_TransH) of the JO's non-void ASSMBUILDs
//   inspected  = SUM(QuantityInspected_TransH - QuantityRMA_TransH) of those builds, when the JO
//                has a non-void QI (else 0)
//   delivered  = SUM(Qty_LdgrJob) of the SO's non-void ITEMD ledger-job lines for the JO
// and compared with the Job Order header (jo.quantity_built / _inspected / _delivered), which is
// what the SO and JO screens show.
//
//   node src/db/compare-production-stages.js --from=2025-12-01 --to=2025-12-31
//   node src/db/compare-production-stages.js --from=2025-12-01 --to=2025-12-31 --only=SO-63045
//   --no-deliveries   skip the delivery comparison (one fewer source call per SO)
//   --cached          use the .live-cache SO list instead of re-pulling it
//   --concurrency=4
//
// It writes nothing. At the end it prints the import-production-stages.js command that re-imports
// just the mismatched orders.
const pool = require('../db');
require('dotenv').config();
const { fetchWindow, isVoidOrCancelled, login, api, listRows } = require('./lib/liveWindow');

function argVal(name, def) { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; }
const FROM = argVal('from', '');
const TO = argVal('to', '');
const ONLY = new Set(argVal('only', '').split(',').map((s) => s.trim()).filter(Boolean));
const DELIVERIES = !process.argv.includes('--no-deliveries');
const CACHED = process.argv.includes('--cached');
const CONCURRENCY = Math.max(1, Number(argVal('concurrency', '')) || 4);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : []); // get_transactions returns data:[...]
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.0001;

async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    console.error('Give real dates: --from=YYYY-MM-DD --to=YYYY-MM-DD (e.g. --from=2025-12-01 --to=2025-12-31)');
    process.exit(1);
  }
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST} | window ${FROM}..${TO}${ONLY.size ? ` | only ${[...ONLY].join(',')}` : ''}`);
  console.log('READ-ONLY -- nothing is written.\n');

  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, so.sales_order_no, jo.quantity, jo.status,
            COALESCE(jo.quantity_built, 0) AS built, COALESCE(jo.quantity_inspected, 0) AS inspected,
            COALESCE(jo.quantity_delivered, 0) AS delivered
       FROM job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id`);
  const joByNo = new Map(jos.map((j) => [j.job_order_no, j]));
  const localSoNos = new Set(jos.map((j) => j.sales_order_no));

  const token = await login();
  const soRows = await fetchWindow(token, {
    endpoint: 'get_sales_orders', from: FROM, to: TO, keyField: 'so_upk',
    extra: { viewAll: true }, refresh: !CACHED, onProgress: (m) => console.log(m),
  });
  const seen = new Set();
  const targets = [];
  for (const so of soRows) {
    if (isVoidOrCancelled(so.Status_TransH) || seen.has(so.so_upk)) continue;
    if (ONLY.size && !ONLY.has(so.so_upk)) continue;
    seen.add(so.so_upk);
    targets.push({ soNo: so.so_upk, soPk: so.so_pk });
  }
  console.log(`\n${targets.length} source SO(s) in the window.\n`);

  const mismatches = []; // { soNo, joNo, field, source, t1s }
  const missingSo = [];
  const missingJo = [];
  let done = 0, failed = 0, checkedJos = 0;

  await mapWithConcurrency(targets, CONCURRENCY, async (t) => {
    try {
      if (!localSoNos.has(t.soNo)) { missingSo.push(t.soNo); return; }
      const cert = listRows(await api(token, 'get_job_orders_for_cert', { soPK: t.soPk }));
      const joByPk = new Map();
      for (const j of cert) {
        const lj = joByNo.get(j.UserPK_TransH);
        if (!lj) { missingJo.push(`${j.UserPK_TransH} (${t.soNo})`); continue; }
        joByPk.set(j.SysPK_TransH, lj);
      }

      const src = new Map(); // local jo id -> { built, inspected, delivered }
      for (const [pk, lj] of joByPk) {
        const abs = rowsOf(await api(token, 'get_transactions', { where: { SysFK_TransHJO_TransH: pk, Module_TransH: 'ASSMBUILD' } }))
          .filter((ab) => !isVoidOrCancelled(ab.Status_TransH));
        const qis = rowsOf(await api(token, 'get_transactions', { where: { SysFK_TransHJO_TransH: pk, Module_TransH: 'QI' } }))
          .filter((qi) => !isVoidOrCancelled(qi.Status_TransH));
        const built = abs.reduce((s, ab) => s + num(ab.Quantity_TransH), 0);
        const passed = abs.reduce((s, ab) => s + Math.max(0, num(ab.QuantityInspected_TransH) - num(ab.QuantityRMA_TransH)), 0);
        src.set(lj.id, { lj, built, inspected: qis.length ? passed : 0, delivered: 0 });
      }

      if (DELIVERIES) {
        const dels = rowsOf(await api(token, 'get_transactions', { where: { SysFK_TransHSO_TransH: t.soPk, Module_TransH: 'ITEMD' } }))
          .filter((d) => !isVoidOrCancelled(d.Status_TransH));
        for (const del of dels) {
          const ljobs = rowsOf(await api(token, 'get_transaction_ledger_jobs', { where: { SysFK_TransH_LdgrJob: del.SysPK_TransH } }));
          const counted = new Set(); // the importer keeps one line per JO per delivery
          for (const l of ljobs) {
            const lj = joByPk.get(l.SysFK_TransHJO_LdgrJob);
            if (!lj || counted.has(lj.id)) continue;
            counted.add(lj.id);
            src.get(lj.id).delivered += num(l.Qty_LdgrJob) || num(l.Fulfilled_LdgrJob) || 0;
          }
        }
      }

      for (const s of src.values()) {
        checkedJos += 1;
        const fields = DELIVERIES ? ['built', 'inspected', 'delivered'] : ['built', 'inspected'];
        for (const f of fields) {
          if (!same(s[f], s.lj[f])) mismatches.push({ soNo: t.soNo, joNo: s.lj.job_order_no, status: s.lj.status, field: f, source: s[f], t1s: num(s.lj[f]) });
        }
      }
    } catch (e) {
      failed += 1;
      console.warn(`  !! ${t.soNo}: ${e.message}`);
    } finally {
      done += 1;
      if (done % 100 === 0) console.log(`  ...${done}/${targets.length} SOs, ${mismatches.length} mismatch(es) so far`);
    }
  });

  console.log(`\nChecked ${checkedJos} JO(s) on ${targets.length - missingSo.length} SO(s). Source calls failed on ${failed} SO(s).`);
  if (missingSo.length) console.log(`\n${missingSo.length} source SO(s) not in T1S at all: ${missingSo.slice(0, 30).join(', ')}${missingSo.length > 30 ? ', ...' : ''}`);
  if (missingJo.length) console.log(`\n${missingJo.length} source JO(s) not in T1S: ${missingJo.slice(0, 30).join(', ')}${missingJo.length > 30 ? ', ...' : ''}`);

  if (!mismatches.length) {
    console.log('\nNo quantity mismatches.');
  } else {
    mismatches.sort((a, b) => a.joNo.localeCompare(b.joNo) || a.field.localeCompare(b.field));
    console.log(`\n${mismatches.length} mismatch(es):\n`);
    console.log(`${'JO'.padEnd(20)} ${'Field'.padEnd(10)} ${'Source'.padStart(10)} ${'T1S'.padStart(10)}  T1S status`);
    for (const m of mismatches) {
      console.log(`${m.joNo.padEnd(20)} ${m.field.padEnd(10)} ${String(m.source).padStart(10)} ${String(m.t1s).padStart(10)}  ${m.status || ''}`);
    }
    const soNos = [...new Set(mismatches.map((m) => m.soNo))].sort();
    console.log(`\n${soNos.length} SO(s) to re-import. Dry run first, then without --dry-run:`);
    console.log(`  node src/db/import-production-stages.js --preset=all --from=${FROM} --to=${TO} --only=${soNos.join(',')} --dry-run`);
    console.log('Then move the JO stages on (preview, then --apply):');
    console.log('  node src/db/fix-regressed-jo-stages.js');
    console.log('  node src/db/fix-regressed-jo-stages.js --apply');
  }
  await pool.end();
}
main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
