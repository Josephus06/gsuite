const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');
const mailer = require('../lib/mailer');
const {
  isConfigured, assertConfigured, encryptSecret, decryptSecret,
  generateCode, hashCodeForStorage, codeMatchesStored, CODE_DIGITS, KEY_VERSION,
} = require('../lib/archiverCrypto');

const router = express.Router();

// The Archiver: a vault for the credentials behind the company's subscriptions, licences and
// accounts.
//
// Three rules run through every route here, and they are the module:
//
//   1. NO ENDPOINT RETURNS A SECRET EXCEPT ONE. Lists and detail views return metadata only --
//      the ciphertext columns are never selected outside the reveal path, so a secret cannot leak
//      through a response somebody forgot to think about.
//
//   2. A REVEAL COSTS A FRESH EMAILED CODE. Every time. The code is single-use, expires in five
//      minutes, is stored hashed, and is rate-limited.
//
//   3. EVERYTHING IS LOGGED -- reveals, failed codes, share changes, secret updates. The log is
//      append-only: no route in this file edits or deletes from it.
//
// Page permission decides who may use the Archiver at all; archive_entry_shares decides which
// entries a given person can see. Someone with no share does not learn that an entry exists.
const ROUTE = '/archiver';

const ENTRY_TYPES = new Set(['subscription', 'licence', 'account', 'api_key', 'certificate', 'other']);
const STATUSES = new Set(['active', 'expired', 'cancelled', 'archived']);
const BILLING_CYCLES = new Set(['monthly', 'quarterly', 'semi_annual', 'annual', 'perpetual', 'one_time']);

const CODE_TTL_MINUTES = 5;
const MAX_CODE_ATTEMPTS = 5;
// A person opening more than this many secrets in an hour is either doing a bulk export or is not
// the person. Either way it is worth stopping and worth someone noticing.
const REVEALS_PER_HOUR = 20;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const idOrNull = (v) => (v == null || v === '' ? null : v);
const numOrNull = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Every column EXCEPT the three that hold the secret. Written out once and reused, so no query can
// accidentally widen into the ciphertext.
const SAFE_COLUMNS = `e.id, e.entry_no, e.title, e.entry_type, e.category_id, e.vendor, e.url,
  e.username, e.has_secret, e.notes, e.account_reference, e.renews_on, e.expires_on, e.cost,
  e.billing_cycle, e.owner_user_id, e.department_id, e.status, e.created_by_user_id, e.created_at,
  e.updated_at, e.secret_updated_at`;

async function logAccess(conn, req, { entryId, action, outcome = 'success', detail = null }) {
  await (conn || pool).query(
    `INSERT INTO archive_access_logs (entry_id, user_id, action, outcome, detail, ip_address, user_agent)
     VALUES (?,?,?,?,?,?,?)`,
    [entryId || null, req.user?.id || null, action, outcome, trunc(detail, 500),
      trunc(req.ip || req.headers['x-forwarded-for'] || null, 64),
      trunc(req.headers['user-agent'] || null, 255)],
  );
}

// What this user may do with one entry.
//
// Owner and System Admin get everything -- a company vault whose credentials die with whoever
// created them is not doing its job. Everyone else needs an explicit share, and the share says
// separately whether they may merely SEE the entry or actually reveal its secret: knowing a
// subscription exists and when it renews is a different thing from holding its password.
async function entryAccess(userId, entryId, conn) {
  const q = conn || pool;
  const [[entry]] = await q.query('SELECT id, owner_user_id, title, entry_no FROM archive_entries WHERE id = ?', [entryId]);
  if (!entry) return { found: false, canView: false, canReveal: false, canEdit: false };

  if (await isSystemAdmin(userId)) return { found: true, entry, canView: true, canReveal: true, canEdit: true, via: 'system_admin' };
  if (String(entry.owner_user_id) === String(userId)) return { found: true, entry, canView: true, canReveal: true, canEdit: true, via: 'owner' };

  const [[share]] = await q.query('SELECT can_reveal, can_edit FROM archive_entry_shares WHERE entry_id = ? AND user_id = ?', [entryId, userId]);
  if (!share) return { found: true, entry, canView: false, canReveal: false, canEdit: false };
  return { found: true, entry, canView: true, canReveal: !!share.can_reveal, canEdit: !!share.can_edit, via: 'share' };
}

