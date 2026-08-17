// Takes a full, restorable dump of a GSUITE database.
//
// WHY THIS EXISTS. There is no backup of this system. The cloud database holds 69,000 estimates,
// 129,000 customer payments and the whole general ledger, and until now the only copy was the one
// running. Everything in the hybrid plan -- moving hosts, enabling binary logging, seeding the
// office server -- starts by having something to restore from if a step goes wrong.
//
// Run it against whichever side you mean to copy:
//
//   node src/db/backup.js                                  the local database
//   DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=... node src/db/backup.js
//
//   --out=D:\backups          where to write (default: ./backups next to the repo)
//   --keep=14                 how many dumps to retain (default 14)
//
// The dump is written with --single-transaction, so InnoDB tables are captured at one consistent
// point in time without locking the application out while it runs.
//
// It also records the binary log position (--source-data=2, as a comment). That is what lets a
// replica be seeded from this file and then told exactly where to start following -- without it
// you cannot safely turn a restored copy into a replica.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const argVal = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};

// mysqldump is not on PATH on this machine; it ships beside the server.
const CANDIDATES = [
  process.env.MYSQLDUMP_PATH,
  'C:/Program Files/MySQL/MySQL Server 9.4/bin/mysqldump.exe',
  'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe',
  'mysqldump',
].filter(Boolean);

function findDump() {
  for (const c of CANDIDATES) {
    if (c === 'mysqldump') return c; // last resort: hope it is on PATH
    if (fs.existsSync(c)) return c;
  }
  return 'mysqldump';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '3306';
  const user = process.env.DB_USER || 'root';
  const pass = process.env.DB_PASSWORD || '';
  const db = process.env.DB_NAME || 'gsuite_erp';

  const outDir = path.resolve(argVal('out', path.join(__dirname, '../../../backups')));
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${db}-${host.replace(/[^\w.-]/g, '_')}-${stamp()}.sql`);

  const bin = findDump();
  console.log(`mysqldump: ${bin}`);
  console.log(`source:    ${db} on ${host}:${port}`);
  console.log(`writing:   ${file}\n`);

  const base = [
    `--host=${host}`, `--port=${port}`, `--user=${user}`,
    '--single-transaction',      // consistent snapshot without locking the app out
    '--routines', '--events', '--triggers',
    '--default-character-set=utf8mb4',
  ];
  // Recording the replication position needs a binary log. Railway's managed MySQL runs with
  // log_bin=OFF and no way to change it, and mysqldump refuses outright ("Binlogging on server
  // not active") rather than skipping the flags -- so a first attempt that fails that way is
  // retried without them. The dump is still a complete, restorable copy of the data; it just
  // cannot be used to seed a replica, which is worth saying out loud rather than discovering
  // later in the middle of a migration.
  const replicaFlags = ['--set-gtid-purged=AUTO', '--source-data=2'];

  const run = (args) => new Promise((resolve) => {
    // The password goes through the environment, not argv -- anything on the command line is
    // visible to every other process on the machine.
    const child = spawn(bin, args, {
      env: { ...process.env, MYSQL_PWD: pass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = fs.createWriteStream(file);
    child.stdout.pipe(out);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (c) => resolve({ code: c, err }));
  });

  let { code, err: stderr } = await run([...base, ...replicaFlags, db]);
  let seedable = code === 0;
  if (code !== 0 && /binlog/i.test(stderr)) {
    console.warn('This server has binary logging disabled, so the replication position cannot be');
    console.warn('recorded. Retrying without it -- the backup will restore, but cannot seed a replica.\n');
    ({ code, err: stderr } = await run([...base, db]));
    seedable = false;
  }

  // A dump that failed halfway still leaves a file behind, and a truncated dump that looks like a
  // backup is worse than no backup at all -- so an unsuccessful run deletes its own output.
  if (code !== 0) {
    fs.rmSync(file, { force: true });
    console.error(`mysqldump exited ${code}. Partial file removed.`);
    if (stderr) console.error(stderr.trim().split('\n').slice(-6).join('\n'));
    process.exit(1);
  }

  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  // mysqldump always writes a "Using a password on the command line" style note to stderr; only
  // surface warnings that are not that.
  const warn = stderr.split('\n').filter((l) => l.trim() && !/password/i.test(l));
  if (warn.length) console.warn(`warnings:\n${warn.join('\n')}\n`);

  // A dump missing its final marker was cut short, whatever the exit code said.
  const tail = fs.readFileSync(file, 'utf8').slice(-400);
  const complete = tail.includes('Dump completed');
  console.log(`done: ${mb} MB  ${complete ? '(complete)' : '!! NO COMPLETION MARKER -- treat as suspect'}`);
  console.log(seedable
    ? 'includes the replication position -- can seed a replica.'
    : 'no replication position -- restores fine, but cannot seed a replica.');

  // Retention, oldest first. Only files for this same database are considered, so backups of the
  // office and cloud copies do not evict each other.
  const keep = Number(argVal('keep', 14));
  const mine = fs.readdirSync(outDir)
    .filter((f) => f.startsWith(`${db}-`) && f.endsWith('.sql'))
    .sort();
  const excess = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of excess) fs.rmSync(path.join(outDir, f), { force: true });
  if (excess.length) console.log(`removed ${excess.length} old backup(s), keeping ${keep}.`);

  console.log(`\nRestore with:\n  mysql --host=<h> --user=<u> -p <database> < "${file}"`);
  if (!complete) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
