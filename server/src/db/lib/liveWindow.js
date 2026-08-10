// Shared helper for the live-system importers: login, resilient POST, and -- the important
// part -- pulling a *date window* out of one of live's newest-first list endpoints without
// paging the whole table.
//
// Why this exists: every list endpoint (get_sales_orders, get_invoices, ...) is ordered
// newest-first with no date filter, so the original importers paged from offset 0 until they
// fell past the window. That is fine for the current year, but 2021 sits at offset ~70,000 --
// 350+ pages of rows we throw away, per importer, per run. Instead we binary-search the offset
// where the window starts, page only the window, and cache the raw rows on disk so the other
// importers reuse the same fetch.
//
// Cache files land in server/.live-cache/<endpoint>_<from>_<to>.json and are keyed by
// endpoint + window, so re-running an importer is instant. Delete the file (or pass
// refresh:true) to re-pull from live.
const fs = require('fs');
const path = require('path');

const SITE = process.env.LIVE_SITE_URL || 'http://gsuite.graphicstar.com.ph';
const CACHE_DIR = path.join(__dirname, '..', '..', '..', '.live-cache');

const day = (v) => (v || '').toString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listRows = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []));

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const b = await r.json();
  if (!b?.data?.token) throw new Error(`Login failed: ${b?.message || 'no token'}`);
  return b.data.token;
}

async function apiOnce(token, ep, payload, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    // Clear the abort timer only after the body is read: headers can arrive and then the
    // stream stall, and clearing on headers alone leaves that read with no timeout at all.
    const j = await r.json();
    clearTimeout(t);
    return j;
  } catch (e) {
    clearTimeout(t);
    throw new Error(`${ep} ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  }
}

// The live server intermittently times out / 502s under load -- retry with backoff.
async function api(token, ep, payload, attempts = 5) {
  let last;
  for (let a = 0; a < attempts; a += 1) {
    try { return await apiOnce(token, ep, payload, 60000 + a * 20000); }
    catch (e) { last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

// A page that comes back empty is usually a transient hiccup rather than the end of the table,
// so confirm emptiness a few times before believing it.
async function fetchPage(token, ep, extra, offset, limit) {
  for (let a = 0; a < 4; a += 1) {
    const rows = listRows(await api(token, ep, { searchKey: '', ...extra, limit, offset }));
    if (rows.length) return rows;
    await sleep(1500 * (a + 1));
  }
  return [];
}

// Binary-search the offset of the first row dated <= `to`. Lists are newest-first, so the date
// is (weakly) decreasing in offset. Returns 0 when the newest row is already inside the window.
async function findWindowStart(token, ep, extra, dateField, to, maxOffset) {
  let lo = 0;
  let hi = maxOffset;
  // Establish an upper bound that is actually past the window start (or the end of the table).
  const probe = async (off) => {
    const rows = await fetchPage(token, ep, extra, off, 5);
    return rows.length ? day(rows[0][dateField]) : null; // null = past the end
  };
  const first = await probe(0);
  if (first === null) return { start: 0, empty: true };
  if (first <= to) return { start: 0, empty: false };

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2 / 200) * 200; // land on a page boundary
    if (mid <= lo) break;
    const d = await probe(mid);
    // Past the end of the table, or already inside/below the window -> search earlier.
    if (d === null || d <= to) hi = mid;
    else lo = mid;
  }
  // Back off a few pages: the ordering can wobble on same-date rows, and starting early only
  // costs a couple of pages that the date filter discards anyway.
  return { start: Math.max(0, hi - 1000), empty: false };
}

/**
 * Fetch every row of a live list endpoint whose `dateField` falls in [from, to].
 *
 * @param {object} o
 * @param {string} o.endpoint   e.g. 'get_sales_orders'
 * @param {string} o.from       inclusive YYYY-MM-DD
 * @param {string} o.to         inclusive YYYY-MM-DD
 * @param {string} [o.dateField='DateCreated_TransH']
 * @param {string} o.keyField   row field holding the document number (used to dedupe)
 * @param {object} [o.extra]    extra payload fields, e.g. { viewAll: true }
 * @param {boolean} [o.refresh] ignore any cached file and re-pull
 * @param {number} [o.maxOffset=120000]
 * @param {function} [o.onProgress]
 * @returns {Promise<object[]>} raw live rows, newest-first, deduped by keyField
 */
async function fetchWindow(token, o) {
  const {
    endpoint, from, to, dateField = 'DateCreated_TransH', keyField,
    extra = {}, refresh = false, maxOffset = 120000, onProgress = () => {},
  } = o;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${endpoint}_${from}_${to}.json`);
  if (!refresh && fs.existsSync(cacheFile)) {
    const rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    onProgress(`  [cache] ${endpoint} ${from}..${to}: ${rows.length} row(s) from ${path.basename(cacheFile)}`);
    return rows;
  }

  const { start, empty } = await findWindowStart(token, endpoint, extra, dateField, to, maxOffset);
  if (empty) return [];
  onProgress(`  ${endpoint}: window starts near offset ${start}`);

  const out = [];
  const seen = new Set();
  let belowRuns = 0;
  for (let offset = start; offset < maxOffset; offset += 200) {
    const rows = await fetchPage(token, endpoint, extra, offset, 200);
    if (!rows.length) break;
    for (const row of rows) {
      const d = day(row[dateField]);
      if (d < from || d > to) continue;
      // Dedupe by document number: the same row can appear twice across pages if live inserts
      // while we page, and a duplicate number must never become two local records.
      const k = keyField ? row[keyField] : JSON.stringify(row);
      if (k == null || seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
    // Stop once a whole page sits before the window -- with a couple of pages of grace, since
    // the ordering can wobble around equal dates.
    if (rows.every((r) => day(r[dateField]) < from)) {
      belowRuns += 1;
      if (belowRuns >= 2) break;
    } else belowRuns = 0;
    if ((offset - start) % 4000 === 0) onProgress(`    ...offset ${offset}, kept ${out.length}`);
  }

  fs.writeFileSync(cacheFile, JSON.stringify(out));
  onProgress(`  ${endpoint}: ${out.length} row(s) in window -> cached ${path.basename(cacheFile)}`);
  return out;
}

// A live document is "dead" when it was voided or cancelled -- those must never be migrated.
// Status strings vary by module ("VOID", "CANCELLED", "CANCELLED BY CUSTOMER", ...).
function isVoidOrCancelled(status) {
  const s = (status || '').toString().toUpperCase();
  return s.includes('VOID') || s.includes('CANCEL');
}

module.exports = { SITE, CACHE_DIR, login, api, apiOnce, fetchPage, fetchWindow, listRows, day, sleep, isVoidOrCancelled };