// Restricts a list to entries this user may see. System Admin is unrestricted; everyone else sees
// what they own or have been shared.
async function visibilityClause(userId) {
  if (await isSystemAdmin(userId)) return { sql: null, params: [] };
  return {
    sql: '(e.owner_user_id = ? OR EXISTS (SELECT 1 FROM archive_entry_shares s WHERE s.entry_id = e.id AND s.user_id = ?))',
    params: [userId, userId],
  };
}

// A 404 rather than a 403 when someone has no share. A 403 would confirm the entry exists, which
// tells an unauthorised person something about the vault's contents.
function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [categories] = await pool.query('SELECT id, name, description FROM archive_categories WHERE is_active = TRUE ORDER BY name');
    const [users] = await pool.query(
      "SELECT id, display_name, username, email FROM users WHERE is_active = TRUE ORDER BY display_name",
    );
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [[me]] = await pool.query('SELECT email FROM users WHERE id = ?', [req.user.id]);

    res.json({
      categories,
      users,
      departments,
      entry_types: [...ENTRY_TYPES],
      statuses: [...STATUSES],
      billing_cycles: [...BILLING_CYCLES],
      // The client shows a clear banner rather than letting someone fill in a form that cannot save.
      vault_configured: isConfigured(),
      email_configured: mailer.isConfigured(),
      // Masked, so the reveal dialog can say where the code is going without printing an address
      // in full on a shared screen.
      my_email_hint: me?.email ? me.email.replace(/^(.).*(.@.*)$/, (m, a, b) => `${a}****${b}`) : null,
      code_digits: CODE_DIGITS,
      code_ttl_minutes: CODE_TTL_MINUTES,
    });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, category_id: categoryId, entry_type: entryType, status, expiring } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));

    const where = [];
    const params = [];
    const vis = await visibilityClause(req.user.id);
    if (vis.sql) { where.push(vis.sql); params.push(...vis.params); }

    if (categoryId) { where.push('e.category_id = ?'); params.push(categoryId); }
    if (entryType) { where.push('e.entry_type = ?'); params.push(entryType); }
    if (status) { where.push('e.status = ?'); params.push(status); }
    // Renewals inside 30 days -- the practical reason to open this page other than to fetch a
    // password.
    if (expiring === 'yes') where.push('((e.renews_on IS NOT NULL AND e.renews_on <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)) OR (e.expires_on IS NOT NULL AND e.expires_on <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)))');
    if (search) {
      // Deliberately does NOT search notes: notes are free text people paste recovery answers into,
      // and a search that matches them would leak their content through result membership.
      where.push('(e.title LIKE ? OR e.vendor LIKE ? OR e.username LIKE ? OR e.entry_no LIKE ? OR e.account_reference LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM archive_entries e ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS}, c.name AS category_name, o.display_name AS owner_name, d.name AS department_name,
              (SELECT COUNT(*) FROM archive_entry_shares s WHERE s.entry_id = e.id) AS share_count
         FROM archive_entries e
         LEFT JOIN archive_categories c ON c.id = e.category_id
         LEFT JOIN users o ON o.id = e.owner_user_id
         LEFT JOIN departments d ON d.id = e.department_id
         ${whereSql} ORDER BY e.title LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const access = await entryAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return notFound(res);

    const [[entry]] = await pool.query(
      `SELECT ${SAFE_COLUMNS}, c.name AS category_name, o.display_name AS owner_name,
              d.name AS department_name, cb.display_name AS created_by_name, ub.display_name AS updated_by_name
         FROM archive_entries e
         LEFT JOIN archive_categories c ON c.id = e.category_id
         LEFT JOIN users o ON o.id = e.owner_user_id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN users cb ON cb.id = e.created_by_user_id
         LEFT JOIN users ub ON ub.id = e.updated_by_user_id
        WHERE e.id = ?`,
      [req.params.id],
    );
    const [shares] = await pool.query(
      `SELECT s.*, u.display_name, u.username, g.display_name AS granted_by_name
         FROM archive_entry_shares s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN users g ON g.id = s.granted_by_user_id
        WHERE s.entry_id = ? ORDER BY u.display_name`,
      [req.params.id],
    );
    res.json({
      ...entry,
      shares,
      my_access: { can_reveal: access.canReveal, can_edit: access.canEdit, via: access.via || null },
    });
  } catch (err) { next(err); }
});

