import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { Sparkline } from '../components/charts';
import LoadingSpinner from '../components/LoadingSpinner';

// Admin > System Health: what the server and its database are doing right now.
//
// The point is answering "is anything wrong" at a glance, so every figure is paired with a
// judgement -- a percentage on its own says nothing unless you already know what normal looks
// like. Thresholds are deliberately generous: a machine that is briefly busy is not a problem,
// and a monitor that cries wolf gets ignored, which is worse than having none at all.

const REFRESH_MS = 15000;

function duration(sec) {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// green / amber / red, by how close a figure is to actually being a problem.
function band(pct, warn = 75, bad = 90) {
  if (pct >= bad) return { color: '#b91c1c', label: 'critical' };
  if (pct >= warn) return { color: '#b45309', label: 'high' };
  return { color: '#15803d', label: 'normal' };
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="card" style={{ flex: '1 1 190px' }}>
      <div className="muted" style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: '1.7rem', fontWeight: 700, color: tone, lineHeight: 1.2 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: '0.83rem' }}>{sub}</div>}
    </div>
  );
}

export default function SystemHealth() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const timer = useRef(null);

  async function load() {
    try {
      const { data: d } = await api.get('/admin/system-health');
      setData(d);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read system health.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    timer.current = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer.current);
  }, []);

  if (loading) return <LoadingSpinner />;

  const cpuHistory = (data?.history || []).map((h) => h.cpu);
  const memHistory = (data?.history || []).map((h) => h.memPct);
  const cpuBand = band(data?.cpu?.percent ?? 0);
  const memBand = band(data?.memory?.percent ?? 0);
  const diskBand = band(data?.disk?.percent ?? 0, 80, 92);
  const db = data?.database || {};
  const rep = data?.replication || {};
  const gridStyle = { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' };

  return (
    <div>
      <div className="page-header">
        <h1>System Health</h1>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          refreshes every {REFRESH_MS / 1000}s · {data?.host?.name}
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <Stat label="CPU" value={`${data?.cpu?.percent ?? 0}%`} tone={cpuBand.color}
          sub={`${data?.cpu?.cores} cores · ${cpuBand.label}`} />
        <Stat label="Memory" value={`${data?.memory?.percent ?? 0}%`} tone={memBand.color}
          sub={`${data?.memory?.freeMb} MB free of ${data?.memory?.totalMb} · ${memBand.label}`} />
        <Stat label="Disk" value={data?.disk ? `${data.disk.percent}%` : '—'} tone={diskBand.color}
          sub={data?.disk ? `${data.disk.freeGb} GB free of ${data.disk.totalGb} · ${diskBand.label}` : 'unavailable'} />
        <Stat label="Server uptime" value={duration(data?.host?.uptimeSec)}
          sub={`app up ${duration(data?.app?.uptimeSec)}`} />
      </div>

      <div style={{ ...gridStyle, marginBottom: 16 }}>
        <div className="card">
          <h3>CPU — last 30 minutes</h3>
          {cpuHistory.length > 1
            ? <Sparkline data={cpuHistory} color={cpuBand.color} height={70} />
            : <p className="muted">Collecting — the graph fills in over the first few minutes.</p>}
        </div>
        <div className="card">
          <h3>Memory — last 30 minutes</h3>
          {memHistory.length > 1
            ? <Sparkline data={memHistory} color={memBand.color} height={70} />
            : <p className="muted">Collecting…</p>}
        </div>
      </div>

      <div style={gridStyle}>
        <div className="card">
          <h3>Database</h3>
          {db.reachable ? (
            <table style={{ width: '100%', fontSize: '0.92rem' }}>
              <tbody>
                <tr><td className="muted">Version</td><td style={{ textAlign: 'right' }}>{db.version}</td></tr>
                <tr><td className="muted">Size</td><td style={{ textAlign: 'right' }}>{db.sizeMb} MB · {db.tables} tables</td></tr>
                <tr><td className="muted">Connections</td><td style={{ textAlign: 'right' }}>{db.connections} open, {db.running} running</td></tr>
                <tr><td className="muted">Uptime</td><td style={{ textAlign: 'right' }}>{duration(db.uptimeSec)}</td></tr>
                {/* Slow queries and aborted connections are the two counters that quietly predict
                    trouble -- both climb long before anyone reports the system feeling slow. */}
                <tr><td className="muted">Slow queries</td><td style={{ textAlign: 'right' }}>{Number(db.slowQueries || 0).toLocaleString()}</td></tr>
                <tr><td className="muted">Aborted connections</td><td style={{ textAlign: 'right' }}>{Number(db.abortedConnects || 0).toLocaleString()}</td></tr>
              </tbody>
            </table>
          ) : <p style={{ color: '#b91c1c' }}>Unreachable — {db.error}</p>}
        </div>

        <div className="card">
          <h3>Replication</h3>
          {!rep.configured ? (
            <p className="muted" style={{ margin: 0 }}>
              This server is not part of a replication pair. That is not a fault — a standalone
              install has nothing to replicate with.
            </p>
          ) : (
            <>
              <div style={{ marginBottom: 10 }}>
                <span className={`badge ${rep.healthy ? 'badge-success' : 'badge-danger'}`}>
                  {rep.healthy ? 'Healthy' : 'Attention needed'}
                </span>
              </div>
              {rep.channels.map((c) => (
                <div key={c.name} style={{ borderTop: '1px solid #e5e5e5', paddingTop: 8, marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{c.name}</strong>
                    <span style={{ color: c.healthy ? '#15803d' : '#b91c1c' }}>IO {c.io} · SQL {c.sql}</span>
                  </div>
                  <div className="muted" style={{ fontSize: '0.84rem' }}>
                    from {c.host || '—'}{c.behindSec !== null && c.behindSec !== undefined ? ` · ${c.behindSec}s behind` : ''}
                  </div>
                  {c.error && <div style={{ color: '#b91c1c', fontSize: '0.84rem' }}>{c.error}</div>}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="card">
          <h3>Application</h3>
          <table style={{ width: '100%', fontSize: '0.92rem' }}>
            <tbody>
              <tr><td className="muted">Node</td><td style={{ textAlign: 'right' }}>{data?.app?.nodeVersion}</td></tr>
              <tr><td className="muted">Memory in use</td><td style={{ textAlign: 'right' }}>{data?.app?.rssMb} MB</td></tr>
              <tr><td className="muted">Host</td><td style={{ textAlign: 'right' }}>{data?.host?.platform} {data?.host?.release}</td></tr>
              <tr><td className="muted">Reading taken</td><td style={{ textAlign: 'right' }}>{data?.at ? new Date(data.at).toLocaleTimeString() : '—'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
