import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import { API, STATUS_COLOR, STATUS_LABEL, StatusBadge, errorOf, personName, slotHours, timeText } from './installation/common';

// Production > Installation Planner -- the dashboard (server: routes/installationPlanner.js). PLANNER's
// planner dashboard: the counts on top, then the Project Schedule Calendar -- every project across its
// Timeline From..To -- in Month, Week and List views; clicking a project opens it.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export default function InstallationPlanner() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [rights, setRights] = useState(null);
  const [installers, setInstallers] = useState([]);
  const [view, setView] = useState('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [status, setStatus] = useState('');
  const [installerId, setInstallerId] = useState('');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const todayKey = ymd(new Date());

  // The days on screen: a 6-week grid for Month, Sun..Sat for Week, the month for List.
  const days = useMemo(() => {
    if (view === 'day') return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
    if (view === 'week' || view === 'crew') {
      const start = addDays(anchor, -anchor.getDay());
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    if (view === 'list') {
      const n = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
      return Array.from({ length: n }, (_, i) => addDays(first, i));
    }
    const start = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [view, anchor]);
  const from = ymd(days[0]);
  const to = ymd(days[days.length - 1]);

  useEffect(() => {
    api.get(`${API}/dashboard`).then(({ data }) => setStats(data)).catch((err) => setError(errorOf(err)));
    api.get(`${API}/meta`).then(({ data }) => {
      setRights(data.rights);
      setInstallers(data.employees.filter((e) => e.is_installer));
    }).catch(() => {});
  }, []);

  const [crew, setCrew] = useState([]);
  useEffect(() => {
    setLoading(true);
    const req = view === 'crew' || view === 'day'
      ? api.get(`${API}/crew`, { params: { from, to } }).then(({ data }) => setCrew(data))
      : api.get(`${API}/events`, { params: { from, to, status: status || undefined, employee_id: installerId || undefined } }).then(({ data }) => setEvents(data));
    req.then(() => setError('')).catch((err) => setError(errorOf(err))).finally(() => setLoading(false));
  }, [from, to, status, view, installerId]);
  // The Installers and Day views narrowed to the chosen installer.
  const shownInstallers = installerId ? installers.filter((e) => Number(e.id) === Number(installerId)) : installers;
  const shownCrew = installerId ? crew.filter((s) => Number(s.employee_id) === Number(installerId)) : crew;

  const byDay = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      const start = String(e.date_from).slice(0, 10);
      const end = String(e.date_to || e.date_from).slice(0, 10);
      for (let k = start < from ? from : start; k <= end && k <= to; k = ymd(addDays(parse(k), 1))) {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
      }
    }
    return map;
  }, [events, from, to]);

  function step(n) {
    if (view === 'day') setAnchor(addDays(anchor, n));
    else if (view === 'week' || view === 'crew') setAnchor(addDays(anchor, 7 * n));
    else setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
  }

  const title = view === 'day' ? `${WEEKDAYS[anchor.getDay()]}, ${displayDate(from)}`
    : view === 'week' || view === 'crew'
    ? `${displayDate(from)} – ${displayDate(to)}`
    : `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;

  const open = (e) => navigate(`/installation-planner/projects/${e.id}`);
  // Clicking a date opens that day, installer by installer, hour by hour.
  const openDay = (k) => { setAnchor(parse(k)); setView('day'); };

  const cards = [
    ['Total Projects', stats?.total, ''],
    ['On-going Projects', stats?.ongoing, 'ongoing'],
    ['Pending Projects', stats?.pending, 'pending'],
    ['On Hold', stats?.on_hold, 'on-hold'],
    ['Due Projects', stats?.due, 'due'],
  ];

  return (
    <div className="page">
      <div className="page-header" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1>Installation Planner</h1>
          <div className="muted">Planned installation projects overview</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/installation-planner/projects">Projects</Link>
          {rights?.can_add && <Link className="btn btn-primary" to="/installation-planner/projects/new">+ New Project</Link>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="stat-grid">
        {cards.map(([label, value, key]) => (
          <Link key={label} className="stat-card" style={{ textDecoration: 'none' }}
            to={key === 'due' ? '/installation-planner/projects?due=1' : `/installation-planner/projects${key ? `?status=${key}` : ''}`}>
            <div className="value">{value == null ? '–' : Number(value).toLocaleString()}</div>
            <div className="label">{label}</div>
            {key === 'due' && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>End date today or past, not done</div>}
          </Link>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Project Schedule Calendar</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <button type="button" className="btn btn-sm" onClick={() => step(1)} aria-label="Next">›</button>
          <button type="button" className="btn btn-sm" onClick={() => setAnchor(new Date())}>Today</button>
          <h3 style={{ margin: '0 8px', minWidth: 200 }}>{title}</h3>
          <div style={{ display: 'flex' }}>
            {[['month', 'Month'], ['week', 'Week'], ['list', 'List'], ['crew', 'Installers'], ['day', 'Day']].map(([v, label]) => (
              <button key={v} type="button" className={`btn btn-sm ${view === v ? 'btn-primary' : ''}`} onClick={() => setView(v)}>{label}</button>
            ))}
          </div>
          {/* width auto: the app's select rule is full width, which pushed this onto a row of its own */}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <select value={installerId} onChange={(e) => setInstallerId(e.target.value)} style={{ width: 'auto', minWidth: 180 }} title="Installer">
              <option value="">All installers</option>
              {installers.map((e) => <option key={e.id} value={e.id}>{personName(e)}</option>)}
            </select>
            {view !== 'crew' && view !== 'day' && (
              <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto', minWidth: 140 }} title="Status">
                <option value="">All statuses</option>
                {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8, fontSize: 11 }}>
          {Object.entries(STATUS_LABEL).map(([k, l]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLOR[k], display: 'inline-block' }} />{l}
            </span>
          ))}
        </div>

        {loading ? <LoadingSpinner /> : view === 'day' ? (
          <DayView dayKey={from} slots={shownCrew} installers={shownInstallers} onOpen={(s) => navigate(`/installation-planner/projects/${s.project_id}`)} />
        ) : view === 'crew' ? (
          <CrewView days={days} slots={shownCrew} installers={shownInstallers} todayKey={todayKey} onDay={openDay} onOpen={(s) => navigate(`/installation-planner/projects/${s.project_id}`)} />
        ) : view === 'list' ? (
          <ListView days={days} byDay={byDay} todayKey={todayKey} onOpen={open} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(110px, 1fr))', gap: 1, background: 'var(--border)', minWidth: 770 }}>
              {WEEKDAYS.map((w) => <div key={w} style={{ background: 'var(--surface)', padding: 6, fontWeight: 600, fontSize: 12 }}>{w}</div>)}
              {days.map((d) => {
                const k = ymd(d);
                const list = byDay.get(k) || [];
                const inMonth = view === 'week' || d.getMonth() === anchor.getMonth();
                const max = view === 'week' ? 50 : 4;
                return (
                  <div key={k} style={{ background: 'var(--surface)', minHeight: view === 'week' ? 360 : 104, padding: 4, opacity: inMonth ? 1 : 0.45 }}>
                    <button type="button" onClick={() => openDay(k)} title="Open this day by installer"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: k === todayKey ? 700 : 400, color: k === todayKey ? 'var(--accent)' : 'inherit', textDecoration: 'underline dotted' }}>
                      {d.getDate()}
                    </button>
                    {list.slice(0, max).map((e) => <EventBar key={e.id} e={e} dayKey={k} weekStart={d.getDay() === 0} wrap={view === 'week'} onOpen={() => open(e)} />)}
                    {list.length > max && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>+{list.length - max} more</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// One project on one day. The bar runs across the project's days; its name shows on its first day and
// again at the start of each week, so a long project reads as one bar per row.
function EventBar({ e, dayKey, weekStart, wrap, onOpen }) {
  const start = String(e.date_from).slice(0, 10);
  const end = String(e.date_to || e.date_from).slice(0, 10);
  const first = dayKey === start;
  const last = dayKey === end;
  const label = first || weekStart || wrap;
  return (
    <button type="button" onClick={onOpen}
      title={`${e.project_no} · ${e.title} (${STATUS_LABEL[e.status]}) · ${displayDate(start)}${end !== start ? ` – ${displayDate(end)}` : ''} · ${e.progress}%`}
      style={{
        display: 'block', width: wrap ? '100%' : 'calc(100% + 8px)', margin: wrap ? '3px 0 0' : '3px -4px 0', textAlign: 'left', cursor: 'pointer',
        background: STATUS_COLOR[e.status] || '#64748b', color: '#fff', border: 'none', fontSize: 11, lineHeight: 1.35,
        padding: '2px 6px', whiteSpace: wrap ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        // A continuation day carries no text; without a set height the bar collapsed to a thin line.
        minHeight: 19, boxSizing: 'border-box',
        borderRadius: wrap ? 4 : `${first ? 4 : 0}px ${last ? 4 : 0}px ${last ? 4 : 0}px ${first ? 4 : 0}px`,
        textDecoration: e.status === 'cancelled' ? 'line-through' : 'none',
      }}>
      {label ? `${e.title} (${(STATUS_LABEL[e.status] || e.status).toUpperCase()})` : ' '}
      {wrap && <div style={{ opacity: 0.85 }}>{e.project_no}{e.job_order_no ? ` · ${e.job_order_no}` : ''} · {e.progress}%</div>}
    </button>
  );
}

// One day, installer by installer (asked 2026-11-09): a column per installer, a row per hour from
// 12:00 AM to 11:00 PM, each booking a block from its start to its end. A Job Order keeps one colour
// across every installer on it, so a crew on the same job reads as one band.
const HOUR_PX = 40;
const JOB_COLORS = ['#f4b183', '#00b0f0', '#a9d18e', '#ffd966', '#c9a0dc', '#f8a5a5', '#8fd3c7', '#b4c7e7'];
const minutesOf = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

function DayView({ dayKey, slots, installers, onOpen }) {
  const scroller = useRef(null);
  // Open on the working day (7 AM) rather than midnight.
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX; }, [dayKey]);

  const cols = new Map(installers.map((e) => [Number(e.id), { id: Number(e.id), name: personName(e), slots: [] }]));
  for (const s of slots) {
    if (String(s.work_date).slice(0, 10) !== dayKey) continue;
    if (!cols.has(Number(s.employee_id))) cols.set(Number(s.employee_id), { id: Number(s.employee_id), name: personName(s), slots: [] });
    cols.get(Number(s.employee_id)).slots.push(s);
  }
  const columns = [...cols.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!columns.length) return <div className="empty-state">No installers yet -- set Position Code INSTALLER on their employee records.</div>;

  // One colour per job (JO, else project), in the order the jobs first appear.
  const colorOf = new Map();
  for (const s of [...slots].sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time))) {
    const key = s.job_order_no || s.project_no;
    if (!colorOf.has(key)) colorOf.set(key, JOB_COLORS[colorOf.size % JOB_COLORS.length]);
  }
  const free = columns.filter((c) => !c.slots.length).length;
  const grid = { display: 'grid', gridTemplateColumns: `80px repeat(${columns.length}, minmax(140px, 1fr))` };

  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {free} of {columns.length} installer(s) free all day · click a block to open its project
      </div>
      <div className="table-wrap" ref={scroller} style={{ maxHeight: 620, overflow: 'auto' }}>
        <div style={{ minWidth: 80 + columns.length * 140 }}>
          {/* Installer names, kept in view while scrolling the hours */}
          <div style={{ ...grid, position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ padding: 6, fontWeight: 700, fontSize: 12 }}>Installers</div>
            {columns.map((c) => {
              const hrs = c.slots.reduce((n, s) => n + slotHours(s), 0);
              return (
                <div key={c.id} style={{ padding: 6, borderLeft: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase' }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: c.slots.length ? 'var(--text)' : '#16a34a', fontWeight: c.slots.length ? 400 : 600 }}>
                    {c.slots.length ? `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)} hrs booked` : 'Available all day'}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={grid}>
            {/* Hour labels */}
            <div>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} style={{ height: HOUR_PX, borderTop: '1px solid var(--border)', fontSize: 11, textAlign: 'right', paddingRight: 6, paddingTop: 2 }}>{hourLabel(h)}</div>
              ))}
            </div>
            {columns.map((c) => (
              <div key={c.id} style={{ position: 'relative', borderLeft: '1px solid var(--border)' }}>
                {Array.from({ length: 24 }, (_, h) => <div key={h} style={{ height: HOUR_PX, borderTop: '1px solid var(--border)' }} />)}
                {c.slots.map((s) => {
                  const top = (minutesOf(s.start_time) / 60) * HOUR_PX;
                  const height = Math.max(18, ((minutesOf(s.end_time) - minutesOf(s.start_time)) / 60) * HOUR_PX);
                  return (
                    <button key={s.id} type="button" onClick={() => onOpen(s)}
                      title={`${timeText(s.start_time)} – ${timeText(s.end_time)} · ${s.project_no} · ${s.project_title}${s.note ? ` · ${s.note}` : ''}`}
                      style={{
                        position: 'absolute', top, height, left: 3, right: 3, overflow: 'hidden', textAlign: 'left', cursor: 'pointer',
                        background: colorOf.get(s.job_order_no || s.project_no), color: '#1f2937', border: '1px solid rgba(0,0,0,0.15)',
                        borderRadius: 4, padding: '3px 6px', fontSize: 11, lineHeight: 1.3, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                      }}>
                      <span>{timeText(s.start_time)} – {timeText(s.end_time)}</span>
                      <strong style={{ fontSize: 12 }}>({s.job_order_no || s.project_no})</strong>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// The week by installer: EVERY installer (Position Code INSTALLER) gets a row, booked or not, so a free
// installer on a given day is plain to see; one column per day, each slot its hours and the project / JO.
function CrewView({ days, slots, installers, todayKey, onOpen, onDay }) {
  const people = new Map();
  for (const e of installers) people.set(Number(e.id), { id: Number(e.id), name: personName(e), byDay: new Map(), hours: 0 });
  for (const s of slots) {
    // Someone booked before they stopped being an installer still shows, with their booking.
    if (!people.has(Number(s.employee_id))) people.set(Number(s.employee_id), { id: Number(s.employee_id), name: personName(s), byDay: new Map(), hours: 0 });
    const row = people.get(Number(s.employee_id));
    const k = String(s.work_date).slice(0, 10);
    if (!row.byDay.has(k)) row.byDay.set(k, []);
    row.byDay.get(k).push(s);
    row.hours += slotHours(s);
  }
  const rows = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!rows.length) return <div className="empty-state">No installers yet -- set Position Code INSTALLER on their employee records.</div>;
  const freeOn = (k) => rows.filter((r) => !(r.byDay.get(k) || []).length).length;
  return (
    <div className="table-wrap">
      <table style={{ minWidth: 900, tableLayout: 'fixed', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ width: 170 }}>Installer</th>
            {days.map((d) => {
              const k = ymd(d);
              const free = freeOn(k);
              return (
                <th key={k} onClick={() => onDay(k)} title="Open this day hour by hour"
                  style={{ cursor: 'pointer', color: k === todayKey ? 'var(--accent)' : undefined }}>
                  <span style={{ textDecoration: 'underline dotted' }}>{WEEKDAYS[d.getDay()]} {d.getDate()}</span>
                  <div style={{ fontSize: 11, fontWeight: 400, color: free ? '#16a34a' : 'var(--text)' }}>{free} of {rows.length} available</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.name}</strong><div className="muted" style={{ fontSize: 11 }}>{r.hours ? `${Number.isInteger(r.hours) ? r.hours : r.hours.toFixed(1)} hrs this week` : 'Not scheduled this week'}</div></td>
              {days.map((d) => {
                const list = r.byDay.get(ymd(d)) || [];
                return (
                  <td key={ymd(d)} style={{ verticalAlign: 'top', padding: 4 }}>
                    {list.length === 0 && (
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', background: 'rgba(22,163,74,0.10)', borderRadius: 4, padding: '3px 5px' }}>Available</div>
                    )}
                    {list.map((s) => (
                      <button key={s.id} type="button" onClick={() => onOpen(s)}
                        title={`${s.project_no} · ${s.project_title}${s.note ? ` · ${s.note}` : ''}`}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', marginBottom: 3, padding: '3px 5px', fontSize: 11, lineHeight: 1.3,
                          border: 'none', borderRadius: 4, cursor: 'pointer', color: '#fff', background: STATUS_COLOR[s.project_status] || '#64748b',
                        }}>
                        <strong>{timeText(s.start_time)} – {timeText(s.end_time)}</strong>
                        <div>{s.job_order_no || s.project_no}</div>
                      </button>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListView({ days, byDay, todayKey, onOpen }) {
  const withEvents = days.filter((d) => (byDay.get(ymd(d)) || []).length);
  if (!withEvents.length) return <div className="empty-state">No projects scheduled in this month.</div>;
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {withEvents.map((d) => {
            const k = ymd(d);
            return [
              <tr key={k}>
                <th colSpan={4} style={{ background: 'var(--border)', color: k === todayKey ? 'var(--accent)' : undefined }}>
                  {WEEKDAYS[d.getDay()]}, {displayDate(k)}{k === todayKey ? ' · Today' : ''}
                </th>
              </tr>,
              ...(byDay.get(k) || []).map((e) => (
                <tr key={`${k}-${e.id}`} onClick={() => onOpen(e)} style={{ cursor: 'pointer' }}>
                  <td style={{ width: 12 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_COLOR[e.status], display: 'inline-block' }} /></td>
                  <td><strong>{e.title}</strong><div className="muted" style={{ fontSize: 12 }}>{e.project_no}{e.job_order_no ? ` · ${e.job_order_no}` : ''}{e.category_name ? ` · ${e.category_name}` : ''}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{displayDate(e.date_from)}{e.date_to && e.date_to !== e.date_from ? ` – ${displayDate(e.date_to)}` : ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={e.status} /> {e.progress}%</td>
                </tr>
              )),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
