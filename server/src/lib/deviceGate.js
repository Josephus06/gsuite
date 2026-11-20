// Device gate (asked 2026-11-20): T1S opens only
//   - from the office network (its public IP / LAN range, listed on Registered Devices), on ANY device, or
//   - from a registered device, anywhere.
// Everything else -- the login page included -- is UNREACHABLE: a bare 404 with no page, as if T1S were
// not there (asked the same day: "the link must be unreachable to that device"). No account is exempt.
//
// Only an admin registers a device (no requests from users): on the device itself, on an office
// network, the admin opens /register-device and signs in with their own account (System Admin, or
// can_approve on Registered Devices); the device is approved on the spot.
//
// "Registered device" is a device key, not a MAC address: browsers (and the APK / Windows app, which are
// the live site in a window) cannot read a MAC. The key is a random 256-bit value the server hands the
// device in a long-lived HttpOnly cookie when it is registered; only its SHA-256 is stored. Clearing the
// browser's site data / the app's storage loses the key, and the device must be registered again.
//
// Settings live in app_settings (replicated, so the cloud, office and SM boxes agree):
//   device_gate_enabled   '1' turns the gate on; anything else is off (the default -- deploying this
//                         changes nothing until an admin switches it on from Registered Devices)
//   device_gate_networks  comma-separated IPv4 addresses / CIDRs (or exact IPv6) that count as the office
// Break-glass: DEVICE_GATE=off in a box's server/.env turns the gate off on that box whatever the
// setting says (e.g. the office's public IP changed and nobody can reach the page to fix it).
const crypto = require('crypto');
const pool = require('../db');

const COOKIE = 't1s_dk';
const COOKIE_MAX_AGE_S = 400 * 24 * 3600; // Chrome's ceiling; refreshed on every page load of an approved device
const SETTINGS_TTL_MS = 30_000;
const DEVICE_TTL_MS = 60_000;
const SEEN_THROTTLE_MS = 15 * 60_000;

// Paths that never pass the gate's check:
//  - the health check (the deploy's `curl 127.0.0.1:4000/api/health` comes from no office network)
//  - server-to-server and public-by-design surfaces, each with its own credential: the website's quote
//    and CRM forms, the loyalty feed (API key), and delivery drivers' token links (+ the app code
//    their page needs; /assets is only the built JavaScript/CSS, never data)
// The gate's own registration page and API are NOT here: off the office network they are unreachable too.
const OPEN_PATHS = [
  /^\/api\/health\/?$/,
  /^\/api\/public(\/|$)/,
  /^\/api\/crm-public(\/|$)/,
  /^\/api\/integrations\//,
  /^\/api\/driver\//,
  /^\/driver\/[^/]+\/?$/,
  /^\/assets\//,
];

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const newKey = () => crypto.randomBytes(32).toString('hex');

// ---- client IP & office networks ---------------------------------------------------------------
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return ((Number(p[0]) << 24) >>> 0) + (Number(p[1]) << 16) + (Number(p[2]) << 8) + Number(p[3]);
}
// "14.1.64.248", "192.168.0.0/16" or an exact IPv6 address. Anything else is ignored.
function parseNetwork(entry) {
  const s = String(entry || '').trim();
  if (!s) return null;
  const [addr, bitsRaw] = s.split('/');
  const n = ipv4ToInt(addr);
  if (n !== null) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { text: s, v4: true, base: (n & mask) >>> 0, mask };
  }
  if (addr.includes(':') && bitsRaw === undefined) return { text: s, v4: false, exact: addr.toLowerCase() };
  return null;
}
function isValidNetwork(entry) { return !!parseNetwork(entry); }
function ipInNetworks(ip, networks) {
  const n = ipv4ToInt(ip);
  return networks.some((net) => (net.v4 ? n !== null && ((n & net.mask) >>> 0) === net.base : ip.toLowerCase() === net.exact));
}

