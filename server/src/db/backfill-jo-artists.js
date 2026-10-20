// Job orders that have an artist in the source but none in T1S (asked 2026-10-20: JO-69679-1-1 --
// Lysander Dabon in the source, blank here). import-jo-processes.js resolves the artist by NAME at the
// time it runs and leaves it blank when that fails, and nothing went back for those afterwards.
//
//   1. the source's JOBORDER list carries each JO's artist (SysFK_ArtistUsr_TransH, a user key)
//   2. each DISTINCT artist key is turned into a name with one get_job_order call (artist_name) --
//      a handful of calls, not one per JO
//   3. the name is matched to a T1S employee (case and spacing ignored)
//   4. a T1S JO with NO artist gets it. An artist already set in T1S is never replaced.
//
//   node src/db/backfill-jo-artists.js                 # report
//   node src/db/backfill-jo-artists.js JO-69679-1-1    # one JO
//   node src/db/backfill-jo-artists.js --apply
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const PAGE = 500;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const listRows = (r) => (Array.isArray(r?.data?.[0]) ? r.data[0] : (Array.isArray(r?.data) ? r.data : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const token = (await r.json())?.data?.token;
  if (!token) throw new Error('Source login failed.');
  return token;
}
async function api(token, ep, body) {
  let last;
  for (let a = 0; a < 4; a += 1) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
    try {
      const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(t); return await r.json();
    } catch (e) { clearTimeout(t); last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'REPORT'}\n`);
  const [locals] = await pool.query(
    `SELECT id, job_order_no FROM job_orders WHERE artist_id IS NULL ${ONE ? 'AND job_order_no = ?' : ''}`, ONE ? [ONE] : []);
  const wanted = new Map(locals.map((j) => [j.job_order_no, j.id]));
  console.log(`T1S job orders with no artist: ${wanted.size}`);
  if (!wanted.size) { await pool.end(); return; }

  const token = await login();
  // JO number -> { artist key, the JO's own key } for the JOs we need.
  const found = new Map();
  if (ONE) {
    for (const r of listRows(await api(token, 'get_transactions', { where: { Module_TransH: 'JOBORDER', UserPK_TransH: ONE }, limit: 5 }))) {
      if (r.SysFK_ArtistUsr_TransH) found.set(r.UserPK_TransH, { artist: r.SysFK_ArtistUsr_TransH, pk: r.SysPK_TransH });
    }
  } else {
    let empty = 0;
    for (let off = 0; off < 400000; off += PAGE) {
      const rows = listRows(await api(token, 'get_transactions', { where: { Module_TransH: 'JOBORDER' }, limit: PAGE, offset: off }));
      if (!rows.length) { empty += 1; if (empty >= 2) break; continue; }
      empty = 0;
      for (const r of rows) {
        if (r.SysFK_ArtistUsr_TransH && wanted.has(r.UserPK_TransH) && !found.has(r.UserPK_TransH)) {
          found.set(r.UserPK_TransH, { artist: r.SysFK_ArtistUsr_TransH, pk: r.SysPK_TransH });
        }
      }
      if ((off / PAGE) % 20 === 0) console.log(`  read ${off + rows.length} source job orders, ${found.size} with an artist we lack`);
    }
  }
  console.log(`Source has an artist for ${found.size} of them.`);

  // One detail call per distinct artist: its name.
  const nameOf = new Map();
  for (const { artist, pk } of found.values()) {
    if (nameOf.has(artist)) continue;
    const d = await api(token, 'get_job_order', { pk });
    const h = Array.isArray(d?.data) ? d.data[0] : null;
    nameOf.set(artist, h?.artist_name || null);
  }
  const [emps] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));

  const byArtist = new Map(); const unmatched = new Map();
  let set = 0;
  for (const [joNo, { artist }] of found) {
    const name = nameOf.get(artist);
    const empId = name ? empByName.get(norm(name)) : null;
    if (!empId) { unmatched.set(name || `(key ${artist})`, (unmatched.get(name || `(key ${artist})`) || 0) + 1); continue; }
    byArtist.set(name, (byArtist.get(name) || 0) + 1);
    set += 1;
    if (APPLY) await pool.query('UPDATE job_orders SET artist_id = ? WHERE id = ? AND artist_id IS NULL', [empId, wanted.get(joNo)]);
  }
  console.log(`\n${APPLY ? 'Artist set on' : 'Would set the artist on'} ${set} job order(s):`);
  [...byArtist.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n}: ${c}`));
  if (unmatched.size) {
    console.log('\nSource artists with no T1S employee by that name (left blank):');
    [...unmatched.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n}: ${c}`));
  }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
