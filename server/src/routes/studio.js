const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { signInUrl } = require('../lib/studioClient');

// Sales > 3D Studio (2026-11-25). Who sees the menu item is the /3d-studio permission page
// (db/register-3d-studio-page.js); what they may do inside is the studio's business.
const router = express.Router();

// POST /api/studio/open -> { url }: a one-time link straight into the studio, signed in.
router.post('/open', requireAuth, requirePermission('/3d-studio', 'can_view'), async (req, res, next) => {
  try {
    const url = await signInUrl(req.user.id);
    if (!url) return res.status(503).json({ error: 'The 3D Studio link is not set up on this server yet (STUDIO_WEB_URL / STUDIO_SSO_SECRET).' });
    res.json({ url });
  } catch (err) { next(err); }
});

module.exports = router;