// The access log for one entry. Visible to anyone who can see the entry -- knowing who else has
// opened a credential you also hold is part of what makes the log useful.
router.get('/:id/access-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const access = await entryAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return notFound(res);
    const [rows] = await pool.query(
      `SELECT l.id, l.action, l.outcome, l.detail, l.created_at, u.display_name AS user_name
         FROM archive_access_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entry_id = ? ORDER BY l.created_at DESC LIMIT 200`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function validateEntry(b) {
  if (!b.title || !String(b.title).trim()) return 'A title is required.';
  if (b.entry_type && !ENTRY_TYPES.has(b.entry_type)) return `Unknown type: ${b.entry_type}`;
  if (b.status && !STATUSES.has(b.status)) return `Unknown status: ${b.status}`;
  if (b.billing_cycle && !BILLING_CYCLES.has(b.billing_cycle)) return `Unknown billing cycle: ${b.billing_cycle}`;
  return null;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const problem = validateEntry(b);
    if (problem) return res.status(400).json({ error: problem });
    // Refuse rather than silently storing the secret in the clear.
    if (b.secret) assertConfigured();

    const enc = b.secret ? encryptSecret(b.secret) : null;

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO archive_entries
         (entry_no, title, entry_type, category_id, vendor, url, username,
          secret_ciphertext, secret_iv, secret_tag, key_version, has_secret,
          notes, account_reference, renews_on, expires_on, cost, billing_cycle,
          owner_user_id, department_id, status, created_by_user_id, secret_updated_at)
       VALUES ('', ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?)`,
      [trunc(b.title, 200), b.entry_type || 'subscription', idOrNull(b.category_id), trunc(b.vendor, 200),
        trunc(b.url, 500), trunc(b.username, 255),
        enc ? enc.ciphertext : null, enc ? enc.iv : null, enc ? enc.tag : null, KEY_VERSION, !!enc,
        trunc(b.notes, 2000), trunc(b.account_reference, 200), b.renews_on || null, b.expires_on || null,
        numOrNull(b.cost), b.billing_cycle || null,
        idOrNull(b.owner_user_id) || req.user.id, idOrNull(b.department_id), b.status || 'active',
        req.user.id, enc ? new Date() : null],
    );
    const entryId = r.insertId;
    const entryNo = `ARC-${entryId}`;
    await conn.query('UPDATE archive_entries SET entry_no = ? WHERE id = ?', [entryNo, entryId]);

    for (const s of (Array.isArray(b.shares) ? b.shares : [])) {
      if (!s.user_id || String(s.user_id) === String(idOrNull(b.owner_user_id) || req.user.id)) continue;
      await conn.query(
        `INSERT IGNORE INTO archive_entry_shares (entry_id, user_id, can_reveal, can_edit, granted_by_user_id)
         VALUES (?,?,?,?,?)`,
        [entryId, s.user_id, s.can_reveal !== false, !!s.can_edit, req.user.id],
      );
    }
    await logAccess(conn, req, { entryId, action: 'created', detail: entryNo });
    await conn.commit();
    res.status(201).json({ id: entryId, entry_no: entryNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Editing never touches the secret unless a new one is supplied. An empty `secret` field on the
// form means "leave it alone", not "clear it" -- otherwise every metadata edit by someone who
// cannot reveal the secret would wipe it.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const access = await entryAccess(req.user.id, req.params.id, conn);
    if (!access.found || !access.canView) return notFound(res);
    if (!access.canEdit) return res.status(403).json({ error: 'You do not have edit access to this entry.' });
    const problem = validateEntry(b);
    if (problem) return res.status(400).json({ error: problem });

    const changingSecret = typeof b.secret === 'string' && b.secret.length > 0;
    if (changingSecret) assertConfigured();
    const enc = changingSecret ? encryptSecret(b.secret) : null;

    await conn.beginTransaction();
    await conn.query(
      `UPDATE archive_entries SET title = ?, entry_type = ?, category_id = ?, vendor = ?, url = ?, username = ?,
              notes = ?, account_reference = ?, renews_on = ?, expires_on = ?, cost = ?, billing_cycle = ?,
              owner_user_id = ?, department_id = ?, status = ?, updated_by_user_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [trunc(b.title, 200), b.entry_type || 'subscription', idOrNull(b.category_id), trunc(b.vendor, 200),
        trunc(b.url, 500), trunc(b.username, 255), trunc(b.notes, 2000), trunc(b.account_reference, 200),
        b.renews_on || null, b.expires_on || null, numOrNull(b.cost), b.billing_cycle || null,
        idOrNull(b.owner_user_id) || access.entry.owner_user_id, idOrNull(b.department_id),
        b.status || 'active', req.user.id, req.params.id],
    );
    if (enc) {
      await conn.query(
        `UPDATE archive_entries SET secret_ciphertext = ?, secret_iv = ?, secret_tag = ?, key_version = ?,
                has_secret = TRUE, secret_updated_at = NOW() WHERE id = ?`,
        [enc.ciphertext, enc.iv, enc.tag, KEY_VERSION, req.params.id],
      );
      await logAccess(conn, req, { entryId: req.params.id, action: 'secret_updated' });
    }
    await logAccess(conn, req, { entryId: req.params.id, action: 'updated' });
    await conn.commit();
    res.json({ ok: true, secret_changed: !!enc });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// --- Step-up verification and reveal ----------------------------------------------------------

// Ask for a code. Sends a six-digit code to the user's own registered email -- never to an address
// supplied in the request, which would let anyone with the entry id redirect the challenge.
router.post('/:id/request-code', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const access = await entryAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return notFound(res);
    if (!access.canReveal) {
      await logAccess(null, req, { entryId: req.params.id, action: 'request_code', outcome: 'denied', detail: 'no reveal permission' });
      return res.status(403).json({ error: 'You may see this entry but not reveal its secret.' });
    }
    assertConfigured();

    const [[{ n: recent }]] = await pool.query(
      "SELECT COUNT(*) n FROM archive_access_logs WHERE user_id = ? AND action = 'revealed' AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)",
      [req.user.id],
    );
    if (recent >= REVEALS_PER_HOUR) {
      await logAccess(null, req, { entryId: req.params.id, action: 'request_code', outcome: 'rate_limited', detail: `${recent} reveals in the last hour` });
      return res.status(429).json({ error: `You have revealed ${recent} secrets in the last hour. Try again later.` });
    }

    const [[user]] = await pool.query('SELECT email, display_name FROM users WHERE id = ?', [req.user.id]);
    if (!user?.email) return res.status(400).json({ error: 'Your account has no email address, so a code cannot be sent.' });
    if (!mailer.isConfigured()) {
      return res.status(503).json({ error: `Email is not configured on this server, so a code cannot be sent (${mailer.missingReason()}).` });
    }

    // Any earlier unused code for this entry is retired, so only the newest one works. Two live
    // codes would double the guessing surface for no benefit.
    await pool.query(
      "UPDATE archive_verifications SET consumed_at = NOW() WHERE user_id = ? AND entry_id = ? AND consumed_at IS NULL",
      [req.user.id, req.params.id],
    );

    const code = generateCode();
    await pool.query(
      `INSERT INTO archive_verifications (user_id, entry_id, purpose, code_hash, channel, sent_to, expires_at)
       VALUES (?,?,'reveal',?,'email',?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [req.user.id, req.params.id, hashCodeForStorage(code), user.email, CODE_TTL_MINUTES],
    );

    // The email names the entry so the recipient can tell a request they made from one they did
    // not -- a code with no context is a code people approve out of habit.
    await mailer.send({
      to: user.email,
      subject: `Archiver verification code: ${code}`,
      text: `Your verification code is ${code}.\n\n`
        + `It unlocks: ${access.entry.title} (${access.entry.entry_no})\n`
        + `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.\n\n`
        + 'If you did not request this, someone else is trying to open a stored credential with '
        + 'your account. Tell your System Administrator.',
      html: `<p>Your verification code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong></p>`
        + `<p>It unlocks: <strong>${access.entry.title}</strong> (${access.entry.entry_no})<br>`
        + `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.</p>`
        + '<p style="color:#b45309">If you did not request this, someone else is trying to open a '
        + 'stored credential with your account. Tell your System Administrator.</p>',
    });

    await logAccess(null, req, { entryId: req.params.id, action: 'request_code', detail: 'emailed' });
    res.json({ ok: true, sent: true, expires_in_minutes: CODE_TTL_MINUTES });
  } catch (err) { next(err); }
});

// Exchange a code for the secret. The ONLY route in this file that returns a decrypted value.
router.post('/:id/reveal', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    const access = await entryAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return notFound(res);
    if (!access.canReveal) return res.status(403).json({ error: 'You may see this entry but not reveal its secret.' });
    assertConfigured();

    const [[verification]] = await pool.query(
      `SELECT * FROM archive_verifications
        WHERE user_id = ? AND entry_id = ? AND purpose = 'reveal' AND consumed_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [req.user.id, req.params.id],
    );
    if (!verification) {
      await logAccess(null, req, { entryId: req.params.id, action: 'reveal', outcome: 'failed', detail: 'no active code' });
      return res.status(400).json({ error: 'Request a verification code first.' });
    }
    if (new Date(verification.expires_at) < new Date()) {
      await logAccess(null, req, { entryId: req.params.id, action: 'reveal', outcome: 'failed', detail: 'code expired' });
      return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    }
    if (verification.attempts >= MAX_CODE_ATTEMPTS) {
      // Burn it rather than leaving a spent code alive to be guessed at further.
      await pool.query('UPDATE archive_verifications SET consumed_at = NOW() WHERE id = ?', [verification.id]);
      await logAccess(null, req, { entryId: req.params.id, action: 'reveal', outcome: 'failed', detail: 'too many attempts' });
      return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }

    if (!codeMatchesStored(code, verification.code_hash)) {
      await pool.query('UPDATE archive_verifications SET attempts = attempts + 1 WHERE id = ?', [verification.id]);
      await logAccess(null, req, { entryId: req.params.id, action: 'reveal', outcome: 'failed', detail: `wrong code (attempt ${verification.attempts + 1})` });
      return res.status(400).json({ error: 'That code is not correct.', attempts_left: MAX_CODE_ATTEMPTS - verification.attempts - 1 });
    }

    // Single use, consumed before the secret is read: if anything below fails the code is still
    // spent, which is the safe direction to fail in.
    await pool.query('UPDATE archive_verifications SET consumed_at = NOW() WHERE id = ?', [verification.id]);

    const [[row]] = await pool.query(
      'SELECT secret_ciphertext, secret_iv, secret_tag, has_secret, username FROM archive_entries WHERE id = ?',
      [req.params.id],
    );
    if (!row?.has_secret) {
      await logAccess(null, req, { entryId: req.params.id, action: 'reveal', outcome: 'success', detail: 'no secret stored' });
      return res.json({ secret: null, username: row?.username || null, has_secret: false });
    }

    const secret = decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag });
    await logAccess(null, req, { entryId: req.params.id, action: 'revealed', detail: access.via || 'share' });
    res.json({ secret, username: row.username || null, has_secret: true });
  } catch (err) { next(err); }
});

