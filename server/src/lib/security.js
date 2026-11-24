// Security hardening (asked 2026-11-24): response headers, the Content-Security-Policy, and rate limits.
// Written in-house rather than adding helmet / express-rate-limit: a few dozen lines, no new
// third-party code on the server, nothing extra to install on deploy.
//
// RATE LIMITS ARE PER USER, NOT PER IP, wherever there is a user. Every office PC reaches the cloud
// from ONE public address (14.1.64.248), so "N requests per IP" would throttle the whole office the
// moment a few people worked at once. Only sign-in and the public (no-login) endpoints are limited by
// IP, and their limits are set high enough for an office behind one address.
//
// Limits are in memory, per server process: a restart clears them, and each box (cloud, office, SM)
// counts its own -- fine for slowing guessing and runaway scripts, which is what they are for.

// ---- headers -----------------------------------------------------------------------------------
//
// CSP is REPORT-ONLY for now (decided 2026-11-24): browsers block nothing, they report what the
// policy WOULD block to /api/security/csp-report, which logs it. Once those reports are clean, set
// CSP_ENFORCE=1 in server/.env to switch the same policy to enforcing.
//  - 'unsafe-inline' for styles: the app's print pages and components use <style> blocks and style
//    attributes everywhere; scripts stay strict ('self' only).
//  - img https: -- map tiles and remote images; data:/blob: -- uploads previewed before saving.
//  - Google Fonts -- the DA Report presentation.
//  - The device gate's registration page has one inline script: it sends its own header (below).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'report-uri /api/security/csp-report',
].join('; ');

function securityHeaders() {
  const enforce = process.env.CSP_ENFORCE === '1';
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Only this site may put T1S in a frame (clickjacking).
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Camera / microphone / location stay available to T1S itself (attendance, driver runs) and to nothing embedded in it.
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    // HTTPS only from here on (a year). Browsers ignore it on plain-http (the office LAN box).
    // Not includeSubDomains: other graphicstar.ph sites are not ours to force.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader(enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', CSP);
    next();
  };
}

// CSP violation reports: logged (one line each), the same violation at most once an hour so a busy
// page cannot flood the journal. `journalctl -u gsuite | grep '\[csp\]'`.
const seenReports = new Map();
function cspReportHandler(req, res) {
  try {
    const body = req.body || {};
    const r = body['csp-report'] || (Array.isArray(body) ? body[0]?.body : body.body) || body;
    const key = `${r['violated-directive'] || r.effectiveDirective || '?'}|${r['blocked-uri'] || r.blockedURL || '?'}`;
    const now = Date.now();
    if (!seenReports.has(key) || now - seenReports.get(key) > 3600000) {
      seenReports.set(key, now);
      if (seenReports.size > 2000) seenReports.clear();
      console.warn(`[csp] would block ${key.replace('|', ' -> ')} on ${String(r['document-uri'] || r.documentURL || '').slice(0, 200)}`);
    }
  } catch { /* a malformed report is not worth an error */ }
  res.status(204).end();
}

// ---- rate limiting -----------------------------------------------------------------------------
//
// A fixed window per key: at most `max` hits per `windowMs`. Returns { ok, retryAfter }.
function makeLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { start, n }
  return {
    hit(key) {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || now - h.start >= windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
      h.n += 1;
      if (hits.size > 50000) hits.clear(); // a flood of distinct keys must not grow memory without bound
      return h.n > max ? { ok: false, retryAfter: Math.ceil((h.start + windowMs - now) / 1000) } : { ok: true };
    },
    peek(key) {
      const h = hits.get(key);
      return h && Date.now() - h.start < windowMs ? h.n : 0;
    },
    clear(key) { hits.delete(key); },
  };
}
const tooMany = (res, retryAfter, msg) => {
  res.setHeader('Retry-After', String(retryAfter || 60));
  return res.status(429).json({ error: msg || 'Too many requests. Please wait a moment and try again.' });
};

// Signed-in API use, per user: 1,200 a minute (20 a second) -- far above any person, chat polling
// included, but it stops a runaway script or a leaked token hammering the server.
const userLimiter = makeLimiter({ windowMs: 60_000, max: 1200 });
function userRateLimit(userId, res) {
  const r = userLimiter.hit(`u${userId}`);
  if (!r.ok) { tooMany(res, r.retryAfter); return false; }
  return true;
}

// The public, no-login endpoints (website quote form, drivers' links, unsubscribe, device gate,
// loyalty feed), per IP: 300 a minute -- the whole office behind one address stays well inside.
const publicLimiter = makeLimiter({ windowMs: 60_000, max: 300 });
const PUBLIC_PREFIXES = ['/api/public', '/api/crm-public', '/api/driver', '/api/device-gate', '/api/integrations', '/api/security/csp-report'];
function publicRateLimit() {
  return (req, res, next) => {
    if (!PUBLIC_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    const r = publicLimiter.hit(`ip${req.ip}`);
    return r.ok ? next() : tooMany(res, r.retryAfter);
  };
}

// Sign-in: FAILED attempts only, so a busy office logging in at 8 AM is never slowed.
//   per account  10 failures in 15 minutes -> that account refuses sign-in for the rest of the window
//   per IP       100 failures in 15 minutes -> that address does (high: the office shares one IP)
// A successful sign-in clears its account's count.
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginByAccount = makeLimiter({ windowMs: LOGIN_WINDOW_MS, max: 10 });
const loginByIp = makeLimiter({ windowMs: LOGIN_WINDOW_MS, max: 100 });
const acctKey = (identifier) => `a:${String(identifier || '').trim().toLowerCase()}`;
function loginBlocked(req, identifier) {
  if (loginByAccount.peek(acctKey(identifier)) >= 10) return 'Too many failed sign-ins for this account. Try again in 15 minutes.';
  if (loginByIp.peek(`ip${req.ip}`) >= 100) return 'Too many failed sign-ins from this network. Try again in 15 minutes.';
  return null;
}
function loginFailed(req, identifier) { loginByAccount.hit(acctKey(identifier)); loginByIp.hit(`ip${req.ip}`); }
function loginSucceeded(identifier) { loginByAccount.clear(acctKey(identifier)); }

module.exports = {
  securityHeaders, cspReportHandler, publicRateLimit, userRateLimit,
  loginBlocked, loginFailed, loginSucceeded, makeLimiter, CSP,
};
