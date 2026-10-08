// Checks the three-server replication (office <-> cloud <-> SM branch) and says plainly whether it
// is healthy. Rewritten 2026-10-08: it logged in as root/setup with no password (so reported both
// sides "unreachable") and did not know SM existed -- which is how the cloud's from_sm channel sat
// stopped for a day unnoticed.
//
// Replication stopping is normal and recoverable. Replication stopping SILENTLY is the failure
// that matters: the office keeps serving stale data, or the cloud never receives a day of work,
// and nobody finds out until someone notices a missing invoice. This is the thing that notices.
//
//   node src/db/replication-health.js
//   node src/db/replication-health.js --quiet     only print when something is wrong (for cron)
//
// It logs in to every server as the replication account `repl` (REPLICATION CLIENT is all SHOW
// REPLICA STATUS and @@gtid_executed need), over TLS. The password is never committed: REPL_PW, or
// else the file the cloud keeps it in, /root/.mysql_repl_pw. Hosts default to the Tailscale
// addresses and can be overridden: CLOUD_HOST, OFFICE_HOST, SM_HOST. Run it on the cloud.
//
// Exits non-zero when anything is wrong, so cron mails the output:
//   */10 * * * * /usr/bin/node /path/replication-health.js --quiet
const fs = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config();

const QUIET = process.argv.includes('--quiet');

// A replica more than this far behind is reported. Normal lag on this link is under a second;
// anything approaching a minute means the link is struggling or the applier is stuck.
const LAG_WARN_SECONDS = 60;

function replPassword() {
  if (process.env.REPL_PW) return process.env.REPL_PW;
  try { return fs.readFileSync('/root/.mysql_repl_pw', 'utf8').trim(); } catch { return ''; }
}
const PW = replPassword();
const SIDES = [
  { key: 'cloud', label: 'CLOUD  (Singapore)', host: process.env.CLOUD_HOST || '100.111.65.92' },
  { key: 'office', label: 'OFFICE (Cebu)', host: process.env.OFFICE_HOST || '100.77.225.53' },
  { key: 'sm', label: 'SM     (branch)', host: process.env.SM_HOST || '100.120.229.22' },
];

const problems = [];
const lines = [];
const say = (s) => lines.push(s);

async function checkSide(side) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: side.host, user: process.env.REPL_USER || 'repl', password: PW,
      ssl: { rejectUnauthorized: false }, connectTimeout: 15000,
    });
  } catch (err) {
    problems.push(`${side.label} is unreachable at ${side.host} (${err.code || err.message})`);
    say(`${side.label}  UNREACHABLE  ${side.host}`);
    return null;
  }

  try {
    const [[{ gtid }]] = await conn.query('SELECT @@GLOBAL.gtid_executed AS gtid');
    // SHOW REPLICA STATUS returns one row per channel and needs only REPLICATION CLIENT, unlike
    // the performance_schema tables.
    const [chans] = await conn.query('SHOW REPLICA STATUS');

    say(`${side.label}  ${side.host}`);
    if (!chans.length) {
      // A server with no channel is not following anything -- which here is always wrong.
      problems.push(`${side.label} has no replication channel configured`);
      say('   no replication channel configured');
    }

    for (const ch of chans) {
      const name = ch.Channel_Name || '(default)';
      const io = ch.Replica_IO_Running === 'Yes';
      const sql = ch.Replica_SQL_Running === 'Yes';
      const behind = ch.Seconds_Behind_Source;
      say(`   channel ${name.padEnd(12)} from ${String(ch.Source_Host).padEnd(16)} IO ${String(ch.Replica_IO_Running).padEnd(10)} SQL ${ch.Replica_SQL_Running}${behind != null ? `  ${behind}s behind` : ''}`);
      if (!io) problems.push(`${side.label} channel "${name}": receiver is ${ch.Replica_IO_Running}${ch.Last_IO_Error ? ` -- ${ch.Last_IO_Error}` : ''}`);
      if (!sql) problems.push(`${side.label} channel "${name}": applier is stopped${ch.Last_SQL_Error ? ` -- ${ch.Last_SQL_Error}` : ''}`);
      if (ch.Last_IO_Error) say(`      IO error : ${String(ch.Last_IO_Error).slice(0, 160)}`);
      if (ch.Last_SQL_Error) say(`      SQL error: ${String(ch.Last_SQL_Error).slice(0, 160)}`);
      // Seconds_Behind_Source is true lag (NULL when not running), not time since the last write.
      if (behind != null && behind > LAG_WARN_SECONDS) problems.push(`${side.label} channel "${name}" is ${behind}s behind`);
      // A receiver that gives up after a few failed reconnects is how from_sm stopped for good.
      if (Number(ch.Source_Retry_Count) < 1000) {
        problems.push(`${side.label} channel "${name}" gives up after ${ch.Source_Retry_Count} reconnect attempts -- set SOURCE_RETRY_COUNT = 86400`);
      }
    }

    return gtid;
  } finally {
    await conn.end().catch(() => {});
  }
}

// Turns "uuid:1-5,uuid2:1-3" into a map so the two sides can be compared per source server.
function parseGtid(set) {
  const out = new Map();
  for (const part of String(set || '').replace(/\\n/g, '').split(',')) {
    const [uuid, range] = part.trim().split(':');
    if (!uuid || !range) continue;
    const end = Number(String(range).split('-').pop());
    if (Number.isFinite(end)) out.set(uuid, Math.max(out.get(uuid) || 0, end));
  }
  return out;
}

async function main() {
  if (!PW) { console.error('No replication password: set REPL_PW or run on the cloud (/root/.mysql_repl_pw).'); process.exit(2); }
  const gtids = [];
  for (const side of SIDES) gtids.push(await checkSide(side));

  // Every server should hold the same transactions from every origin. A gap means one has not
  // caught up -- expected briefly under live traffic, a problem if it is large.
  const reached = SIDES.map((side, i) => ({ side, set: gtids[i] ? parseGtid(gtids[i]) : null })).filter((x) => x.set);
  if (reached.length > 1) {
    say('');
    say('transactions each server has applied, per originating server:');
    const uuids = new Set(reached.flatMap((x) => [...x.set.keys()]));
    for (const uuid of uuids) {
      const counts = reached.map((x) => x.set.get(uuid) || 0);
      const gap = Math.max(...counts) - Math.min(...counts);
      say(`   ${uuid.slice(0, 8)}...  ${reached.map((x, i) => `${x.side.key} ${String(counts[i]).padStart(7)}`).join('   ')}${gap ? `   gap ${gap}` : '   in step'}`);
      if (gap > 50) problems.push(`${gap} transactions from ${uuid.slice(0, 8)}... have not reached every server`);
    }
  }

  if (problems.length) {
    console.log(lines.join('\n'));
    console.log(`\nPROBLEMS (${problems.length}):`);
    problems.forEach((p) => console.log(`  - ${p}`));
    console.log('\nTo restart a stopped channel:');
    console.log("  START REPLICA IO_THREAD FOR CHANNEL 'from_sm';  -- or 'from_office'; on office / SM: START REPLICA;");
    console.log('If it fails with a duplicate-key or missing-row error, the two sides have');
    console.log('diverged on that row and it needs resolving before replication will continue.');
    process.exit(1);
  }

  if (!QUIET) {
    console.log(lines.join('\n'));
    console.log('\nHealthy: all three servers reachable, every channel running, no meaningful gap.');
  }
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
