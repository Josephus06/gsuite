// Reports whether a MySQL server is ready to take part in the office/cloud replication pair.
//
// Run it against each side before wiring anything together, and again afterwards. Replication
// fails in slow, confusing ways when one prerequisite is missing -- a replica that silently never
// starts looks identical to one that is merely idle -- so this checks each requirement explicitly
// and says what to do about the ones that fail.
//
//   node src/db/replication-readiness.js
//   DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=... node src/db/replication-readiness.js
//
// THE SETUP THIS IS CHECKING FOR. Office and cloud are each a source AND a replica of the other
// (master-master), so either can take writes. GTIDs make the catch-up after an outage exact:
// every transaction carries a globally unique id, so a server applies each one once and only
// once, however long it was disconnected.
//
// The auto-increment offsets are what stop the two sides minting the same id while they are
// apart. That matters more here than in most systems, because this app derives its document
// numbers from the primary key -- `CHK-${chequeId}`, `EST-${100000 + estimateId}` and so on -- so
// colliding ids would mean two different cheques both called CHK-15613.
const pool = require('../db');
require('dotenv').config();

// name -> [required value or test, why it matters, how to fix]
const CHECKS = [
  ['log_bin', (v) => v === 'ON',
    'Without a binary log there is nothing for the other side to replay -- this server cannot be a source.',
    'Add log-bin=mysql-bin to my.ini and restart. It is read-only at runtime.'],
  ['binlog_format', (v) => v === 'ROW',
    'ROW replicates the actual changed rows. STATEMENT replays the SQL, which drifts on anything non-deterministic (NOW(), auto-increment).',
    'Set binlog_format=ROW in my.ini.'],
  ['gtid_mode', (v) => v === 'ON',
    'GTIDs are what make catch-up after an outage exact. Without them you resync by binlog file and position, by hand, and a mistake silently duplicates or skips transactions.',
    'Set gtid_mode=ON and enforce_gtid_consistency=ON in my.ini, then restart.'],
  ['enforce_gtid_consistency', (v) => v === 'ON',
    'Blocks the statement types GTID cannot represent safely, so you find out at write time rather than when replication breaks.',
    'Set enforce_gtid_consistency=ON in my.ini.'],
  ['server_id', (v) => Number(v) > 0,
    'Each server in the pair needs its own id, or they will not accept each other\'s changes.',
    'Office and cloud must differ -- e.g. server-id=1 on cloud, server-id=2 on office.'],
  ['auto_increment_increment', (v) => Number(v) >= 2,
    'Left at 1, both sides hand out the same ids while disconnected. This app builds document numbers from ids, so that means two different cheques both numbered CHK-15613.',
    'Set auto_increment_increment=10 on BOTH sides (room for branches later).'],
  ['auto_increment_offset', (v) => Number(v) >= 1,
    'Which slice of the id space this server uses.',
    'Cloud auto_increment_offset=1, office=2. They must differ.'],
];

async function value(name) {
  const [rows] = await pool.query('SHOW VARIABLES LIKE ?', [name]).catch(() => [[]]);
  return rows[0] ? rows[0].Value : null;
}

async function main() {
  console.log(`Checking ${process.env.DB_NAME} on ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}\n`);

  let ready = true;
  for (const [name, ok, why, fix] of CHECKS) {
    const v = await value(name);
    const pass = v !== null && ok(v);
    if (!pass) ready = false;
    console.log(`${pass ? 'OK  ' : 'FAIL'}  ${name.padEnd(26)} ${v === null ? '(not readable)' : v}`);
    if (!pass) {
      console.log(`      why:  ${why}`);
      console.log(`      fix:  ${fix}`);
    }
  }

  // A rough sense of what the first sync will have to carry.
  const [[size]] = await pool.query(
    `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024) AS mb, COUNT(*) AS tables
       FROM information_schema.tables WHERE table_schema = ?`, [process.env.DB_NAME]
  );
  console.log(`\ndata: ${size.mb} MB across ${size.tables} tables`);

  console.log(ready
    ? '\nThis server is ready to be wired into the pair.'
    : '\nNot ready -- fix the FAIL lines above, restart MySQL, and run this again.');
  console.log('\nNOTE: log_bin, gtid_mode and enforce_gtid_consistency cannot be changed at runtime.');
  console.log('They are read at startup, so each needs a my.ini edit and a service restart.');
  console.log('On this machine: C:\\ProgramData\\MySQL\\MySQL Server 9.4\\my.ini');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