// --- Sharing ----------------------------------------------------------------------------------

router.post('/:id/shares', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const access = await entryAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return notFound(res);
    if (!access.canEdit) return res.status(403).json({ error: 'You do not have edit access to this entry.' });

    const { user_id: userId, can_reveal: canReveal, can_edit: canEdit } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Choose a user to share with.' });
    if (String(userId) === String(access.entry.owner_user_id)) {
      return res.status(400).json({ error: 'That user already owns this entry.' });
    }
    const [[target]] = await pool.query('SELECT id, display_name FROM users WHERE id = ? AND is_active = TRUE', [userId]);
    if (!target) return res.status(400).json({ error: 'User not found.' });

    await pool.query(
      `INSERT INTO archive_entry_shares (entry_id, user_id, can_reveal, can_edit, granted_by_user_id)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE can_reveal = VALUES(can_reveal), can_edit = VALUES(can_edit),
                               granted_by_user_id = VALUES(granted_by_user_id), granted_at = NOW()`,
      [req.params.id, userId, canReveal !== false, !!canEdit, req.user.id],
    );
    await logAccess(null, req, {
      entryId: req.params.id, action: 'share_granted',
      detail: `${target.display_name}${canReveal !== false ? ' (can reveal)' : ' (view only)'}${canEdit ? ' (can edit)' : ''}`,
    });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id/shares/:userId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const access = await entryAccess(req.user.id, req.params.id);
    if (!access.found || !access.canView) return notFound(res);
    if (!access.canEdit) return res.status(403).json({ error: 'You do not have edit access to this entry.' });

    const [[target]] = await pool.query('SELECT display_name FROM users WHERE id = ?', [req.params.userId]);
    const [r] = await pool.query('DELETE FROM archive_entry_shares WHERE entry_id = ? AND user_id = ?', [req.params.id, req.params.userId]);
    if (!r.affectedRows) return res.status(404).json({ error: 'That share does not exist.' });
    await logAccess(null, req, { entryId: req.params.id, action: 'share_revoked', detail: target?.display_name || String(req.params.userId) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Deleting destroys the only copy of a credential, so it is owner/admin only -- an edit share is
// not enough. The access log rows deliberately survive: what was deleted, by whom and when is
// exactly what someone will ask afterwards.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const access = await entryAccess(req.user.id, req.params.id, conn);
    if (!access.found || !access.canView) return notFound(res);
    if (access.via === 'share') return res.status(403).json({ error: 'Only the owner or a System Admin can delete an entry.' });

    await conn.beginTransaction();
    await conn.query('DELETE FROM archive_entry_shares WHERE entry_id = ?', [req.params.id]);
    await conn.query('DELETE FROM archive_verifications WHERE entry_id = ?', [req.params.id]);
    await conn.query('DELETE FROM archive_entries WHERE id = ?', [req.params.id]);
    await logAccess(conn, req, { entryId: null, action: 'deleted', detail: `${access.entry.entry_no} ${access.entry.title}` });
    await conn.commit();
    res.status(204).send();
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// The vault-wide log, for whoever audits it. System Admin only: it names every entry and everyone
// who has opened one, which is more than any single share should reveal.
router.get('/audit/all', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    if (!(await isSystemAdmin(req.user.id))) return res.status(403).json({ error: 'System Admin only.' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || 50));
    const where = [];
    const params = [];
    if (req.query.action) { where.push('l.action = ?'); params.push(req.query.action); }
    if (req.query.outcome) { where.push('l.outcome = ?'); params.push(req.query.outcome); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM archive_access_logs l ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT l.*, u.display_name AS user_name, e.entry_no, e.title
         FROM archive_access_logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN archive_entries e ON e.id = l.entry_id
         ${whereSql} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) { next(err); }
});

module.exports = router;
