const pool = require('../db');
const { parkedReport } = require('../lib/parkedBankItems');

// Tells the people who sign off bank reconciliations that something is still parked in Deposit or
// Disbursement.
//
// WHY A REMINDER AND NOT JUST A REPORT. Those two accounts are excluded from every accounting
// report, so nothing anybody opens in the normal course of a month will show the balance. A report
// that has to be remembered is a report nobody reads, and the whole hazard of a suspense account is
// that items sit in it quietly. This is the part that does the remembering.
//
// THE BALANCE IS SUPPOSED TO BE ZERO. Every item is a bank movement with no document behind it.
// When the document turns up and the statement line is matched to it, the journal is voided and the
// item leaves by itself. Nothing here needs chasing except what stays.
//
// WHO. Whoever can approve a bank reconciliation -- they are the ones who sign these off and can
// act on it. Not everyone who can read the module: a notification that is not yours to act on
// trains people to ignore notifications.
//
// ONCE A DAY, NOT ONCE A RUN. Re-notifying the same person about the same unchanged balance every
// night is how a reminder becomes noise. One unread notification per person per day is enough, and
// a changed total makes a new one worth sending.

const NOTIFICATION_TYPE = 'parked_bank_items';
const RECON_ROUTE = '/accounting/bank-reconciliation';

async function approvers(q = pool) {
  const [rows] = await q.query(
    `SELECT u.id, u.display_name
       FROM user_page_permissions upp
       JOIN pages p ON p.id = upp.page_id
       JOIN users u ON u.id = upp.user_id
      WHERE p.route = ? AND upp.can_approve = 1 AND u.is_active = 1`,
    [RECON_ROUTE]);
  return rows;
}

// A reminder already sent today about the same figure, still unread. Sending another says nothing
// the first one did not.
async function alreadyTold(userId, message, q = pool) {
  const [[row]] = await q.query(
    `SELECT id FROM notifications
      WHERE user_id = ? AND type = ? AND is_read = 0 AND message = ? AND DATE(created_at) = CURDATE()
      LIMIT 1`,
    [userId, NOTIFICATION_TYPE, message]);
  return Boolean(row);
}

function describe(report) {
  const money = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const parts = report.summary
    .filter((a) => Number(a.items) > 0)
    .map((a) => `${a.account_name} ${money(Math.abs(Number(a.balance)))}`);
  const oldest = report.summary
    .filter((a) => a.oldest_days != null)
    .reduce((m, a) => Math.max(m, Number(a.oldest_days)), 0);
  const age = oldest > 0 ? `, oldest ${oldest} day${oldest === 1 ? '' : 's'} old` : '';
  return `${report.total_items} bank item${report.total_items === 1 ? '' : 's'} still unidentified`
    + `: ${parts.join(', ')}${age}. These accounts should read zero.`;
}

async function sendParkedItemReminders() {
  const report = await parkedReport();
  if (report.all_clear) {
    return { notified: 0, items: 0, reason: 'nothing parked -- both accounts are at zero' };
  }

  const people = await approvers();
  if (!people.length) {
    // Worth saying out loud rather than returning quietly: the reminder is the only thing that
    // surfaces these, and with nobody to send it to they are invisible again.
    return {
      notified: 0,
      items: report.total_items,
      reason: `nobody holds can_approve on ${RECON_ROUTE}, so there is nobody to tell`,
    };
  }

  const message = describe(report);
  const title = 'Unidentified bank items need clearing';
  let notified = 0;
  for (const person of people) {
    if (await alreadyTold(person.id, message)) continue;
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id, created_at)
       VALUES (?, ?, ?, ?, 'ParkedBankItems', NULL, NOW())`,
      [person.id, NOTIFICATION_TYPE, title, message.slice(0, 500)]);
    notified += 1;
  }
  return { notified, items: report.total_items, outstanding: report.total_outstanding, message };
}

module.exports = { sendParkedItemReminders, NOTIFICATION_TYPE };

// Runnable by hand, which is how to check it without waiting for the small hours:
//   node src/db/../scripts/parked_items_reminder.js
if (require.main === module) {
  require('dotenv').config();
  sendParkedItemReminders()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); return pool.end(); })
    .catch(async (err) => { console.error('Failed:', err.message); await pool.end(); process.exit(1); });
}
