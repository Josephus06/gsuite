const { runSqlFallback } = require('./sqlFallback');
const pool = require('../db');

// Job-order artist lookups are a common, exact question with a stable relationship
// (job_orders.artist_id -> employees.id). Do this deterministically for admins instead
// of asking the SQL fallback model to infer the join, which can produce a plausible but
// incorrect employee when unrelated numeric ids happen to match.
function extractJobOrderForArtistLookup(message) {
  const match = String(message).match(/\bartist\b[\s\S]{0,100}\b(JO-\d+(?:-\d+)+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractSupervisorLookupName(message) {
  const text = String(message);
  const patterns = [
    /\b(?:who\s+is|who's|what\s+is)\s+the\s+supervisor\s+of\s+(.+?)\b/i,
    /\b(?:supervisor\s+of|supervisor\s+for)\s+(.+?)\b/i,
    /\b(?:who\s+is|who's|what\s+is)\s+(.+?)\s*(?:'s)?\s+supervisor\b/i,
  ];

  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1].trim();
  }
  return null;
}

async function isSystemAdmin(userId) {
  const [[user]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  return user?.account_type === 'System Admin';
}

async function answerAdminJobOrderArtist(userId, jobOrderNo) {
  if (!await isSystemAdmin(userId)) return null;

  const [[jobOrder]] = await pool.query(
    `SELECT CONCAT(e.first_name, ' ', e.last_name) AS artist_name
     FROM job_orders jo
     LEFT JOIN employees e ON e.id = jo.artist_id
     WHERE jo.job_order_no = ?
     LIMIT 1`,
    [jobOrderNo]
  );

  if (!jobOrder) return 'No matching records found.';
  if (!jobOrder.artist_name) return `No artist is assigned to job order ${jobOrderNo}.`;
  return `The artist assigned to job order ${jobOrderNo} is ${jobOrder.artist_name}.`;
}

async function answerAdminSupervisorLookup(userId, personName) {
  if (!await isSystemAdmin(userId)) return null;

  const like = `%${personName}%`;
  const [people] = await pool.query(
    `SELECT u.display_name, su.display_name AS supervisor_name
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN users su ON su.id = u.supervisor_id
     WHERE CONCAT_WS(' ', e.first_name, e.last_name) LIKE ?
        OR u.display_name LIKE ?
        OR u.username LIKE ?
     LIMIT 2`,
    [like, like, like]
  );

  if (people.length === 0) return 'No matching records found.';
  if (people.length > 1) return `I found multiple people matching "${personName}". Please use their full name.`;
  if (!people[0].supervisor_name) return `${people[0].display_name} does not have a supervisor assigned.`;
  return `${people[0].display_name}'s supervisor is ${people[0].supervisor_name}.`;
}

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
    const jobOrderNo = extractJobOrderForArtistLookup(message);
    if (jobOrderNo) {
      const answer = await answerAdminJobOrderArtist(user.id, jobOrderNo);
      if (answer) return answer;
    }

    const supervisorName = extractSupervisorLookupName(message);
    if (supervisorName) {
      const answer = await answerAdminSupervisorLookup(user.id, supervisorName);
      if (answer) return answer;
    }

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
