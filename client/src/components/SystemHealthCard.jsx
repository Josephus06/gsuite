import { useEffect, useState } from 'react';
import api from '../api/client';
import { Sparkline } from './charts';

// The System Admin's dashboard panel: is the server this ERP runs on healthy right now?
// A compact view of Admin > System Health (same endpoint, server/src/lib/systemHealth.js) -- CPU,
// memory with swap, disk, database size, MySQL uptime and replication -- with a link to the page.
//
// MySQL uptime is on the card deliberately: on the droplet MySQL was OOM-killed three times in two
// days and the only sign was a restart. A fresh uptime is the thing to notice.
function tone(pct, warn = 75, bad = 90) {
  if (pct == null) return 'var(--color-text-secondary)';
  if (pct >= bad) return 'var(--color-danger)';
  if (pct >= warn) return 'var(--color-warning)';
  return 'var(--color-success)';
}
function duration(sec) {
  if (!sec && sec !== 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function Tile({ label, value, sub, color, spark, id }) {
  return (
    <div style={{ background: 'var(--color-surface-sunken, rgba(0,0,0,0.04))', borderRadius: 10, padding: '10px 12px', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}
      {spark && <div style={{ marginTop: 4 }}><Sparkline data={spark} color={color} width={150} height={32} id={id} /></div>}
    </div>
  );
}

export default function SystemHealthCard({ navigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => api.get('/admin/system-health')
      .then(({ data: d }) => { if (alive) { setData(d); setError(''); } })
      .catch((err) => { if (alive) setError(err.response?.data?.error || 'System health is unavailable.'); });
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const h = data?.history || [];
  const mem = data?.memory;
  const disk = data?.disk;
  const db = data?.database;
  const repl = data?.replication;
  const restartedRecently = db?.uptimeSec != null && db.uptimeSec < 24 * 3600;

  return (
    <div className="holo-card dash-chart-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ margin: 0 }}>System Health</h3>
        <button type="button" className="link-btn" onClick={() => navigate('/system-health')}>Open details</button>
      </div>
      {data && <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{data.host?.name} · last 30 minutes</div>}
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <div className="muted">Loading…</div>}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <Tile id="sh-cpu" label="CPU" value={`${data.cpu?.percent ?? '—'}%`} sub={`${data.cpu?.cores} cores`}
              color={tone(data.cpu?.percent, 70, 90)} spark={h.map((s) => s.cpu)} />
            <Tile id="sh-mem" label="Memory" value={`${mem?.percent ?? '—'}%`}
              sub={`${Math.round((mem?.freeMb || 0) / 102.4) / 10} GB free of ${Math.round((mem?.totalMb || 0) / 102.4) / 10} GB${mem?.swapTotalMb ? ` · swap ${mem.swapUsedMb} MB used` : ''}`}
              color={tone(mem?.percent, 80, 92)} spark={h.map((s) => s.memPct)} />
            <Tile id="sh-disk" label="Disk" value={`${disk?.percent ?? '—'}%`} sub={disk ? `${disk.freeGb} GB free of ${disk.totalGb} GB` : ''}
              color={tone(disk?.percent, 75, 90)} />
            <Tile id="sh-db" label="Database" value={db?.sizeMb != null ? (db.sizeMb >= 1024 ? `${(db.sizeMb / 1024).toFixed(2)} GB` : `${db.sizeMb} MB`) : '—'}
              sub={db ? `${db.tables} tables · ${db.connections} connections` : ''} color="var(--color-primary)" />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, fontSize: 13 }}>
            <span>
              MySQL up <strong style={{ color: restartedRecently ? 'var(--color-danger)' : undefined }}>{duration(db?.uptimeSec)}</strong>
              {restartedRecently && <span style={{ color: 'var(--color-danger)' }}> — restarted in the last 24 h</span>}
            </span>
            <span>
              Replication{' '}
              {repl?.configured
                ? <strong style={{ color: repl.healthy ? 'var(--color-success)' : 'var(--color-danger)' }}>{repl.healthy ? 'healthy' : 'NOT healthy'}</strong>
                : <span className="muted">{repl?.unreadable ? 'status not readable' : 'not configured'}</span>}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
