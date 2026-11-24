// Admin > System Health > Dependencies (asked 2026-11-24): which npm packages have known security
// advisories (npm audit) and which are behind (npm outdated), for the server and the web app.
//
// CHECK ONLY, by decision (2026-11-24): updating packages from a button on the live server could break
// the build or the app with no review. Updates go through the normal change -> test -> deploy, where
// the list here is what to act on.
//
// Runs the npm the server itself runs with, in each project folder, read-only (audit / outdated
// change nothing). One check at a time; the result is kept 15 minutes.
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const PROJECTS = [
  { key: 'server', label: 'Server (API)', dir: path.join(ROOT, 'server') },
  { key: 'client', label: 'Web app', dir: path.join(ROOT, 'client') },
];
const CACHE_MS = 15 * 60_000;
let cache = null; // { at, result }
let running = null;

function npm(args, cwd) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    execFile(win ? 'npm.cmd' : 'npm', args, { cwd, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, shell: win, windowsHide: true },
      // Both commands exit non-zero when they find something -- the JSON on stdout is still the answer.
      (err, stdout, stderr) => resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), failed: err && !stdout ? (err.message || 'failed') : null }));
  });
}
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return null; } };

async function checkProject(p) {
  const [audit, outdated] = await Promise.all([npm(['audit', '--json', '--omit=dev'], p.dir), npm(['outdated', '--json', '--long'], p.dir)]);
  const a = parse(audit.stdout);
  const o = parse(outdated.stdout);
  const vulns = Object.values(a?.vulnerabilities || {}).map((v) => {
    const advisory = (v.via || []).find((x) => typeof x === 'object') || {};
    return {
      name: v.name, severity: v.severity, range: v.range || '',
      title: advisory.title || (v.via || []).filter((x) => typeof x === 'string').map((x) => `via ${x}`).join(', '),
      url: advisory.url || null,
      fix: v.fixAvailable === true ? 'npm audit fix'
        : v.fixAvailable && typeof v.fixAvailable === 'object' ? `update ${v.fixAvailable.name} to ${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major -- test first)' : ''}`
          : 'no fix yet',
      direct: !!v.isDirect,
    };
  });
  const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
  vulns.sort((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9) || x.name.localeCompare(y.name));
  const outdatedList = Object.entries(o || {}).map(([name, v]) => ({
    name, current: v.current || '(not installed)', wanted: v.wanted, latest: v.latest, type: v.type || '',
    major: !!(v.current && v.latest && String(v.current).split('.')[0] !== String(v.latest).split('.')[0]),
  })).sort((x, y) => Number(y.major) - Number(x.major) || x.name.localeCompare(y.name));
  return {
    key: p.key, label: p.label,
    counts: a?.metadata?.vulnerabilities || null,
    vulnerabilities: vulns, outdated: outdatedList,
    error: a ? null : (audit.failed || audit.stderr.split('\n').find((l) => /ERR|error/i.test(l)) || 'npm audit gave no answer (no internet to the registry?)').slice(0, 300),
  };
}

async function dependencyReport({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return { ...cache.result, cached: true };
  if (!running) {
    running = (async () => {
      const projects = [];
      for (const p of PROJECTS) projects.push(await checkProject(p));
      const result = { checked_at: new Date().toISOString(), node: process.version, projects };
      cache = { at: Date.now(), result };
      return result;
    })().finally(() => { running = null; });
  }
  return { ...(await running), cached: false };
}

module.exports = { dependencyReport };
