const express = require('express');
const pool = require('../db');
const { verifyUnsubscribe } = require('../lib/crmDrafts');

// Unauthenticated: the unsubscribe link at the foot of every CRM email (lib/crmDrafts.js).
//
// GET shows a button; only the POST it submits records the opt-out. Mail scanners and link
// previewers fetch every URL in a message, and a GET that unsubscribed would quietly opt out
// customers who never clicked anything.
const router = express.Router();

function page(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;margin:0;padding:40px 16px;color:#222}
.box{max-width:440px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
button{background:#222;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer}</style>
</head><body><div class="box">${bodyHtml}</div></body></html>`;
}

function esc(v) {
  return String(v || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function readLink(src) {
  const email = String(src.e || '').trim().toLowerCase();
  const sig = String(src.s || '');
  return email && verifyUnsubscribe(email, sig) ? { email, sig } : null;
}

router.get('/unsubscribe', (req, res) => {
  const link = readLink(req.query);
  if (!link) return res.status(400).send(page('Link not valid', '<h2>This link is not valid</h2><p>It may have been cut short when it was copied.</p>'));
  res.send(page('Unsubscribe', `<h2>Unsubscribe</h2>
    <p>Stop receiving check-in emails at <strong>${esc(link.email)}</strong>?</p>
    <form method="post" action="unsubscribe">
      <input type="hidden" name="e" value="${esc(link.email)}"><input type="hidden" name="s" value="${esc(link.sig)}">
      <button type="submit">Unsubscribe</button>
    </form>`));
});

router.post('/unsubscribe', express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const link = readLink(req.body || {});
    if (!link) return res.status(400).send(page('Link not valid', '<h2>This link is not valid</h2>'));
    await pool.query('INSERT IGNORE INTO crm_email_optouts (email) VALUES (?)', [link.email]);
    // Drafts already waiting for this address will never be sendable; clear them from reps' lists.
    await pool.query("UPDATE crm_email_drafts SET status = 'discarded', error = 'Unsubscribed', updated_at = NOW() WHERE to_email = ? AND status = 'draft'", [link.email]);
    res.send(page('Unsubscribed', `<h2>You're unsubscribed</h2><p>We won't send these emails to <strong>${esc(link.email)}</strong> any more.</p>`));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
