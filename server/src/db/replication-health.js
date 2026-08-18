// Checks the office/cloud replication pair and says plainly whether it is healthy.
//
// Replication stopping is normal and recoverable. Replication stopping SILENTLY is the failure
// that matters: the office keeps serving stale data, or the cloud never receives a day of work,
// and nobody finds out until someone notices a missing invoice. This is the thing that notices.
//
//   node src/db/replication-health.js
//   node src/db/replication-health.js --quiet     only print when something is wrong (for cron)
//
// Connection details come from the environment so no password is committed:
//   CLOUD_HOST (default 100.111.65.92)   CLOUD_USER   CLOUD_PW
//   OFFICE_HOST (default 100.77.225.53)  OFFICE_USER  OFFICE_PW
//
// Exits non-zero when anything is wrong, so cron mails the output:
//   */10 * * * * /usr/bin/node /path/replication-health.js --quiet
const mysql = require('mysql2/promise');
require('dotenv').config();

const QUIET = process.argv.includes('--quiet');

// A replica more than this far behind is reported. Normal lag on this link is under a second;
// anything approaching a minute means the link is struggling or the applier is stuck.
const LAG_WARN_SECONDS = 60;

const SIDES = [
  {
    label: 'CLOUD  (Singapore)',
    host: process.env.CLOUD_HOST || '100.111.65.92',
    user: process.env.CLOUD_USER || 'root',
    password: process.env.CLOUD_PW || '',
  },
  {
    label: 'OFFICE (Cebu)',
    host: process.env.OFFICE_HOST || '100.77.225.53',
    user: process.env.OFFICE_USER || 'setup',
    password: process.env.OFFICE_PW || '',
  },
];

const problems = [];
const lines = [];
const say = (s) => lines.push(s);

async function checkSide(side) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: side.host, user: side.user, password: side.password,
      connectTimeout: 15000,
    });
  } catch (err) {
    problems.push(`${side.label} is unreachable at ${side.host} (${err.code || err.message})`);
    say(`${side.label}  UNREACHABLE  ${side.host}`);
    return null;
  }

  try {
    const [[{ gtid }]] = await conn.query('SELECT @@GLOBAL.gtid_executed AS gtid');
    // The source host lives in the *configuration* table, not the status one -- status carries
    // SOURCE_UUID but no address, which is a genuinely easy thing to get wrong here.
    const [chans] = await conn.query(
      `SELECT c.CHANNEL_NAME AS name, cfg.HOST AS host,
              c.SERVICE_STATE AS io_state, c.LAST_ERROR_MESSAGE AS io_error,
              a.SERVICE_STATE AS sql_state, a.LAST_ERROR_MESSAGE AS sql_error
         FROM performance_schema.replication_connection_status c
         LEFT JOIN performance_schema.replication_connection_configuration cfg
                ON cfg.CHANNEL_NAME = c.CHANNEL_NAME
         LEFT JOIN performance_schema.replication_applier_status_by_coordinator a
                ON a.CHANNEL_NAME = c.CHANNEL_NAME`
    );

    say(`${side.label}  ${side.host}`);
    if (!chans.length) {
      // A side with no channel is not following anything -- which for this pair is always wrong.
      problems.push(`${side.label} has no replication channel configured`);
      say('   no replication channel configured');
    }

    for (const ch of chans) {
      const name = ch.name || '(default)';
      const io = ch.io_state === 'ON';
      const sql = ch.sql_state === 'ON';
      say(`   channel ${name.padEnd(12)} from ${String(ch.host).padEnd(16)} IO ${ch.io_state}  SQL ${ch.sql_state}`);
      if (!io) problems.push(`${side.label} channel "${name}": IO thread is ${ch.io_state}${ch.io_error ? ` -- ${ch.io_error}` : ''}`);
      if (!sql) problems.push(`${side.label} channel "${name}": SQL thread is ${ch.sql_state}${ch.sql_error ? ` -- ${ch.sql_error}` : ''}`);
      if (ch.io_error) say(`      IO error : ${String(ch.io_error).slice(0, 140)}`);
      if (ch.sql_error) say(`      SQL error: ${String(ch.sql_error).slice(0, 140)}`);
    }

    // TRUE LAG, NOT TIME-SINCE-LAST-WRITE. The obvious query -- now() minus the last applied
    // transaction's commit time -- measures how long ago the source last wrote anything, so an
    // idle channel appears to fall further behind by the second. It reported 75,713s on a
    // perfectly healthy link that had simply been quiet overnight, and would have alarmed every
    // night. Seconds_Behind_Source means what we actually want, and is NULL when caught up.
    for (const ch of chans) {
      try {
        const name = ch.name || '';
        const sql = name
          ? `SHOW REPLICA STATUS FOR CHANNEL ${conn.escape(name)}`
          : 'SHOW REPLICA STATUS';
        const [st] = await conn.query(sql);
        const behind = st[0] ? st[0].Seconds_Behind_Source : null;
        if (behind !== null && behind > LAG_WARN_SECONDS) {
          problems.push(`${side.label} channel "${name || '(default)'}" is ${behind}s behind`);
          say(`   channel ${String(name || '(default)').padEnd(12)} ${behind}s behind`);
        }
      } catch {
        // Unknown lag is not the same as bad lag; say nothing rather than guess.
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
  const gtids = [];
  for (const side of SIDES) gtids.push(await checkSide(side));

  // Both sides should hold the same transactions from every origin. A gap means one has not
  // caught up -- expected briefly, a problem if it persists.
  if (gtids[0] && gtids[1]) {
    const a = parseGtid(gtids[0]);
    const b = parseGtid(gtids[1]);
    say('');
    say('transactions each side has applied, per originating server:');
    for (const uuid of new Set([...a.keys(), ...b.keys()])) {
      const ca = a.get(uuid) || 0;
      const cb = b.get(uuid) || 0;
      const gap = Math.abs(ca - cb);
      say(`   ${uuid.slice(0, 8)}...  cloud ${String(ca).padStart(6)}   office ${String(cb).padStart(6)}${gap ? `   gap ${gap}` : '   in step'}`);
      // A small gap is just timing. A large one means a side has been disconnected a while.
      if (gap > 50) problems.push(`${gap} transactions from ${uuid.slice(0, 8)}... have not reached both sides`);
    }
  }

  if (problems.length) {
    console.log(lines.join('\n'));
    console.log(`\nPROBLEMS (${problems.length}):`);
    problems.forEach((p) => console.log(`  - ${p}`));
    console.log('\nTo restart a stopped channel:');
    console.log('  START REPLICA [FOR CHANNEL "from_office"];');
    console.log('If it fails with a duplicate-key or missing-row error, the two sides have');
    console.log('diverged on that row and it needs resolving before replication will continue.');
    process.exit(1);
  }

  if (!QUIET) {
    console.log(lines.join('\n'));
    console.log('\nHealthy: both sides reachable, every channel running, no meaningful gap.');
  }
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
