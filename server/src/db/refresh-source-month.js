// Re-take given months of the source's activity into opening_gl_balances (what every T1S report
// reads up to the cut-over), from the source's trial balance AS IT STANDS NOW.
//
// Why: the monthly rows were loaded from trial balances pulled 2026-09-29/30, and the source kept
// changing after that -- on cut-over night September's inventory postings moved Direct Materials
// down by 2,937,544.79, and 2025-12 drifted by centavos. A month's activity is its month-end
// balance minus the previous month-end's; a period that does not balance in the source goes to
// account 1, exactly as load-opening-balances.js --monthly does.
//
// READ-ONLY on the source. The rows it replaces are saved to a backup file first.
//   node src/db/refresh-source-month.js --months=2025-12-31,2026-09-30 --dry-run
//   node src/db/refresh-source-month.js --months=2025-12-31,2026-09-30
//   node src/db/refresh-source-month.js --restore=<backup file>
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');
const L = require('./lib/liveWindow');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const DRY = process.argv.includes('--dry-run');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const peso = (n) => r2(n).toLocaleString('en-US', { minimumFractionDigits: 2 });
const OPENING_DIFFERENCE = '1';

function rawLeaves(tb) {
  const out = new Map();
  const walk = (n, g) => {
    const kids = n.coaparent_chartofaccounts || [];
    if (!kids.length) { const a = Number(n.amount || 0); const c = String(n.UserPK_COA).trim(); out.set(c, (out.get(c) || 0) + (g.normal === 'DEBIT' ? a : -a)); return; }
    kids.forEach((k) => walk(k, g));
  };
  for (const g of tb) { if (!g.type) continue; for (const a of g.accounts || []) for (const x of a.account_ledgers || []) walk(x, g); }
  return out;
}

(async () => {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (arg('restore')) {
    const rows = JSON.parse(fs.readFileSync(arg('restore'), 'utf8'));
    const dates = [...new Set(rows.map((r) => r.as_of))];
    if (!DRY) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const d of dates) await conn.query('DELETE FROM opening_gl_balances WHERE as_of = ?', [d]);
        await conn.query('INSERT INTO opening_gl_balances (as_of, account_id, account_code, debit, credit, note) VALUES ?', [rows.map((r) => [r.as_of, r.account_id, r.account_code, r.debit, r.credit, r.note])]);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
    console.log(`${DRY ? 'Would restore' : 'Restored'} ${rows.length} row(s) for ${dates.join(', ')}.`);
    await pool.end(); return;
  }

  const months = String(arg('months') || '').split(',').filter(Boolean);
  if (!months.length) throw new Error('Give --months=YYYY-MM-DD[,...] (month-end dates already in opening_gl_balances).');
  const [dates] = await pool.query("SELECT DISTINCT DATE_FORMAT(as_of, '%Y-%m-%d') d FROM opening_gl_balances ORDER BY d");
  const all = dates.map((x) => x.d);
  const [coa] = await pool.query('SELECT id, account_code, account_name, account_type FROM chart_of_accounts');
  const coaBy = new Map(coa.map((c) => [String(c.account_code).trim(), c]));
  const t = await L.login();
  const tbAt = async (d) => rawLeaves((await L.api(t, 'generate_trial_balance', [d]))?.data || []);

  const plan = [];
  for (const d of months) {
    const i = all.indexOf(d);
    if (i <= 0) throw new Error(`${d} is not a month in opening_gl_balances after the first one`);
    const [cur, prev] = [await tbAt(d), await tbAt(all[i - 1])];
    const delta = new Map();
    for (const c of new Set([...cur.keys(), ...prev.keys()])) { const v = r2((cur.get(c) || 0) - (prev.get(c) || 0)); if (Math.abs(v) >= 0.005) delta.set(c, v); }
    const missing = [...delta.keys()].filter((c) => !coaBy.has(c));
    if (missing.length) throw new Error(`${d}: source accounts not in the T1S chart: ${missing.join(', ')}`);
    const total = r2([...delta.values()].reduce((s, v) => s + v, 0));
    if (Math.abs(total) >= 0.005) delta.set(OPENING_DIFFERENCE, r2((delta.get(OPENING_DIFFERENCE) || 0) - total));
    const [old] = await pool.query('SELECT account_code, SUM(debit - credit) amt FROM opening_gl_balances WHERE as_of = ? GROUP BY account_code', [d]);
    const oldBy = new Map(old.map((r) => [String(r.account_code).trim(), Number(r.amt)]));
    const changes = [...new Set([...delta.keys(), ...oldBy.keys()])].map((c) => ({ c, was: oldBy.get(c) || 0, now: delta.get(c) || 0 })).filter((x) => Math.abs(x.now - x.was) >= 0.005);
    const isPl = (c) => /income|revenue|expense|cost/i.test((coaBy.get(c) || {}).account_type || '');
    const net = (m) => -[...m].filter(([c]) => isPl(c)).reduce((s, [, v]) => s + v, 0);
    console.log(`${d}: net income ${peso(net(oldBy))} -> ${peso(net(delta))}; ${changes.length} account(s) change; source imbalance -> acct 1 ${peso(-total)}`);
    for (const x of changes) console.log(`   ${x.c} ${(coaBy.get(x.c) || {}).account_name || ''}: ${peso(x.was)} -> ${peso(x.now)}`);
    plan.push({ d, delta, total });
  }
  if (DRY) { await pool.end(); return; }

  const [backup] = await pool.query("SELECT DATE_FORMAT(as_of, '%Y-%m-%d') AS as_of, account_id, account_code, debit, credit, note FROM opening_gl_balances WHERE as_of IN (?)", [months]);
  const name = `opening-gl-before-refresh-${months.join('_')}.json`;
  const file = process.platform === 'win32' ? name : `/root/${name}`;
  fs.writeFileSync(file, JSON.stringify(backup));
  console.log(`Backup of the replaced rows: ${file}`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of plan) {
      await conn.query('DELETE FROM opening_gl_balances WHERE as_of = ?', [p.d]);
      const rows = [...p.delta].map(([c, v]) => [p.d, coaBy.get(c).id, c, v > 0 ? v : 0, v < 0 ? -v : 0,
        c === OPENING_DIFFERENCE ? `Source trial balance did not balance for ${p.d.slice(0, 7)}` : null]);
      await conn.query('INSERT INTO opening_gl_balances (as_of, account_id, account_code, debit, credit, note) VALUES ?', [rows]);
    }
    await conn.commit();
    console.log(`Refreshed ${plan.map((p) => p.d).join(', ')} from the source's trial balance.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
