import { useEffect, useState } from 'react';
import api from '../api/client';
import { API, RESOURCES, resourceList, mergeSlots } from './installation/common';
import { DayView } from './InstallationPlanner';

// Installation Planner > Monitor view (asked 2026-11-13): the Day view per installer on its own page,
// for a big screen in Production. No menus, nothing to click. It reloads every minute and moves on to
// the next day at midnight by itself. ?kind=subcon / driver / vehicle shows those instead.
const REFRESH_MS = 60 * 1000;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function InstallationBoard() {
  const kindKey = new URLSearchParams(window.location.search).get('kind');
  const resource = RESOURCES[kindKey] ? kindKey : 'installer';
  const kind = RESOURCES[resource];
  const [now, setNow] = useState(() => new Date());
  const [people, setPeople] = useState({ employees: [], vehicles: [] });
  const [crew, setCrew] = useState([]);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(null);
  const day = ymd(now);

  // The clock -- and with it the day, so the board rolls over at midnight.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    const load = () => Promise.all([
      api.get(`${API}/meta`),
      api.get(`${API}/crew`, { params: { from: day, to: day, role: resource } }),
    ]).then(([meta, c]) => {
      if (!live) return;
      setPeople({ employees: meta.data.employees, vehicles: meta.data.vehicles });
      setCrew(c.data);
      setError('');
      setUpdated(new Date());
    }).catch((err) => { if (live) setError(err.response?.data?.error || 'Could not load the schedule -- retrying.'); });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [day, resource]);

  const everyone = resourceList(resource, people);
  const slots = mergeSlots(everyone, crew);
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #f5f6f8)', padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>{kind.plural} Schedule</h1>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{date} · {time}</div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card" style={{ padding: 10 }}>
        <DayView dayKey={day} slots={slots} people={everyone} kind={kind} board />
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Updates every minute{updated ? ` · last updated ${updated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
      </div>
    </div>
  );
}
