// One-off import: pulls the real Commission Table schemes from the live GraphicStar
// system into this clone's commission_schemes / commission_scheme_brackets. READ-ONLY
// against live -- only login + the two get_* calls the real app itself uses:
//   get_commission_tables  {searchKey, limit, offset} -> data[0] = scheme headers
//   get_commission_table   {pk}                       -> data[1] = that scheme's brackets
//
// The live model stores each bracket's range as a single display STRING
// (TotalWeightedSales_Schm, e.g. "1 - 200,000" or "3,500,000.01-3,600,000"), so it's
// parsed here into the min/max the local schema keeps as two decimals. Amount and rate
// are independent live fields (SalesCredit_Schm / CommissionRate_Schm) -- the rate is
// sometimes 0, sometimes the amount, sometimes a true percentage (0.66) -- both carried
// through untouched.
//
// Upsert by scheme NAME (CommissionFor_SchmH): a scheme that already exists locally has
// its brackets fully replaced, so re-running re-syncs rather than duplicating.
//
//   node src/db/import-commission-schemes.js --dry-run   (fetch + parse + report, no writes)
//   node src/db/import-commission-schemes.js             (apply to local)
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';
const USERNAME = process.env.LIVE_SITE_USERNAME;
const PASSWORD = process.env.LIVE_SITE_PASSWORD;
const DRY_RUN = process.argv.includes('--dry-run');

if (!USERNAME || !PASSWORD) {
  console.error('Set LIVE_SITE_USERNAME and LIVE_SITE_PASSWORD in server/.env first.');
  process.exit(1);
}

async function login() {
  const res = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Login failed: ${body?.message || res.status}`);
  return body.data.token;
}

async function apiPost(token, endpoint, payload, ms = 90000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${SITE}/api/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${endpoint} ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  }
}

// "1 - 200,000" / "3,500,000.01-3,600,000" / "1 -10,500,000" -> { min, max }.
// Split on the range dash FIRST, then strip commas and any stray whitespace from each
// number -- the live data has typos like "3,000,000 .01" (space inside the number) that a
// strip-then-split would turn into NaN and drop a whole tier from the ladder. Returns null
// (reported, never guessed) only when a part genuinely isn't a number.
function parseRange(raw) {
  const parts = String(raw ?? '').trim().split(/\s*-\s*/).filter((p) => p !== '');
  const nums = parts.map((p) => Number(p.replace(/[\s,]/g, '')));
  if (nums.length === 2 && nums.every((n) => Number.isFinite(n))) return { min: nums[0], max: nums[1] };
  if (nums.length === 1 && Number.isFinite(nums[0])) return { min: nums[0], max: nums[0] };
  return null;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- fetching + parsing only, nothing will be written.\n' : 'APPLYING to local.\n');

  const token = await login();
  const listRes = await apiPost(token, 'get_commission_tables', { searchKey: '', limit: 1000, offset: 0 });
  const headers = Array.isArray(listRes.data?.[0]) ? listRes.data[0] : (listRes.data || []);
  console.log(`Live returned ${headers.length} commission scheme(s).\n`);

  let totalBrackets = 0;
  let unparseable = 0;
  const prepared = [];

  for (const h of headers) {
    const pk = h.SysPK_SchmH;
    const name = (h.CommissionFor_SchmH || '').trim();
    if (!name) { console.warn(`!! scheme pk=${pk} has no name -- skipped.`); continue; }

    const detail = await apiPost(token, 'get_commission_table', { pk });
    const liveBrackets = detail.data?.[1] || [];

    const brackets = [];
    for (const b of liveBrackets) {
      const range = parseRange(b.TotalWeightedSales_Schm);
      if (!range) {
        unparseable++;
        console.warn(`   ?? ${name}: could not parse range "${b.TotalWeightedSales_Schm}" -- this bracket is skipped.`);
        continue;
      }
      brackets.push({
        min: range.min,
        max: range.max,
        amount: Number(b.SalesCredit_Schm) || 0,
        rate: Number(b.CommissionRate_Schm) || 0,
      });
    }
    totalBrackets += brackets.length;
    prepared.push({ name, brackets });
    console.log(`  ${name}: ${brackets.length} bracket(s)` + (brackets.length !== liveBrackets.length ? ` (of ${liveBrackets.length} live)` : ''));
  }

  console.log(`\nParsed ${totalBrackets} bracket(s) across ${prepared.length} scheme(s)` + (unparseable ? `; ${unparseable} unparseable and skipped.` : '.'));

  if (DRY_RUN) {
    console.log('\nDRY RUN -- no changes written. Re-run without --dry-run to import.');
    await pool.end();
    return;
  }

  const conn = await pool.getConnection();
  try {
    for (const scheme of prepared) {
      await conn.beginTransaction();
      let [[existing]] = await conn.query('SELECT id FROM commission_schemes WHERE name = ?', [scheme.name]);
      let schemeId;
      if (existing) {
        schemeId = existing.id;
        // Sync the name to live too (matched case-insensitively, so a local "SBU head"
        // becomes the live "SBU Head") -- this is a faithful migration, not a merge.
        await conn.query('UPDATE commission_schemes SET name = ?, is_active = TRUE, updated_at = NOW() WHERE id = ?', [scheme.name, schemeId]);
        await conn.query('DELETE FROM commission_scheme_brackets WHERE commission_scheme_id = ?', [schemeId]);
        console.log(`~ ${scheme.name}: replaced (id ${schemeId})`);
      } else {
        const [r] = await conn.query('INSERT INTO commission_schemes (name) VALUES (?)', [scheme.name]);
        schemeId = r.insertId;
        console.log(`+ ${scheme.name}: created (id ${schemeId})`);
      }
      let order = 0;
      for (const b of scheme.brackets) {
        await conn.query(
          `INSERT INTO commission_scheme_brackets
             (commission_scheme_id, sort_order, min_weighted_sales, max_weighted_sales, commission_amount, commission_rate)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [schemeId, order++, b.min, b.max, b.amount, b.rate]
        );
      }
      await conn.commit();
    }
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  console.log(`\nImported ${prepared.length} scheme(s) with ${totalBrackets} bracket(s) into local.`);
  await pool.end();
}

main().catch((err) => { console.error('\nImport failed:', err.message); process.exit(1); });
