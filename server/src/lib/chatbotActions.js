const pool = require('../db');
const { userCan } = require('../middleware/auth');
const { replicateNonStandardJobOrder } = require('../routes/nonStandardJobOrders');

// Things the chatbot can DO, as opposed to everything else it does, which is read-only.
//
// Three rules hold this together, and they are the reason a language model having write access
// to an ERP is not the alarming idea it sounds like:
//
// 1. The intent is matched deterministically, by the regex below -- never by the model. The
//    model is not asked whether the user wanted to create something, and it cannot decide to.
//    Same reasoning as isTicketTrigger in chatbotIntents.js.
// 2. Nothing happens without a yes. Every action states exactly what it will do and waits.
//    A wrongly matched message costs one question, not a stray job order.
// 3. Permission is checked against the same page right the button obeys, at the moment of
//    execution -- not when the confirmation was offered. Someone whose access is withdrawn
//    mid-conversation cannot spend a yes they were already holding.
//
// The pending action travels to the browser and back between the two turns. That is safe
// because it is re-validated on the way in: it names what to copy, it does not authorise
// copying it, so a tampered one can only ask for something the user could already do through
// the API directly.
const NSTDJO_ROUTE = '/non-standard-job-orders';

// "replicate NSTDJO-851", "please copy nstdjo 851", "duplicate NSTDJO-851 for me". Not
// anchored to the start because people put please, hi, and their whole day in front of it.
// A leading "how" is excluded -- "how do I replicate NSTDJO-851" is asking to be taught, not
// asking for a copy.
const REPLICATE_RE = /\b(?:replicate|duplicate|copy|kopyaha|balika)\b[^\n]{0,40}?\bNSTDJO[-\s]?(\d+)\b/i;
const ASKING_HOW_RE = /^\s*(?:how|unsaon|pa?unsa)\b/i;

// Cebuano alongside English: sige and oo are how half the office says yes.
// A short courtesy tail is allowed -- "yes please", "sige lang" -- but nothing longer, so
// "no problem, now tell me about..." reads as a change of subject rather than an answer.
const TAIL = '(?:\\s+(?:please|pls|po|lang|na|sir|maam|thanks|thank you))*';
const YES_RE = new RegExp(`^\\s*(?:y|yes|yeah|yep|yup|ok|okay|sure|proceed|confirm|confirmed|go ahead|do it|sige|oo|padayon)${TAIL}[\\s.!]*$`, 'i');
const NO_RE = new RegExp(`^\\s*(?:n|no|nope|cancel|stop|nevermind|never mind|ayaw|dili|wala)${TAIL}[\\s.!]*$`, 'i');

function parseAction(message) {
  const text = String(message || '');
  if (ASKING_HOW_RE.test(text)) return null;
  const m = text.match(REPLICATE_RE);
  if (m) return { kind: 'replicate_nstdjo', number: Number(m[1]) };
  return null;
}

function isConfirmation(message) {
  if (YES_RE.test(String(message || ''))) return 'yes';
  if (NO_RE.test(String(message || ''))) return 'no';
  return null;
}

async function findNstdjo(number) {
  // Matched on the printed number rather than the row id: NSTDJO-851 is what people read off
  // the screen, and on the office server the ids run on a different auto_increment offset, so
  // treating the two as interchangeable would copy a different order there.
  const [[order]] = await pool.query(
    `SELECT n.id, n.nstdjo_no, n.description, n.status, n.sub_status, c.name AS customer_name,
            (SELECT COUNT(*) FROM non_standard_job_order_materials m
              WHERE m.non_standard_job_order_id = n.id) AS line_count
       FROM non_standard_job_orders n
       LEFT JOIN customers c ON c.id = n.customer_id
      WHERE n.nstdjo_no = ?`,
    [`NSTDJO-${number}`],
  );
  return order || null;
}

// Turns a matched command into a question, or into the reason it cannot be done. Returns
// { reply, pendingAction } -- pendingAction only when there is genuinely something to confirm.
async function offerAction(user, action) {
  if (action.kind !== 'replicate_nstdjo') return null;

  if (!await userCan(user.id, NSTDJO_ROUTE, 'can_add')) {
    return { reply: 'You do not have permission to add non-standard job orders, so I cannot replicate one for you. Ask an administrator for "add" rights on Non-Standard Job Orders.' };
  }

  const order = await findNstdjo(action.number);
  if (!order) return { reply: `I could not find NSTDJO-${action.number}.` };

  const lines = Number(order.line_count) || 0;
  return {
    reply: [
      `Replicating ${order.nstdjo_no}${order.customer_name ? ` for ${order.customer_name}` : ''} will create a NEW job order copying its customer, job details and ${lines} material line${lines === 1 ? '' : 's'}.`,
      'The copy starts at the beginning of the workflow under your name and goes to your own department approvers. The artist assignment, timers and approvals are not carried over, and '
        + `${order.nstdjo_no} itself is left untouched.`,
      'Reply "yes" to go ahead, or "no" to leave it.',
    ].join('\n\n'),
    pendingAction: { kind: action.kind, id: order.id, nstdjo_no: order.nstdjo_no },
  };
}

// The second turn. Everything is checked again here rather than trusted from the offer.
async function runAction(user, pendingAction) {
  if (!pendingAction || pendingAction.kind !== 'replicate_nstdjo') {
    return 'I am not sure what you are confirming — say what you would like me to do.';
  }
  if (!await userCan(user.id, NSTDJO_ROUTE, 'can_add')) {
    return 'You do not have permission to add non-standard job orders.';
  }
  try {
    const created = await replicateNonStandardJobOrder(user.id, Number(pendingAction.id));
    // Where it landed depends on whether the raiser has approvers at all, so it is read off
    // the result rather than asserted -- telling someone it is with their approvers when it
    // went straight to Pending sends them looking for an approval that is never coming.
    const waiting = created.sub_status === 'SBU Approval'
      ? ' and is waiting on your department approvers'
      : '';
    return `Done — ${created.nstdjo_no} is a copy of ${created.replicated_from}, with ${created.lines} material line${created.lines === 1 ? '' : 's'}. It is at ${created.sub_status}${waiting}.`;
  } catch (err) {
    if (err.status) return err.message;
    console.error('[chatbot] replicate failed:', err.message);
    return 'Sorry, I could not raise that copy. Nothing was created.';
  }
}

module.exports = { parseAction, isConfirmation, offerAction, runAction };
