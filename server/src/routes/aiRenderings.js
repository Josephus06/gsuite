const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/ai-renderings';

// Design > AI Rendering (asked 2026-10-07): "please generate a logo signage to this area, make it
// a lighted circular signage" -- with a photo of the area. The photo (and the client's logo, when
// given) go to OpenAI's image EDIT endpoint, which paints the request into the photo rather than
// inventing a new scene, so the client sees their own storefront with the sign on it.
//
// Same OpenAI account as the chatbot, CRM drafts and Budget AI (OPENAI_API_KEY). gpt-image-2 is
// tried first and gpt-image-1 if the account cannot use it. A rendering costs real money (roughly
// US$0.01 draft to US$0.20 high), so each user gets DAILY_LIMIT a day; can_approve on the page
// lifts it (System Admins have that).
//
// Only successful renderings are stored, so a failed call does not use up the user's allowance.
const DAILY_LIMIT = 20;
const MODELS = ['gpt-image-2', 'gpt-image-1'];
const QUALITIES = { draft: 'low', standard: 'medium', high: 'high' };
const SIZES = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' };
const IMAGE_TYPES = /^image\/(png|jpe?g|webp)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Wraps what the designer typed. The model is told to keep the photo as it is and add only what
// was asked -- without this it tends to "improve" the whole scene.
const INSTRUCTIONS = [
  'You are a signage and display visualizer for a sign-making company.',
  'The FIRST image is a real photo of the client\'s site. Edit that photo: add only what the request below describes,',
  'placed realistically -- correct perspective, scale, mounting, shadows, and lighting that matches the photo (lit signs glow appropriately).',
  'Keep everything else in the photo unchanged.',
].join(' ');
const LOGO_NOTE = 'The SECOND image is the client\'s logo: reproduce it faithfully on the signage (same shapes, colours and lettering).';

// One rendering at a time per user: they take 10-60 seconds, and a double-click should not buy two.
const inFlight = new Set();

const LIST_COLUMNS = `r.id, r.customer_id, r.estimate_id, r.source_rendering_id, r.prompt, r.quality, r.size, r.model,
  r.result_bytes, r.estimate_attachment_id, r.created_by_user_id, r.created_at,
  (r.logo_image IS NOT NULL OR EXISTS (SELECT 1 FROM ai_renderings s WHERE s.id = r.source_rendering_id AND s.logo_image IS NOT NULL)) AS has_logo,
  c.name AS customer_name, e.estimate_no, u.display_name AS created_by_name`;
const LIST_JOINS = `FROM ai_renderings r
  LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN estimates e ON e.id = r.estimate_id
  LEFT JOIN users u ON u.id = r.created_by_user_id`;

function decodeImage(value, mimeType, label) {
  if (!value) return null;
  if (!IMAGE_TYPES.test(String(mimeType || ''))) throw Object.assign(new Error(`The ${label} must be a PNG, JPG or WEBP picture.`), { status: 400 });
  const base64 = String(value).includes(',') ? String(value).split(',').pop() : String(value);
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw Object.assign(new Error(`The ${label} is empty.`), { status: 400 });
  if (buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error(`The ${label} must be 10MB or smaller.`), { status: 413 });
  return buf;
}

async function usedToday(userId) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM ai_renderings WHERE created_by_user_id = ? AND created_at >= CURDATE()', [userId],
  );
  return Number(row.n) || 0;
}

async function allowance(userId) {
  const unlimited = await userCan(userId, ROUTE, 'can_approve');
  const used = await usedToday(userId);
  return { used, limit: unlimited ? null : DAILY_LIMIT, remaining: unlimited ? null : Math.max(0, DAILY_LIMIT - used) };
}

