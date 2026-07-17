const { runSqlFallback } = require('./sqlFallback');

// Data-Q&A is entirely delegated to sqlFallback.js now -- no hand-built regex/keyword
// intents here. Two reasons that turned out to be the right call rather than growing
// an ever-longer list of question patterns (see git history on this file for the
// earlier version): (1) every new phrasing a user actually typed needed its own patch,
// which doesn't scale, and (2) sqlFallback.js's retrieval-then-answer path for non-admin
// users already reuses the exact same visibility helpers (resolveScope,
// ticketVisibilityClause) the rest of the app trusts, so it isn't a weaker guarantee
// than hand-written scoped queries -- just a lot more general.
async function answerQuestion(user, message) {
  try {
    const answer = await runSqlFallback(user, message);
    if (answer) return answer;
  } catch (err) {
    return 'Sorry, I ran into a problem looking that up.';
  }
  return "I don't have an answer for that yet. You can also type \"create ticket\" to reach a department.";
}

// Checked by the chatbot route BEFORE intent matching -- "create ticket" always wins
// even if the rest of the message would otherwise read as a data question. This is a
// mode switch (into the ticket-intake flow), not a data answer, so it stays a literal
// trigger phrase rather than something the LLM decides.
function isTicketTrigger(message) {
  return /create ticket/i.test(message);
}

module.exports = { answerQuestion, isTicketTrigger };
