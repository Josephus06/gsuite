const crypto = require('crypto');
const express = require('express');
const pool = require('../db');
const { requireAuth, isSystemAdmin } = require('../middleware/auth');

// Highlight-to-translate: any text a user selects in the app (a memo, a customer's note, a job
// description typed in Cebuano or Tagalog) comes here and goes back in English. The client side is
// components/SelectionTranslator.jsx, mounted once in the Layout so it works on every page.
//
// Any logged-in user may use it -- it reads nothing from the database, it only translates text
// the user can already see on their screen. Same OpenAI account and model as the chatbot.
const router = express.Router();

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const MAX_CHARS = 2000;

// Staff highlight the same memo or remark again and again; a small in-memory cache saves the API
// call. Bounded so it cannot grow without limit on a server that stays up for weeks.
const CACHE_MAX = 500;
const cache = new Map();
function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

// A few requests a minute per user is plenty for reading; it stops a stuck client or a script
// from running up the OpenAI bill.
const WINDOW_MS = 60000;
const PER_WINDOW = 20;
const recent = new Map();
function allowed(userId) {
  const now = Date.now();
  const hits = (recent.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= PER_WINDOW) {
    recent.set(userId, hits);
    return false;
  }
  hits.push(now);
  recent.set(userId, hits);
  return true;
}

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Nothing to translate.' });
    if (text.length > MAX_CHARS) return res.status(400).json({ error: `Select less text (up to ${MAX_CHARS} characters).` });
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Translation is not set up on this server (no OpenAI key).' });

    const key = text.toLowerCase();
    if (cache.has(key)) return res.json(cache.get(key));
    if (!allowed(req.user.id)) return res.status(429).json({ error: 'Too many translations in a minute; wait a moment.' });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Translate the user\'s text into English. It comes from a Philippine printing and signage company\'s',
              'ERP -- including HR records such as incident reports -- so expect Cebuano/Bisaya, Tagalog, Taglish',
              'and shorthand mixed with English.',
              'Be FAITHFUL: translate what the words actually say (e.g. Cebuano "pataka" = carelessly/recklessly,',
              '"tabi" = talk), written in natural English word order. Never add intent, motive or detail that is',
              'not in the text, and keep hedges like "daw"/"raw" (reportedly) -- people may be judged on these words.',
              'Keep names, company names, numbers, amounts, dates, sizes (e.g. 3x6 ft) and document numbers',
              '(SO-, JO-, INV-) exactly as written. Do not answer questions in the text -- only translate it.',
              'If it is already entirely English, return it unchanged.',
              'If a word or expression is slang, idiomatic, or could mean more than one thing, put a short',
              'plain-English note in "note" (e.g. the literal sense and the other possible reading); otherwise null.',
              'Reply with JSON only: {"translation": "...", "language": "<source language name in English>", "note": "..." | null}',
            ].join(' '),
          },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return res.status(502).json({ error: `The translation service answered ${response.status}.` });
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const result = {
      translation: String(parsed.translation || '').trim(),
      language: String(parsed.language || '').trim() || null,
      note: parsed.note ? String(parsed.note).trim() : null,
    };
    if (!result.translation) return res.status(502).json({ error: 'The translation came back empty.' });
    remember(key, result);
    res.json(result);
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'The translation took too long; try again.' });
    next(err);
  }
});

// --- Saved translations ------------------------------------------------------------------------
// "Save" in the translate popover: the page shows the English in place of the original from then
// on, for everyone, and the original stays one click away. Stored beside the record, never in it
// -- see src/db/create-saved-translations.js for why.
//
// Anyone logged in may save (it changes only how text they can already see is displayed, and the
// original is always recoverable); only the person who saved it, or a System Admin, may remove it.
function cleanPath(p) {
  const path = String(p || '').split('?')[0].split('#')[0].trim();
  return /^\/[\w\-./]{0,254}$/.test(path) ? path : null;
}
function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

router.get('/saved', requireAuth, async (req, res, next) => {
  try {
    const path = cleanPath(req.query.path);
    if (!path) return res.json([]);
    const [rows] = await pool.query(
      `SELECT st.id, st.original_text, st.translation, st.language, st.created_by_user_id, st.created_at,
              u.display_name AS created_by_name
         FROM saved_translations st LEFT JOIN users u ON u.id = st.created_by_user_id
        WHERE st.page_path = ?
        ORDER BY CHAR_LENGTH(st.original_text) DESC`, [path],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/saved', requireAuth, async (req, res, next) => {
  try {
    const path = cleanPath(req.body.path);
    const original = String(req.body.original || '').trim();
    const translation = String(req.body.translation || '').trim();
    if (!path) return res.status(400).json({ error: 'Unknown page.' });
    if (!original || !translation) return res.status(400).json({ error: 'Nothing to save.' });
    if (original.length > MAX_CHARS || translation.length > MAX_CHARS * 2) return res.status(400).json({ error: 'That text is too long to save.' });
    if (original === translation) return res.status(400).json({ error: 'It is already English; nothing to save.' });
    await pool.query(
      `INSERT INTO saved_translations (page_path, original_text, original_hash, translation, language, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE translation = VALUES(translation), language = VALUES(language),
                               created_by_user_id = VALUES(created_by_user_id), updated_at = NOW()`,
      [path, original, hashText(original), translation, String(req.body.language || '').slice(0, 60) || null, req.user.id],
    );
    const [[row]] = await pool.query(
      'SELECT * FROM saved_translations WHERE page_path = ? AND original_hash = ?', [path, hashText(original)],
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/saved/:id', requireAuth, async (req, res, next) => {
  try {
    const [[row]] = await pool.query('SELECT created_by_user_id FROM saved_translations WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.created_by_user_id !== req.user.id && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'Only the person who saved this translation can remove it.' });
    }
    await pool.query('DELETE FROM saved_translations WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
