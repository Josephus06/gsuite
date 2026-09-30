// Loads the source system's monthly expenses BY DEPARTMENT into source_dept_actuals, for the
// department budget report's months up to the cut-over (T1S's own ledger takes over after it).
//
// Read-only on the source: generate_department_income_statement, one call per month (about a
// minute each). Verified 2026-09-30 against the accounting manager's 2025 workbook -- its Admin
// and Selling actuals are exactly this report's Operating Expenses per department (Accounting
// Jan 2025 = 270,105.93, and so on).
//
// Fetching is slow and the same for every install, so it can be done once into a cache file and
// the file loaded into each database:
//   node src/db/load-source-dept-actuals.js --from=2025-01 --to=2026-08 --save=<file>   fetch + load
//   node src/db/load-source-dept-actuals.js --file=<file>                              load a cache
// Replaces the months it loads. Droplet and office replicate: load ONE of them. Railway: its own.
const fs = require('fs');
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const SECTIONS = { 'OPERATING EXPENSES': 'opex', 'OTHER EXPENSES': 'other_expense', 'COST OF GOODS SOLD': 'cogs' };

// Sum every leaf amount of a section, per department column.
function leafSum(node, acc) {
  const kids = [...(node.subgroups || []), ...(node.groups || []), ...(node.coaparent_chartofaccounts || [])];
  if (!kids.length) { (node.amounts || []).forEach((a, i) => { acc[i] = (acc[i] || 0) + Number(a[0] || 0); }); return; }
  kids.forEach((k) => leafSum(k, acc));
}

async function fetchMonth(token, year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const body = {
    filter: 'period from',
    date1: { hide: false, label: 'Date From', date: `${MON[month - 1]} 01, ${year}` },
    date2: { hide: false, label: 'Date To', date: `${MON[month - 1]} ${last}, ${year}` },
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await fetch(`${SITE}/api/generate_department_income_statement`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.message || 'source returned no data');
      const [dates, rows] = j.data;
      const names = dates[0];
      const out = [];
      for (const sec of rows) {
        const key = SECTIONS[sec.type]; if (!key) continue;
        const acc = []; (sec.groups || []).forEach((g) => leafSum(g, acc));
        names.forEach((name, i) => {
          const amt = Math.round((acc[i] || 0) * 100) / 100;
          if (Math.abs(amt) > 0.005) out.push({ year, month, source_department: name, section: key, amount: amt });
        });
      }
      return out;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
}

async function main() {
  let rows;
  if (arg('file')) {
    rows = JSON.parse(fs.readFileSync(arg('file'), 'utf8'));
  } else {
    const [fy, fm] = String(arg('from') || '').split('-').map(Number);
    const [ty, tm] = String(arg('to') || '').split('-').map(Number);
    if (!fy || !fm || !ty || !tm) throw new Error('Give --from=YYYY-MM --to=YYYY-MM, or --file=<cache>.');
    const login = await fetch(`${SITE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
    });
    const token = (await login.json())?.data?.token;
    if (!token) throw new Error('Source login failed.');
    rows = [];
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y += 1, m = 1) : (m += 1)) {
      const got = await fetchMonth(token, y, m);
      rows.push(...got);
      const total = got.filter((r) => r.source_department === 'Total');
      console.log(`  ${MON[m - 1]} ${y}: ${total.map((r) => `${r.section} ${r.amount.toLocaleString('en-US')}`).join(', ')}`);
    }
    if (arg('save')) { fs.writeFileSync(arg('save'), JSON.stringify(rows)); console.log(`  saved ${rows.length} rows to ${arg('save')}`); }
  }

  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const months = [...new Set(rows.map((r) => `${r.year}-${r.month}`))];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const ym of months) {
      const [y, m] = ym.split('-').map(Number);
      await conn.query('DELETE FROM source_dept_actuals WHERE year = ? AND month = ?', [y, m]);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => [r.year, r.month, r.source_department, r.section, r.amount]);
      await conn.query('INSERT INTO source_dept_actuals (year, month, source_department, section, amount) VALUES ?', [chunk]);
    }
    await conn.commit();
    console.log(`  loaded ${rows.length} rows for ${months.length} month(s).`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
