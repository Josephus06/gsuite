const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { answerQuestion, isTicketTrigger } = require('../lib/chatbotIntents');

const router = express.Router();

router.post('/ask', requireAuth, async (req, res, next) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    if (isTicketTrigger(message)) {
      return res.json({ reply: 'Sure — which department is this for?', isTicketTrigger: true });
    }
    const reply = await answerQuestion(req.user, message, history);
    res.json({ reply, isTicketTrigger: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
