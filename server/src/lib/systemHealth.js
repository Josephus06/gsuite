const os = require('os');
const fs = require('fs');
const pool = require('../db');

// Powers Admin > System Health: what this machine and its database are actually doing.
//
// WHY IN-PROCESS RATHER THAN A MONITORING STACK. The point of this screen is to answer "is the
// system healthy right now, and is replication keeping up" without leaving the ERP. Prometheus and
// Grafana would answer it better and cost a great deal more to run on a 4 GB box that also serves
// the application. This keeps a short rolling history in memory -- enough to see a trend, cheap
// enough to forget on restart, which is the right trade for a graph nobody reads historically.
//
// Nothing here is persisted: a restart starts the history over. That is deliberate. Storing
// samples would mean a table growing forever for data whose value expires in an hour.

const SAMPLE_MS = 15000;   // one sample every 15s
const HISTORY = 120;       // 120 samples = the last 30 minutes

const history = [];
let lastCpu = os.cpus();

// CPU as a percentage over the interval since the previous sample. os.loadavg() is meaningless on
// Windows and describes queue length rather than utilisation on Linux, so the busy/idle tick
// counters are differenced instead -- that gives the same number top would show.
function cpuPercent() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < now.length; i += 1) {
    const a = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const b = now[i].times;
    const dIdle = b.idle - a.idle;
    const dTotal = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + dIdle + (b.irq - a.irq);
    idle += dIdle;
    total += dTotal;
  }
  lastCpu = now;
  if (total <= 0) return 0;
  return Number((100 - (idle / total) * 100).toFixed(1));
}

function diskUsage() {
  try {
    // statfs is the only way to read this without shelling out, and shelling out per sample on a
    // 15-second timer is a process spawn we do not need.
    const s = fs.statfsSync(process.platform === "win32" ? "C:/" : "/");
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free, pct: Number((((total - free) / total) * 100).toFixed(1)) };
  } catch {
    return null;
  }
}

function sample() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    at: Date.now(),
    cpu: cpuPercent(),
    memPct: Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1)),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

// Sampling starts with the process and runs regardless of whether anyone opens the page -- a graph
// that only begins collecting when you look at it shows nothing at the moment you need it.
function startSampling() {
  cpuPercent(); // prime the counters so the first real sample is not measured against zero
  setInterval(() => {
    history.push(sample());
    if (history.length > HISTORY) history.shift();
  }, SAMPLE_MS).unref();
}

async function databaseHealth() {
  const out = { reachable: false };
  try {
    const [[v]] = await pool.query('SELECT VERSION() AS version, @@hostname AS host');
    const [status] = await pool.query(
      `SHOW GLOBAL STATUS WHERE Variable_name IN
        ('Threads_connected','Threads_running','Uptime','Slow_queries','Aborted_connects','Questions')`
    );
    const s = Object.fromEntries(status.map((r) => [r.Variable_name, Number(r.Value)]));
    const [[size]] = await pool.query(
      `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024) AS mb, COUNT(*) AS tables
         FROM information_schema.tables WHERE table_schema = DATABASE()`
    );
    Object.assign(out, {
      reachable: true,
      version: v.version,
      host: v.host,
      sizeMb: Number(size.mb || 0),
      tables: Number(size.tables || 0),
      connections: s.Threads_connected || 0,
      running: s.Threads_running || 0,
      uptimeSec: s.Uptime || 0,
      slowQueries: s.Slow_queries || 0,
      abortedConnects: s.Aborted_connects || 0,
    });
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

// Replication, if this server is part of the office/cloud pair. A machine with no channels is not
// broken -- it simply is not replicating -- so that is reported as "not configured" rather than as
// a fault, which would cry wolf on any standalone install.
async function replicationHealth() {
  try {
    const [rows] = await pool.query(
      `SELECT c.CHANNEL_NAME AS name, cfg.HOST AS host,
              c.SERVICE_STATE AS io, c.LAST_ERROR_MESSAGE AS ioError,
              a.SERVICE_STATE AS sql_thread, a.LAST_ERROR_MESSAGE AS sqlError
         FROM performance_schema.replication_connection_status c
         LEFT JOIN performance_schema.replication_connection_configuration cfg
                ON cfg.CHANNEL_NAME = c.CHANNEL_NAME
         LEFT JOIN performance_schema.replication_applier_status_by_coordinator a
                ON a.CHANNEL_NAME = c.CHANNEL_NAME`
    );
    if (!rows.length) return { configured: false, channels: [] };

    const [lag] = await pool.query(
      `SELECT CHANNEL_NAME AS name,
              TIMESTAMPDIFF(SECOND, LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP, NOW()) AS behind
         FROM performance_schema.replication_applier_status_by_worker
        WHERE LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP > 0`
    );
    const lagBy = new Map(lag.map((l) => [l.name, l.behind]));

    const channels = rows.map((r) => ({
      name: r.name || '(default)',
      host: r.host || null,
      io: r.io,
      sql: r.sql_thread,
      healthy: r.io === 'ON' && r.sql_thread === 'ON',
      behindSec: lagBy.get(r.name) ?? null,
      error: r.ioError || r.sqlError || null,
    }));
    return { configured: true, channels, healthy: channels.every((c) => c.healthy) };
  } catch (err) {
    // A denial is NOT the same as having no replication, and conflating them is dangerous: the
    // page would confidently report "not configured" on a server that is replicating fine, so a
    // real break would look identical to a standalone install. Say which it is.
    const denied = /denied|access/i.test(err.message || '');
    return {
      configured: false,
      channels: [],
      unreadable: true,
      reason: denied
        ? 'The application database user cannot read replication status. Grant it REPLICATION CLIENT and SELECT on performance_schema.'
        : 'Replication status is unavailable: ' + (err.message || 'unknown error'),
    };
  }
}

async function collect() {
  const totalMem = os.totalmem();
  const disk = diskUsage();
  const [database, replication] = await Promise.all([databaseHealth(), replicationHealth()]);
  const current = sample();

  return {
    at: new Date().toISOString(),
    host: { name: os.hostname(), platform: os.platform(), release: os.release(), uptimeSec: Math.round(os.uptime()) },
    app: { nodeVersion: process.version, uptimeSec: Math.round(process.uptime()), rssMb: current.rssMb, pid: process.pid },
    cpu: { percent: current.cpu, cores: os.cpus().length, model: (os.cpus()[0] || {}).model || null },
    memory: {
      totalMb: Math.round(totalMem / 1024 / 1024),
      freeMb: Math.round(os.freemem() / 1024 / 1024),
      percent: current.memPct,
    },
    disk: disk && {
      totalGb: Number((disk.total / 1024 / 1024 / 1024).toFixed(1)),
      freeGb: Number((disk.free / 1024 / 1024 / 1024).toFixed(1)),
      percent: disk.pct,
    },
    database,
    replication,
    history: history.slice(),
  };
}

module.exports = { collect, startSampling };
