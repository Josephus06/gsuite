import { useEffect, useState } from 'react';
import { API, RESOURCES, resourceList, mergeSlots } from './installation/common';
// No login (2026-11-13): a plain request to the public feed, without the app's token handling or its
// redirect to the login page. `which` is 'today' or 'tomorrow' -- the only days the feed serves.
const feed = (kind, which) => fetch(`/api${API}/public-board?kind=${encodeURIComponent(kind)}&day=${which}`, { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
import { DayView } from './InstallationPlanner';

// Installation Planner > Monitor view (asked 2026-11-13): the Day view per installer on its own page,
// for a big screen in Production. No menus, nothing to click. It reloads every minute and moves on to
// the next day at midnight by itself. ?kind=subcon / driver / vehicle shows those instead.
// A slideshow (2026-11-13): today, then tomorrow, each for SLIDE_MS, round and round.
const REFRESH_MS = 60 * 1000;
const SLIDE_MS = 10 * 1000;
const SLIDES = [{ key: 'today', label: 'Today' }, { key: 'tomorrow', label: 'Tomorrow' }];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const longDate = (key) => new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

export default function InstallationBoard() {
  const kindKey = new URLSearchParams(window.location.search).get('kind');
  const resource = RESOURCES[kindKey] ? kindKey : 'installer';
  const kind = RESOURCES[resource];
  const [now, setNow] = useState(() => new Date());
  // One feed per slide: { today: { day, employees, vehicles, slots }, tomorrow: {...} }.
  const [boards, setBoards] = useState({});
  const [slide, setSlide] = useState(0);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(null);
  const day = ymd(now);

  // The clock -- and with it the day, so the board rolls over at midnight.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setSlide((s) => (s + 1) % SLIDES.length), SLIDE_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    const load = () => Promise.all(SLIDES.map((s) => feed(resource, s.key))).then((data) => {
      if (!live) return;
      setBoards(Object.fromEntries(SLIDES.map((s, i) => [s.key, data[i]])));
      setError('');
      setUpdated(new Date());
    }).catch(() => { if (live) setError('Could not load the schedule -- retrying.'); });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [day, resource]);

  const current = SLIDES[slide];
  const data = boards[current.key];
  const everyone = resourceList(resource, data ? { employees: data.employees, vehicles: data.vehicles } : { employees: [], vehicles: [] });
  const slots = mergeSlots(everyone, data?.slots || []);
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const shownDay = data?.day || (current.key === 'today' ? day : ymd(new Date(now.getTime() + 86400000)));

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #f5f6f8)', padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>
          {kind.plural} Schedule ·{' '}
          <span style={{ color: current.key === 'today' ? 'var(--primary, #4f46e5)' : '#d97706' }}>{current.label}</span>
        </h1>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{longDate(shownDay)} · {time}</div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card" style={{ padding: 10 }}>
        <DayView key={current.key} dayKey={shownDay} slots={slots} people={everyone} kind={kind} board />
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ display: 'flex', gap: 6 }}>
          {SLIDES.map((s, i) => (
            <span key={s.key} style={{ fontWeight: i === slide ? 700 : 400, opacity: i === slide ? 1 : 0.6 }}>
              {i === slide ? '●' : '○'} {s.label}
            </span>
          ))}
        </span>
        <span>
          Changes every {SLIDE_MS / 1000} seconds · updates every minute{updated ? ` · last updated ${updated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
      </div>
    </div>
  );
}
