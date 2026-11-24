// Device gate routes (see lib/deviceGate.js).
//
//   /api/device-gate         what /register-device calls (behind the gate like everything else)
//     GET  /status           this device's state: none / approved / revoked
//     POST /register         an ADMIN signs in on the device and registers it, approved at once
//
//   /api/registered-devices  Registered Devices page (System > Registered Devices)
//     GET  /                 settings, this request's IP / verdict, every device
//     PUT  /settings         { enabled, networks[] } -- refuses a change that would shut out the admin making it
//     POST /:id/approve | /:id/revoke   restore / remove access
//     PUT  /:id              { device_name }
//     DELETE /:id
const express = require('express');
const pool = require('../db');
const { findLoginUser, AMBIGUOUS_MESSAGE } = require('../lib/loginLookup');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const gate = require('../lib/deviceGate');

const ROUTE = '/registered-devices';
const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));

// ---------------------------------------------------------------------------------------------
const publicRouter = express.Router();

// Requests are sign-ins, so they get the same kind of brake a login would want: 10 per IP per 10 min.
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 10_000) attempts.clear();
  return list.length > 10;
}

publicRouter.get('/status', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const verdict = await gate.evaluate(req);
    const out = { allowed: verdict.allowed, ip: gate.clientIp(req), state: 'none' };
    const key = gate.readCookie(req, gate.COOKIE);
    if (key && /^[0-9a-f]{64}$/.test(key)) {
      const [[d]] = await pool.query(
        `SELECT d.status, d.device_name, COALESCE(u.display_name, u.username) AS requested_by
           FROM registered_devices d LEFT JOIN users u ON u.id = d.requested_by WHERE d.key_hash = ?`,
        [gate.hashKey(key)],
      );
      if (d) Object.assign(out, { state: d.status, device_name: d.device_name, requested_by: d.requested_by });
    }
    res.json(out);
  } catch (err) { next(err); }
});

