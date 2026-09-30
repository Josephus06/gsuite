// Loads the source system's monthly expenses BY DEPARTMENT for the department budget report's
// months up to the cut-over (T1S's own ledger takes over after it):
//   source_dept_actuals          section totals (opex / other_expense / cogs) per department
//   source_dept_account_actuals  the same per ACCOUNT per department -- needed to take Interest
//                                and Taxes/Licenses out of Accounting onto its Others line
//
// Read-only on the source: generate_department_income_statement, one call per month (minutes
// each). Verified 2026-09-30 against the accounting manager's 2025 workbook -- its Admin and
// Selling actuals are exactly this report's Operating Expenses per department.
//
//   node src/db/load-source-dept-actuals.js --from=2025-01 --to=2026-08 [--save=<raw.json>]   fetch + load
//   node src/db/load-source-dept-actuals.js --raw=<raw.json> --year=2025                   load saved raw responses
// A raw file is { "<month>": <the source's response> } for one year. Replaces the months it
// loads. Droplet and office replicate: load ONE of them. Railway: its own.
const fs = require('fs');
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const SECTIONS = { 'OPERATING EXPENSES': 'opex', 'OTHER EXPENSES': 'other_expense', 'COST OF GOODS SOLD': 'cogs' };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function leaves(node, out) {
  const kids = [...(node.subgroups || []), ...(node.groups || []), ...(node.coaparent_chartofaccounts || [])];
  if (!kids.length) { out.push(node); return; }
  kids.forEach((k) => leaves(k, out));
}

// One month's department income statement -> { totals, accounts } rows.
function parseMonth(j, year, month) {
  const [dates, sections] = j.data;
  const names = dates[0];
  const totals = []; const accounts = [];
  for (const sec of sections) {
    const key = SECTIONS[sec.type]; if (!key) continue;
    const leafNodes = []; (sec.groups || []).forEach((g) => leaves(g, leafNodes));
    const sum = [];
    for (const leaf of leafNodes) {
      (leaf.amounts || []).forEach((a, i) => {
        const v = Number(a[0] || 0);
        sum[i] = (sum[i] || 0) + v;
        if (Math.abs(v) > 0.005 && names[i] !== 'Total') {
          accounts.push({ year, month, source_department: names[i], section: key, account_code: String(leaf.UserPK_COA || '').trim(), amount: r2(v) });
        }
      });
    }
    names.forEach((name, i) => {
      if (Math.abs(sum[i] || 0) > 0.005) totals.push({ year, month, source_department: name, section: key, amount: r2(sum[i]) });
    });
  }
  // The same account can appear under more than one leaf path: fold duplicates.
  const folded = new Map();
  for (const a of accounts) {
    const k = `${a.source_department}|${a.section}|${a.account_code}`;
    if (folded.has(k)) folded.get(k).amount = r2(folded.get(k).amount + a.amount); else folded.set(k, { ...a });
  }
  return { totals, accounts: [...folded.values()] };
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
      return j;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
}

async function main() {
  const parsed = []; // [{ year, month, totals, accounts }]
  if (arg('raw')) {
    const year = Number(arg('year'));
    if (!year) throw new Error('--raw needs --year=YYYY.');
    const raw = JSON.parse(fs.readFileSync(arg('raw'), 'utf8'));
    for (const [m, j] of Object.entries(raw)) parsed.push({ year, month: Number(m), ...parseMonth(j, year, Number(m)) });
  } else {
    const [fy, fm] = String(arg('from') || '').split('-').map(Number);
    const [ty, tm] = String(arg('to') || '').split('-').map(Number);
    if (!fy || !fm || !ty || !tm) throw new Error('Give --from=YYYY-MM --to=YYYY-MM, or --raw=<file> --year=YYYY.');
    const login = await fetch(`${SITE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
    });
    const token = (await login.json())?.data?.token;
    if (!token) throw new Error('Source login failed.');
    const save = {};
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y += 1, m = 1) : (m += 1)) {
      const j = await fetchMonth(token, y, m);
      if (arg('save')) { save[`${y}-${m}`] = j; fs.writeFileSync(arg('save'), JSON.stringify(save)); }
      parsed.push({ year: y, month: m, ...parseMonth(j, y, m) });
      console.log(`  fetched ${MON[m - 1]} ${y}`);
    }
  }

  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let nt = 0; let na = 0;
    for (const p of parsed) {
      await conn.query('DELETE FROM source_dept_actuals WHERE year = ? AND month = ?', [p.year, p.month]);
      await conn.query('DELETE FROM source_dept_account_actuals WHERE year = ? AND month = ?', [p.year, p.month]);
      if (p.totals.length) {
        await conn.query('INSERT INTO source_dept_actuals (year, month, source_department, section, amount) VALUES ?',
          [p.totals.map((r) => [r.year, r.month, r.source_department, r.section, r.amount])]);
      }
      for (let i = 0; i < p.accounts.length; i += 500) {
        await conn.query('INSERT INTO source_dept_account_actuals (year, month, source_department, section, account_code, amount) VALUES ?',
          [p.accounts.slice(i, i + 500).map((r) => [r.year, r.month, r.source_department, r.section, r.account_code, r.amount])]);
      }
      nt += p.totals.length; na += p.accounts.length;
    }
    await conn.commit();
    console.log(`  loaded ${parsed.length} month(s): ${nt} department totals, ${na} account figures.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