// ---- settings ----------------------------------------------------------------------------------
let settingsCache = { at: 0, value: { enabled: false, networks: [], networksText: [] } };
async function loadSettings(force = false) {
  if (!force && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  try {
    const [rows] = await pool.query("SELECT name, value FROM app_settings WHERE name IN ('device_gate_enabled', 'device_gate_networks')");
    const m = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    const networksText = String(m.device_gate_networks || '').split(',').map((s) => s.trim()).filter(Boolean);
    settingsCache = {
      at: Date.now(),
      value: { enabled: m.device_gate_enabled === '1', networks: networksText.map(parseNetwork).filter(Boolean), networksText },
    };
  } catch (err) {
    // No table yet (migration not run) or the database is down: keep the last known settings -- off
    // if there never were any -- rather than locking everyone out on a read error.
    if (!settingsCache.at) console.warn('[device-gate] could not read settings; gate stays off:', err.code || err.message);
    settingsCache.at = Date.now();
  }
  return settingsCache.value;
}
function forcedOff() { return String(process.env.DEVICE_GATE || '').toLowerCase() === 'off'; }
function clearSettingsCache() { settingsCache.at = 0; }

// ---- device lookup -----------------------------------------------------------------------------
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
function setDeviceCookie(req, res, key) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
  res.append('Set-Cookie', `${COOKIE}=${key}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

const deviceCache = new Map(); // key hash -> { at, row }
async function findDevice(keyHash) {
  const hit = deviceCache.get(keyHash);
  if (hit && Date.now() - hit.at < DEVICE_TTL_MS) return hit.row;
  const [[row]] = await pool.query(
    'SELECT id, status, device_name, last_seen_at FROM registered_devices WHERE key_hash = ?', [keyHash],
  );
  deviceCache.set(keyHash, { at: Date.now(), row: row || null });
  if (deviceCache.size > 5000) deviceCache.clear();
  return row || null;
}
function forgetDevice(keyHash) { if (keyHash) deviceCache.delete(keyHash); else deviceCache.clear(); }

// last_seen is a convenience, never worth a stuck request: throttled per device, one write in flight
// at a time (a full disk wedged every write on the office box on 2026-11-20).
const lastSeenAt = new Map();
let seenInFlight = 0;
function touchDevice(id, ip) {
  const prev = lastSeenAt.get(id);
  if (prev && Date.now() - prev < SEEN_THROTTLE_MS) return;
  if (seenInFlight >= 1) return;
  lastSeenAt.set(id, Date.now());
  seenInFlight += 1;
  pool.query('UPDATE registered_devices SET last_seen_at = NOW(), last_seen_ip = ? WHERE id = ?', [ip.slice(0, 64), id])
    .catch(() => {}).finally(() => { seenInFlight -= 1; });
}

// What the gate decides for this request: { allowed, reason: 'off' | 'office' | 'device' | 'blocked', device }
async function evaluate(req, settingsOverride = null) {
  const settings = settingsOverride || await loadSettings();
  if (forcedOff() || !settings.enabled) return { allowed: true, reason: 'off' };
  const ip = clientIp(req);
  if (ipInNetworks(ip, settings.networks)) return { allowed: true, reason: 'office', ip };
  const key = readCookie(req, COOKIE);
  if (key && /^[0-9a-f]{64}$/.test(key)) {
    const device = await findDevice(hashKey(key));
    if (device && device.status === 'approved') return { allowed: true, reason: 'device', device, key, ip };
    return { allowed: false, reason: 'blocked', device, ip };
  }
  return { allowed: false, reason: 'blocked', device: null, ip };
}

function wantsHtml(req) {
  return req.method === 'GET' && !req.path.startsWith('/api/') && String(req.headers.accept || '').includes('text/html');
}

// /register-device: where an admin registers the device in hand. Reachable only where T1S itself is --
// an office network, an already-registered device, or while the gate is off.
const REGISTER_PATH = /^\/register-device\/?$/;

function middleware() {
  return async (req, res, next) => {
    const isRegister = req.method === 'GET' && REGISTER_PATH.test(req.path);
    if (!isRegister && OPEN_PATHS.some((re) => re.test(req.path))) return next();
    let verdict;
    try { verdict = await evaluate(req); } catch (err) { return next(err); }
    if (verdict.allowed) {
      if (verdict.reason === 'device') {
        touchDevice(verdict.device.id, verdict.ip);
        if (wantsHtml(req)) setDeviceCookie(req, res, verdict.key); // keeps the 400-day cookie rolling
      }
      if (isRegister) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).type('html').send(REGISTER_HTML);
      }
      return next();
    }
    // Unregistered, off the office network: nothing to see. A bare 404 -- the browser shows its own
    // "page can't be found", the APK its offline page. The API's 404 carries a code only so an app
    // already open (access just removed) knows to reload into that.
    res.setHeader('Cache-Control', 'no-store');
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found', code: 'DEVICE_NOT_REGISTERED' });
    return res.status(404).end();
  };
}

// The registration page an admin opens on the device being registered. Self-contained (no app bundle).
const REGISTER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>T1S - Register this device</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1f2937;
    background: linear-gradient(160deg, #0b1630, #13224a 60%, #0a1328); }
  .card { width: 100%; max-width: 420px; background: #fff; border-radius: 14px; padding: 28px 24px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
  .icon { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; background: #ede9fe; color: #6d5bd0; font-size: 26px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 14px; color: #4b5563; }
  label { display: block; font-size: 13px; color: #374151; margin: 10px 0 4px; }
  input { width: 100%; padding: 10px 12px; font: inherit; border: 1px solid #cbd5e1; border-radius: 8px; }
  input:focus { outline: 2px solid #6d5bd0; border-color: transparent; }
  button { width: 100%; margin-top: 16px; padding: 11px; font: inherit; font-weight: 600; color: #fff; background: #6d5bd0; border: 0; border-radius: 8px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .err { color: #b91c1c; font-size: 13px; margin-top: 10px; min-height: 1em; }
  .muted { font-size: 12px; color: #6b7280; margin-top: 16px; }
  .center { text-align: center; }
  .hidden { display: none; }
</style></head>
<body><div class="card">
  <div id="form-view">
    <div class="icon">&#128274;</div>
    <h1>Register this device</h1>
    <p>For administrators. Off the office network - on mobile data or at home - T1S opens only on a registered device. Sign in with <strong>your admin account</strong> on this device to register it.</p>
    <form id="f">
      <label for="u">Admin username or email</label><input id="u" autocomplete="username" required>
      <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
      <label for="dn">Name this device</label><input id="dn" maxlength="100" required>
      <label for="ow">Who uses it (optional)</label><input id="ow" maxlength="100" placeholder="e.g. Juan Dela Cruz">
      <button id="b" type="submit">Register this device</button>
      <div class="err" id="e"></div>
    </form>
  </div>
  <div id="done-view" class="hidden center">
    <div class="icon" style="background:#dcfce7;color:#15803d;margin:0 auto 12px">&#10003;</div>
    <h1>This device is registered</h1>
    <p id="done-text">It can open T1S on any network, including mobile data.</p>
    <button type="button" onclick="location.href='/'">Open T1S</button>
  </div>
  <div class="muted" id="ip"></div>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ua = navigator.userAgent;
  var guess = /Android/i.test(ua) ? 'Android phone' : /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad'
    : /Windows/i.test(ua) ? 'Windows PC' : /Mac OS X/i.test(ua) ? 'Mac' : 'Device';
  if (/Electron|T1S/i.test(ua)) guess += ' (T1S app)';
  $('dn').placeholder = 'e.g. ' + guess;
  function show(done, name) {
    $('form-view').classList.toggle('hidden', done);
    $('done-view').classList.toggle('hidden', !done);
    if (done && name) $('done-text').textContent = '"' + name + '" can open T1S on any network, including mobile data.';
  }
  fetch('/api/device-gate/status', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.ip) $('ip').textContent = 'Network address: ' + s.ip;
      if (s.state === 'approved') show(true, s.device_name);
      else if (s.state === 'revoked') $('e').textContent = 'This device’s access was removed. Register it again to restore it.';
    })
    .catch(function () {});
  $('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('b').disabled = true; $('e').textContent = '';
    var name = $('dn').value.trim() || guess;
    if ($('ow').value.trim()) name += ' - ' + $('ow').value.trim();
    fetch('/api/device-gate/register', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('u').value, password: $('pw').value, device_name: name }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        $('b').disabled = false; $('pw').value = '';
        if (!x.ok) { $('e').textContent = x.j.error || 'Could not register this device.'; return; }
        show(true, name);
      })
      .catch(function () { $('b').disabled = false; $('e').textContent = 'Could not reach T1S.'; });
  });
})();
</script>
</body></html>`;

module.exports = {
  COOKIE, middleware, evaluate, loadSettings, clearSettingsCache, forcedOff, clientIp, readCookie,
  setDeviceCookie, hashKey, newKey, forgetDevice, isValidNetwork, parseNetwork, ipInNetworks,
};
