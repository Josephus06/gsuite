// Chat keeps only TODAY's conversation (asked 2026-10-12): every message sent before today on the
// business clock (Philippine time) is deleted -- a thread is gone the day after. Runs just after
// midnight business time, and once when the server starts, so a box that was down at midnight
// still catches up.
//
// OFF unless CHAT_PURGE_JOB=1, on purpose, like the CRM job: the droplet and the office box are
// master-master replicas, and both deleting the same rows would collide in replication. Turn it on
// for ONE box of that pair (the droplet); the other receives the deletes by replication.
const pool = require('../db');
const { UTC_OFFSET_MIN, businessToday, msUntilBusinessTime } = require('./crmCadence');

const chatPurgeJobEnabled = () => String(process.env.CHAT_PURGE_JOB || '') === '1';

// Start of today on the business clock, as the UTC datetime chat_messages.created_at is stored in.
function startOfTodayUtc() {
  const midnight = Date.parse(`${businessToday()}T00:00:00Z`) - UTC_OFFSET_MIN * 60000;
  return new Date(midnight).toISOString().slice(0, 19).replace('T', ' ');
}

async function purgeOldChat() {
  const cutoff = startOfTodayUtc();
  const [r] = await pool.query('DELETE FROM chat_messages WHERE created_at < ?', [cutoff]);
  return { deleted: r.affectedRows, cutoff };
}

function scheduleChatPurge(hour = 0, minute = 5) {
  const run = async () => {
    try {
      const { deleted, cutoff } = await purgeOldChat();
      if (deleted) console.log(`Chat purge: ${deleted} message(s) before ${cutoff} UTC deleted.`);
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') console.error('Chat purge failed:', err);
    }
  };
  const next = () => {
    const delayMs = msUntilBusinessTime(hour, minute);
    setTimeout(async () => { await run(); next(); }, delayMs);
  };
  run();
  next();
}

module.exports = { chatPurgeJobEnabled, purgeOldChat, scheduleChatPurge, startOfTodayUtc };
