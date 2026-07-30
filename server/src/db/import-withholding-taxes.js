// Importer: migrates all Withholding Taxes from live into withholding_taxes. On the live site these
// are "NonPK" records (Module_NonPK = 'WTAX') fetched via get_non_pks. Fields map:
//   UserPK_NonPK -> code (+ atc_code, they're the same ATC), Description_NonPK -> name,
//   Rate_NonPK -> rate, SysFK_COA_NonPK -> account (all "Expanded Withholding Tax" = 21402 here).
// Full replace (the local table has no dependents yet). Adds an account_id column if missing.
//
//   node src/db/import-withholding-taxes.js
const pool = require('../db');
require('dotenv').config();

const SITE = 'http://gsuite.graphicstar.com.ph';

async function login() {
  const res = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const body = await res.json();
  if (!body?.data?.token) throw new Error('live login failed');
  return body.data.token;
}
async function api(token, ep, payload) {
  const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  return r.json();
}
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (res?.data || []));

(async () => {
  try {
    const [cols] = await pool.query('SHOW COLUMNS FROM withholding_taxes LIKE ?', ['account_id']);
    if (!cols.length) { await pool.query('ALTER TABLE withholding_taxes ADD COLUMN account_id BIGINT NULL AFTER atc_code'); console.log('Added withholding_taxes.account_id'); }

    // Default account = 21402 Expanded Withholding Tax (every live WTAX row uses it).
    const [[ewt]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '21402' LIMIT 1");
    const ewtId = ewt?.id || null;

    const token = await login();
    const all = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const rows = listRows(await api(token, 'get_non_pks', { where: { Module_NonPK: 'WTAX' }, limit: 200, offset }));
      if (!rows.length) break;
      all.push(...rows);
      if (rows.length < 200) break;
    }
    console.log(`Fetched ${all.length} withholding taxes from live.`);
    if (!all.length) { console.log('Nothing to import.'); process.exit(0); }

    await pool.query('DELETE FROM withholding_taxes');
    for (const w of all) {
      const code = (w.UserPK_NonPK || '').toString().slice(0, 30);
      const name = (w.Description_NonPK || '').toString().slice(0, 150);
      const rate = Number(w.Rate_NonPK) || 0;
      await pool.query(
        'INSERT INTO withholding_taxes (code, name, rate, atc_code, account_id, is_active) VALUES (?, ?, ?, ?, ?, 1)',
        [code, name, rate, code, ewtId]
      );
    }
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM withholding_taxes');
    console.log(`Imported ${n} withholding taxes.`);
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