// Calls OpenAI's image edit. Returns { buf, mime, model, usage }.
async function renderImage({ prompt, quality, size, site, logo }) {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('AI is not set up on this server (no OPENAI_API_KEY).'), { status: 503 });
  }
  const fullPrompt = `${INSTRUCTIONS}${logo ? ` ${LOGO_NOTE}` : ''}\n\nRequest: ${prompt}`;
  let lastError;
  for (const model of MODELS) {
    const fd = new FormData();
    fd.append('model', model);
    fd.append('prompt', fullPrompt);
    fd.append('size', size);
    fd.append('quality', quality);
    fd.append('output_format', 'jpeg');
    fd.append('image[]', new Blob([site.buf], { type: site.mime }), `site.${site.mime.split('/')[1]}`);
    if (logo) fd.append('image[]', new Blob([logo.buf], { type: logo.mime }), `logo.${logo.mime.split('/')[1]}`);
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
      signal: AbortSignal.timeout(240000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.data?.[0]?.b64_json) {
      return { buf: Buffer.from(body.data[0].b64_json, 'base64'), mime: 'image/jpeg', model, usage: body.usage || {} };
    }
    const code = body?.error?.code || body?.error?.type || '';
    if (code === 'insufficient_quota' || code === 'credit_balance_exhausted' || code === 'billing_hard_limit_reached') {
      throw Object.assign(new Error('The OpenAI account has no credit left. Add credit at platform.openai.com (Billing), then try again.'), { status: 502 });
    }
    // The image model refused the request (content policy) -- say so instead of "try again".
    if (code === 'moderation_blocked' || /safety|moderation/i.test(body?.error?.message || '')) {
      throw Object.assign(new Error('OpenAI declined this request under its content rules. Reword it and try again.'), { status: 422 });
    }
    lastError = Object.assign(new Error(`The AI image service did not answer (${res.status}${code ? `: ${code}` : ''}).`), { status: 502 });
    // Only an unavailable model is worth retrying with the next one.
    if (!(res.status === 404 || res.status === 403 || /model/i.test(code))) break;
  }
  throw lastError;
}

// The sources a rendering was made from live on the first rendering of its line.
async function loadSources(id) {
  const [[row]] = await pool.query('SELECT id, source_rendering_id FROM ai_renderings WHERE id = ?', [id]);
  if (!row) return null;
  const rootId = row.source_rendering_id || row.id;
  const [[src]] = await pool.query(
    'SELECT id, site_image, site_mime, logo_image, logo_mime, customer_id, estimate_id FROM ai_renderings WHERE id = ?', [rootId],
  );
  return src;
}

async function saveRendering(req, res, { prompt, qualityKey, sizeKey, site, logo, customerId, estimateId, sourceId }) {
  const result = await renderImage({ prompt, quality: QUALITIES[qualityKey], size: SIZES[sizeKey], site, logo });
  const [ins] = await pool.query(
    `INSERT INTO ai_renderings (customer_id, estimate_id, source_rendering_id, prompt, quality, size, model,
       site_image, site_mime, logo_image, logo_mime, result_image, result_mime, result_bytes, input_tokens, output_tokens, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [customerId, estimateId, sourceId, prompt, qualityKey, sizeKey, result.model,
      sourceId ? null : site.buf, sourceId ? null : site.mime, sourceId || !logo ? null : logo.buf, sourceId || !logo ? null : logo.mime,
      result.buf, result.mime, result.buf.length, result.usage.input_tokens ?? null, result.usage.output_tokens ?? null, req.user.id],
  );
  const id = ins.insertId;
  // Linked to an estimate: also file it there, so whoever opens the estimate sees the mock-up.
  if (estimateId) {
    const [att] = await pool.query(
      `INSERT INTO estimate_attachments (estimate_id, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [estimateId, `AI-Rendering-${id}.jpg`, result.mime, result.buf.length, result.buf, req.user.id],
    );
    await pool.query('UPDATE ai_renderings SET estimate_attachment_id = ? WHERE id = ?', [att.insertId, id]);
  }
  const [[row]] = await pool.query(`SELECT ${LIST_COLUMNS} ${LIST_JOINS} WHERE r.id = ?`, [id]);
  res.status(201).json({ rendering: row, allowance: await allowance(req.user.id) });
}

function readOptions(body) {
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 5) throw Object.assign(new Error('Describe what to render.'), { status: 400 });
  if (prompt.length > 2000) throw Object.assign(new Error('Keep the request under 2,000 characters.'), { status: 400 });
  const qualityKey = QUALITIES[body.quality] ? body.quality : 'standard';
  const sizeKey = SIZES[body.size] ? body.size : 'landscape';
  return { prompt, qualityKey, sizeKey };
}

// Wraps a generate call: the per-user lock and the daily allowance.
function generating(handler) {
  return async (req, res, next) => {
    if (inFlight.has(req.user.id)) return res.status(429).json({ error: 'Your previous rendering is still being made. Wait for it to finish.' });
    inFlight.add(req.user.id);
    try {
      const a = await allowance(req.user.id);
      if (a.limit != null && a.remaining <= 0) {
        return res.status(429).json({ error: `You have used all ${DAILY_LIMIT} renderings for today. The allowance resets at midnight.` });
      }
      await handler(req, res);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      if (err.name === 'TimeoutError') return res.status(504).json({ error: 'The AI image service took too long. Try again, or use Draft quality.' });
      next(err);
    } finally {
      inFlight.delete(req.user.id);
    }
  };
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 12));
    const where = []; const params = [];
    if (req.query.mine === '1') { where.push('r.created_by_user_id = ?'); params.push(req.user.id); }
    if (req.query.customer_id) { where.push('r.customer_id = ?'); params.push(Number(req.query.customer_id)); }
    if (req.query.search) {
      where.push('(r.prompt LIKE ? OR c.name LIKE ? OR e.estimate_no LIKE ?)');
      params.push(...Array(3).fill(`%${req.query.search}%`));
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${LIST_JOINS} ${w}`, params);
    const [rows] = await pool.query(
      `SELECT ${LIST_COLUMNS} ${LIST_JOINS} ${w} ORDER BY r.id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit],
    );
    res.json({ rows, total, allowance: await allowance(req.user.id) });
  } catch (err) { next(err); }
});