// An admin registers the device this request comes from -- approved at once. Signing in here needs
// System Admin or can_approve on Registered Devices; anyone else is refused (users cannot ask).
// The gate's middleware already keeps this unreachable off the office network for unregistered devices.
publicRouter.post('/register', async (req, res, next) => {
  try {
    const ip = gate.clientIp(req);
    if (limited(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    const { username, password } = req.body || {};
    const deviceName = trunc(req.body?.device_name, 100);
    if (!username || !password) return res.status(400).json({ error: 'Type the admin username and password.' });
    if (!deviceName) return res.status(400).json({ error: 'Give this device a name.' });

    // Several accounts may share an email (2026-11-24): lib/loginLookup.js picks the right one.
    const found = await findLoginUser(username, password);
    if (found.error === 'ambiguous') return res.status(401).json({ error: AMBIGUOUS_MESSAGE });
    if (!found.user) return res.status(401).json({ error: 'Wrong username or password.' });
    const { user } = found;
    if (!(await userCan(user.id, ROUTE, 'can_approve'))) {
      return res.status(403).json({ error: 'Only an administrator can register a device.' });
    }

    const agent = trunc(req.headers['user-agent'], 255);
    const existingKey = gate.readCookie(req, gate.COOKIE);
    let key = existingKey && /^[0-9a-f]{64}$/.test(existingKey) ? existingKey : null;
    let row = null;
    if (key) [[row]] = await pool.query('SELECT id FROM registered_devices WHERE key_hash = ?', [gate.hashKey(key)]);
    if (row) {
      // Re-registering (e.g. after its access was removed), or renaming: approved again by this admin.
      await pool.query(
        `UPDATE registered_devices SET status = 'approved', device_name = ?, user_agent = ?, requested_by = ?,
                requested_ip = ?, requested_at = NOW(), decided_by = ?, decided_at = NOW() WHERE id = ?`,
        [deviceName, agent, user.id, ip.slice(0, 64), user.id, row.id],
      );
    } else {
      key = gate.newKey();
      await pool.query(
        `INSERT INTO registered_devices (key_hash, device_name, user_agent, status, requested_by, requested_ip, requested_at, decided_by, decided_at)
         VALUES (?, ?, ?, 'approved', ?, ?, NOW(), ?, NOW())`,
        [gate.hashKey(key), deviceName, agent, user.id, ip.slice(0, 64), user.id],
      );
    }
    gate.forgetDevice(gate.hashKey(key));
    gate.setDeviceCookie(req, res, key);
    res.json({ ok: true, state: 'approved' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------------
const adminRouter = express.Router();
adminRouter.use(requireAuth);

adminRouter.get('/', requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const settings = await gate.loadSettings(true);
    const verdict = await gate.evaluate(req, { ...settings, enabled: true }); // as if it were on
    const [devices] = await pool.query(
      `SELECT d.id, d.device_name, d.user_agent, d.status, d.requested_ip, d.requested_at, d.decided_at,
              d.last_seen_at, d.last_seen_ip,
              COALESCE(r.display_name, r.username) AS requested_by_name,
              COALESCE(a.display_name, a.username) AS decided_by_name
         FROM registered_devices d
         LEFT JOIN users r ON r.id = d.requested_by
         LEFT JOIN users a ON a.id = d.decided_by
        ORDER BY FIELD(d.status, 'pending', 'approved', 'rejected', 'revoked'), d.requested_at DESC`,
    );
    res.json({
      enabled: settings.enabled,
      forced_off: gate.forcedOff(),
      networks: settings.networksText,
      your_ip: gate.clientIp(req),
      you_would_be: verdict.allowed ? verdict.reason : 'blocked',
      devices,
    });
  } catch (err) { next(err); }
});

adminRouter.put('/settings', requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const enabled = !!req.body?.enabled;
    const networks = (Array.isArray(req.body?.networks) ? req.body.networks : [])
      .map((s) => String(s).trim()).filter(Boolean);
    const bad = networks.filter((n) => !gate.isValidNetwork(n));
    if (bad.length) return res.status(400).json({ error: `Not an IP address or range: ${bad.join(', ')}` });
    const text = [...new Set(networks)].join(',');
    if (text.length > 255) return res.status(400).json({ error: 'Too many office networks (255 characters at most).' });

    // Never let the change shut out the admin who is making it.
    if (enabled) {
      const verdict = await gate.evaluate(req, { enabled: true, networks: text.split(',').filter(Boolean).map(gate.parseNetwork).filter(Boolean), networksText: [] });
      if (!verdict.allowed) {
        return res.status(409).json({
          error: `Turning this on now would lock you out: your address ${gate.clientIp(req)} is not an office network and this device is not approved. Add the office network or register and approve this device first.`,
        });
      }
    }
    await pool.query(
      `INSERT INTO app_settings (name, value) VALUES ('device_gate_enabled', ?), ('device_gate_networks', ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [enabled ? '1' : '0', text],
    );
    gate.clearSettingsCache();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

async function decide(req, res, next, status, allowedFrom) {
  try {
    const [[d]] = await pool.query('SELECT id, key_hash, status FROM registered_devices WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Device not found.' });
    if (!allowedFrom.includes(d.status)) return res.status(409).json({ error: `This device is already ${d.status}.` });
    await pool.query('UPDATE registered_devices SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ?', [status, req.user.id, d.id]);
    gate.forgetDevice(d.key_hash);
    res.json({ ok: true });
  } catch (err) { next(err); }
}
// Restore a removed device's access (its key is still on it), or remove it.
adminRouter.post('/:id/approve', requirePermission(ROUTE, 'can_approve'), (req, res, next) => decide(req, res, next, 'approved', ['pending', 'rejected', 'revoked']));
adminRouter.post('/:id/revoke', requirePermission(ROUTE, 'can_approve'), (req, res, next) => decide(req, res, next, 'revoked', ['approved']));

adminRouter.put('/:id', requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const name = trunc(req.body?.device_name, 100);
    if (!name) return res.status(400).json({ error: 'A device needs a name.' });
    await pool.query('UPDATE registered_devices SET device_name = ? WHERE id = ?', [name, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

adminRouter.delete('/:id', requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query('SELECT key_hash FROM registered_devices WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Device not found.' });
    await pool.query('DELETE FROM registered_devices WHERE id = ?', [req.params.id]);
    gate.forgetDevice(d.key_hash);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { publicRouter, adminRouter };
