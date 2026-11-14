const express = require('express');
const pool = require('../db');
const { requireAuth, isSystemAdmin } = require('../middleware/auth');

// The seasonal theme for everyone (asked 2026-11-14: "admin can only change the season theme, but a
// user can change the theme from original to the theme set by admin"). One company-wide setting in
// app_settings 'season_theme':
//   auto       -- by the calendar: October-November Halloween, December Christmas, otherwise none;
//   halloween  -- the Halloween theme, whatever the date;
//   christmas  -- the Christmas theme, whatever the date;
//   off        -- no seasonal theme for anyone.
// Only a System Admin changes it. Each user can still switch it off for themselves (kept in their
// browser, client/src/utils/season.js).
const router = express.Router();
const SETTING = 'season_theme';
const CHOICES = ['auto', 'halloween', 'christmas', 'off'];

async function current() {
  const [[row]] = await pool.query('SELECT value FROM app_settings WHERE name = ?', [SETTING]).catch(() => [[null]]);
  return CHOICES.includes(row?.value) ? row.value : 'auto';
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json({ season_theme: await current() });
  } catch (err) { next(err); }
});

router.put('/', requireAuth, async (req, res, next) => {
  try {
    if (!(await isSystemAdmin(req.user.id))) return res.status(403).json({ error: 'Only a System Admin sets the seasonal theme.' });
    const value = String(req.body?.season_theme || '');
    if (!CHOICES.includes(value)) return res.status(400).json({ error: `season_theme must be one of ${CHOICES.join(', ')}.` });
    await pool.query(
      'INSERT INTO app_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [SETTING, value]);
    res.json({ season_theme: value });
  } catch (err) { next(err); }
});

module.exports = router;