// Pickers. Served from here rather than /customers and /estimates so a designer who has only this
// page can still link a rendering to a customer and estimate.
router.get('/customers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = String(req.query.search || '').trim();
    const [rows] = await pool.query(
      `SELECT id, name, customer_code FROM customers ${q ? 'WHERE name LIKE ? OR customer_code LIKE ?' : ''} ORDER BY name LIMIT 50`,
      q ? [`%${q}%`, `%${q}%`] : [],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/estimates', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, estimate_no, contract_description, date_created, status FROM estimates
        WHERE customer_id = ? ORDER BY id DESC LIMIT 100`, [Number(req.query.customer_id) || 0],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id/image/:kind', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { kind } = req.params;
    if (!['result', 'site', 'logo'].includes(kind)) return res.status(404).json({ error: 'Not found.' });
    let row;
    if (kind === 'result') {
      [[row]] = await pool.query('SELECT result_image AS data, result_mime AS mime FROM ai_renderings WHERE id = ?', [req.params.id]);
    } else {
      const src = await loadSources(req.params.id);
      row = src && { data: src[`${kind}_image`], mime: src[`${kind}_mime`] };
    }
    if (!row || !row.data) return res.status(404).json({ error: 'Not found.' });
    res.set('Content-Type', row.mime);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(row.data);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), generating(async (req, res) => {
  const body = req.body || {};
  const opts = readOptions(body);
  const siteBuf = decodeImage(body.site_image, body.site_mime, 'site photo');
  if (!siteBuf) throw Object.assign(new Error('Attach a photo of the site.'), { status: 400 });
  const logoBuf = decodeImage(body.logo_image, body.logo_mime, 'logo');
  const customerId = Number(body.customer_id) || null;
  if (!customerId) throw Object.assign(new Error('Choose the customer this rendering is for.'), { status: 400 });
  const [[cust]] = await pool.query('SELECT id FROM customers WHERE id = ?', [customerId]);
  if (!cust) throw Object.assign(new Error('Customer not found.'), { status: 400 });
  let estimateId = Number(body.estimate_id) || null;
  if (estimateId) {
    const [[est]] = await pool.query('SELECT id FROM estimates WHERE id = ? AND customer_id = ?', [estimateId, customerId]);
    if (!est) throw Object.assign(new Error('That estimate does not belong to the chosen customer.'), { status: 400 });
    estimateId = est.id;
  }
  await saveRendering(req, res, {
    ...opts,
    site: { buf: siteBuf, mime: String(body.site_mime).toLowerCase().replace('jpg', 'jpeg') },
    logo: logoBuf ? { buf: logoBuf, mime: String(body.logo_mime).toLowerCase().replace('jpg', 'jpeg') } : null,
    customerId, estimateId, sourceId: null,
  });
}));

// "Make a variation": the same site photo and logo, with the original or a revised request.
router.post('/:id/variation', requireAuth, requirePermission(ROUTE, 'can_add'), generating(async (req, res) => {
  const src = await loadSources(req.params.id);
  if (!src || !src.site_image) throw Object.assign(new Error('Rendering not found.'), { status: 404 });
  const opts = readOptions(req.body || {});
  await saveRendering(req, res, {
    ...opts,
    site: { buf: src.site_image, mime: src.site_mime },
    logo: src.logo_image ? { buf: src.logo_image, mime: src.logo_mime } : null,
    customerId: src.customer_id, estimateId: src.estimate_id, sourceId: src.id,
  });
}));

// Deleting removes only the rendering. A copy filed on an estimate stays there: it belongs to the
// estimate now. The first rendering of a line holds its photos, so it is kept while variations
// of it remain.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query('SELECT id FROM ai_renderings WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Rendering not found.' });
    const [[kids]] = await pool.query('SELECT COUNT(*) AS n FROM ai_renderings WHERE source_rendering_id = ?', [row.id]);
    if (kids.n) return res.status(409).json({ error: 'Its variations use this rendering\'s photos. Delete the variations first.' });
    await pool.query('DELETE FROM ai_renderings WHERE id = ?', [row.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
