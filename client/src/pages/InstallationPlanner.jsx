import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import { API, RESOURCES, STATUS_COLOR, STATUS_LABEL, StatusBadge, errorOf, resourceKey, resourceList, mergeSlots, resourceName, slotHours, timeText } from './installation/common';
import { DecisionModal, RescheduleModal, rangeLabel } from './installation/reschedule';
import { downloadBlob, renderDayPng } from './installation/dayReport';
import ButtonMenu from '../components/ButtonMenu';
import ProjectSummaryModal from './installation/ProjectSummaryModal';

// Production > Installation Planner -- the dashboard (server: routes/installationPlanner.js). PLANNER's
// planner dashboard: the counts on top, then the Project Schedule Calendar -- every project across its
// Timeline From..To -- in Month, Week and List views; clicking a project opens it.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// readOnly (2026-11-09): the calendar alone, on the Dashboard of Account Officers, SBUs, Marketing,
// Sales Managers and General Managers -- every view, filter and search, but no dragging, no project
// opened and no reschedule panel. The server lets those roles read /meta, /events and /crew only.
export default function InstallationPlanner({ readOnly = false }) {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [rights, setRights] = useState(null);
  // Who and what is scheduled: employees (with their Position Code flags) and the Fleet vehicles.
  const [people, setPeople] = useState({ employees: [], vehicles: [] });
  // Which of them the Installers / Subcons / Drivers / Vehicles and Day views show.
  const [resource, setResource] = useState('installer');
  const [view, setViewRaw] = useState('month');
  // "+N more" on a Month / Week day opens List on that day alone (asked 2026-11-10); any other move
  // -- a view button, prev / next, Today -- goes back to the whole month.
  const [listDay, setListDay] = useState('');
  const setView = (v) => { setListDay(''); setViewRaw(v); };
  const openDayList = (k) => { setAnchor(parse(k)); setViewRaw('list'); setListDay(k); };
  const [anchor, setAnchor] = useState(() => new Date());
  const [status, setStatus] = useState('');
  // One installer / subcon / driver ('e<id>') or vehicle ('v<id>') to narrow every view to.
  const [whoKey, setWhoKey] = useState('');
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
    if (!readOnly) api.get(`${API}/dashboard`).then(({ data }) => setStats(data)).catch((err) => setError(errorOf(err)));
    api.get(`${API}/meta`).then(({ data }) => {
      setRights(data.rights);
      setPeople({ employees: data.employees, vehicles: data.vehicles });
    }).catch(() => {});
  }, [readOnly]); // a Signage Planner's Dashboard turns it off once their permissions load

  const [crew, setCrew] = useState([]);
  // Reschedules: what waits for the SBU, the dialog open, and a counter that reloads both after a change.
  const [pending, setPending] = useState([]);
  const [modal, setModal] = useState(null); // { kind: 'reschedule', project, newFrom, newTo } | { kind: 'decision', request }
  const [reloadKey, setReloadKey] = useState(0);
  const [dropKey, setDropKey] = useState('');
  const reload = () => setReloadKey((n) => n + 1);
  useEffect(() => {
    if (!readOnly) api.get(`${API}/reschedules`, { params: { status: 'for_approval' } }).then(({ data }) => setPending(data)).catch(() => {});
  }, [reloadKey, readOnly]);
  // The search box (JO #, customer, project # / title), sent once typing pauses.
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => {
    setLoading(true);
    const q = query || undefined;
    // A merged person (same name on two records) is asked for by every one of their ids.
    const whoP = whoKey && whoKey[0] === 'e' ? resourceList(resource, people).find((p) => p.key === whoKey) : null;
    const who = whoKey ? { [whoKey[0] === 'v' ? 'asset_id' : 'employee_id']: whoP ? whoP.ids.join(',') : whoKey.slice(1) } : {};
    const req = view === 'crew' || view === 'day'
      ? api.get(`${API}/crew`, { params: { from, to, search: q, role: resource } }).then(({ data }) => setCrew(data))
      : api.get(`${API}/events`, { params: { from, to, status: status || undefined, ...who, search: q } }).then(({ data }) => setEvents(data));
    req.then(() => setError('')).catch((err) => setError(errorOf(err))).finally(() => setLoading(false));
  }, [from, to, status, view, whoKey, reloadKey, query, resource]);
  // The rows / columns of the Installers, Subcons, Drivers, Vehicles and Day views: every one of that
  // kind, booked or not, narrowed to the one chosen; while searching, to those booked on what matches
  // (everyone else would only be noise in an answer to "who is on JO-123?").
  const allOfKind = resourceList(resource, people);
  const crewM = mergeSlots(allOfKind, crew);
  const shownCrew = whoKey ? crewM.filter((x) => resourceKey(x) === whoKey) : crewM;
  const bookedKeys = new Set(shownCrew.map(resourceKey));
  const shownPeople = allOfKind.filter((p) => (!whoKey || p.key === whoKey) && (!query || bookedKeys.has(p.key)));
  const R = RESOURCES[resource];

  // Generate Report: one day (the Day view's day, else the date the calendar is on) of one kind as a PNG,
  // with everyone of that kind and every booking -- not narrowed by the search or the person filter.
  const reportDay = view === 'day' ? from : ymd(anchor);
  const [reporting, setReporting] = useState(false);
  async function generateReport(kind) {
    setReporting(true);
    setError('');
    try {
      const { data } = await api.get(`${API}/crew`, { params: { from: reportDay, to: reportDay, role: kind } });
      const reportPeople = resourceList(kind, people);
      const blob = await renderDayPng({ dayKey: reportDay, kind: RESOURCES[kind], people: reportPeople, slots: mergeSlots(reportPeople, data) });
      downloadBlob(blob, `${RESOURCES[kind].plural}-Schedule-${reportDay}.png`);
    } catch (err) {
      setError(`Could not generate the report: ${errorOf(err)}`);
    } finally { setReporting(false); }
  }
  // Choosing another kind clears a pick of the old kind.
  const pickResource = (r) => { setResource(r); if (whoKey && !resourceList(r, people).some((p) => p.key === whoKey)) setWhoKey(''); };

  // Each project on each of its days, IN A FIXED LANE for the week (asked 2026-11-09): a bar keeps its row
  // on every day it spans, and a day where an earlier row is free leaves a gap rather than moving the next
  // project up -- otherwise RWIP-1188 rose into RWIP-241's row the day after 241 ended and read as 241
  // carrying on. byDay.get(k) is indexed by lane, with holes (undefined) where a row is empty that day.
  // A project with a reschedule waiting also gets a dashed "proposed" bar on the days it asks for.
  const byDay = useMemo(() => {
    const items = [];
    for (const e of events) {
      if (e.date_from) items.push({ item: e, s: String(e.date_from).slice(0, 10), e: String(e.date_to || e.date_from).slice(0, 10) });
      if (e.pending_id) {
        items.push({ item: { ...e, ghost: true, date_from: e.pending_from, date_to: e.pending_to }, s: String(e.pending_from).slice(0, 10), e: String(e.pending_to).slice(0, 10) });
      }
    }
    const map = new Map();
    for (let w = 0; w < days.length; w += 7) {
      const ws = ymd(days[w]);
      const we = ymd(days[Math.min(w + 6, days.length - 1)]);
      const segs = items
        .filter((x) => x.s <= we && x.e >= ws)
        .map((x) => ({ ...x, s: x.s < ws ? ws : x.s, e: x.e > we ? we : x.e }))
        // earliest first, then the longest, then a real bar before its proposed one
        .sort((a, b) => a.s.localeCompare(b.s) || b.e.localeCompare(a.e) || Number(!!a.item.ghost) - Number(!!b.item.ghost) || a.item.id - b.item.id);
      const lanes = []; // per lane, the last day it is taken up to
      for (const seg of segs) {
        let lane = lanes.findIndex((until) => until < seg.s);
        if (lane === -1) { lane = lanes.length; lanes.push(''); }
        lanes[lane] = seg.e;
        for (let k = seg.s; k <= seg.e; k = ymd(addDays(parse(k), 1))) {
          if (!map.has(k)) map.set(k, []);
          map.get(k)[lane] = seg.item;
        }
      }
      // Every day of the week gets the same number of rows, so the rows line up across the week.
      for (let i = w; i < Math.min(w + 7, days.length); i += 1) {
        const k = ymd(days[i]);
        if (!map.has(k)) map.set(k, []);
        map.get(k).length = Math.max(map.get(k).length, lanes.length);
      }
    }
    return map;
  }, [events, days]);

  // A bar can be dragged by whoever may edit projects, unless it is done / cancelled or already waiting.
  const canDrag = (e) => !readOnly && !!rights?.can_edit && !e.ghost && !e.pending_id && !['done', 'cancelled'].includes(e.status);
  // Dropped on day k: the start grip moves the start, the end grip the finish, the middle shifts both.
  function onDropDay(ev, k) {
    ev.preventDefault();
    setDropKey('');
    let drag;
    try { drag = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
    const e = events.find((x) => x.id === drag.id);
    if (!e) return;
    const start = String(e.date_from).slice(0, 10);
    const end = String(e.date_to || e.date_from).slice(0, 10);
    let newFrom = start;
    let newTo = end;
    if (drag.mode === 'start') newFrom = k;
    else if (drag.mode === 'end') newTo = k;
    else {
      const shift = Math.round((parse(k) - parse(drag.grab)) / 86400000);
      newFrom = ymd(addDays(parse(start), shift));
      newTo = ymd(addDays(parse(end), shift));
    }
    if (newFrom > newTo) {
      setError(`${e.project_no}: the start cannot go past the finish (${displayDate(end)}) -- drag the other end instead.`);
      return;
    }
    if (newFrom === start && newTo === end) return;
    setError('');
    setModal({ kind: 'reschedule', project: e, newFrom, newTo });
  }
  const openGhost = (e) => {
    if (readOnly) return;
    const r = pending.find((p) => p.id === e.pending_id);
    if (r) setModal({ kind: 'decision', request: r });
  };

  function step(n) {
    setListDay('');
    if (view === 'day') setAnchor(addDays(anchor, n));
    else if (view === 'week' || view === 'crew') setAnchor(addDays(anchor, 7 * n));
    else setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
  }

  const title = view === 'day' ? `${WEEKDAYS[anchor.getDay()]}, ${displayDate(from)}`
    : view === 'week' || view === 'crew'
    ? `${displayDate(from)} – ${displayDate(to)}`
    : `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;

  // Read only, a bar or a booking opens nothing -- its tooltip says what it is.
  // Read only (the Dashboard), a bar or booking opens the project's details in a popup instead
  // (asked 2026-11-10) -- the project page itself needs the Installation Planner permission.
  const openProject = (id) => { if (readOnly) setModal({ kind: 'summary', id }); else navigate(`/installation-planner/projects/${id}`); };
  const open = (e) => openProject(e.id);
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
    <div className={readOnly ? undefined : 'page'}>
      {!readOnly && (<>
      <div className="page-header" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1>Installation Planner</h1>
          <div className="muted">Planned installation projects overview</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/installation-planner/projects">Projects</Link>
          <ButtonMenu label={reporting ? 'Generating…' : 'Generate Report'} className="btn" disabled={reporting}
            title={`A PNG of ${displayDate(reportDay)} -- the whole day, everyone in it`}
            options={['installer', 'subcon', 'driver'].map((k) => ({
              label: RESOURCES[k].plural, hint: `${displayDate(reportDay)} · PNG`, onClick: () => generateReport(k),
            }))} />
          {rights?.can_add && <Link className="btn btn-primary" to="/installation-planner/projects/new">+ New Project</Link>}
        </div>
      </div>
      </>)}
      {error && <div className="error-banner">{error}</div>}

      {!readOnly && (<>
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

      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Reschedules waiting for SBU approval ({pending.length})</strong>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {pending.map((r) => (
              <button key={r.id} type="button" className={`badge ${r.may_decide ? 'badge-danger' : 'badge-warning'}`}
                style={{ border: 'none', cursor: 'pointer', padding: '6px 10px', textAlign: 'left' }}
                onClick={() => setModal({ kind: 'decision', request: r })}>
                {r.job_order_no || r.project_no} · {rangeLabel(r.old_date_from, r.old_date_to)} → {rangeLabel(r.new_date_from, r.new_date_to)} · {r.reason_name}
                {r.may_decide ? ' · waiting on you' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
      </>)}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{readOnly ? 'Installation Schedule' : 'Project Schedule Calendar'}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <button type="button" className="btn btn-sm" onClick={() => step(1)} aria-label="Next">›</button>
          <button type="button" className="btn btn-sm" onClick={() => { setListDay(''); setAnchor(new Date()); }}>Today</button>
          {/* The production-floor monitor (2026-11-13): today's installers, full screen, in its own tab. */}
          {!readOnly && (
            <a className="btn btn-sm" href="/installation-planner/board" target="_blank" rel="noreferrer"
              title="Today's schedule per installer, full screen, for the monitor in Production">Monitor view</a>
          )}
          <h3 style={{ margin: '0 8px', minWidth: 200 }}>{title}</h3>
          <div style={{ display: 'flex' }}>
            {/* Order asked 2026-11-09: Month | Week | Day | List | Installers | Subcons | Drivers | Vehicles.
                Day is hour by hour for the kind last chosen; the four kinds are each one's week. */}
            {[['month', 'Month'], ['week', 'Week'], ['day', 'Day'], ['list', 'List']].map(([v, label]) => (
              <button key={v} type="button" className={`btn btn-sm ${view === v ? 'btn-primary' : ''}`}
                // Month / Week / Day always open on the current one (asked 2026-11-13), not wherever the last view was paged to.
                onClick={() => { setView(v); setAnchor(new Date()); }}>{label}</button>
            ))}
            {Object.entries(RESOURCES).map(([r, cfg]) => (
              <button key={r} type="button" className={`btn btn-sm ${view === 'crew' && resource === r ? 'btn-primary' : ''}`}
                onClick={() => { pickResource(r); setView('crew'); }}>{cfg.plural}</button>
            ))}
          </div>
          {/* width auto: the app's select rule is full width, which pushed this onto a row of its own */}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search JO # or customer..." title="JO #, customer name, project # or title"
              style={{ width: 240, maxWidth: '100%' }} />
            {view !== 'crew' && (
              <select value={resource} onChange={(e) => pickResource(e.target.value)} style={{ width: 'auto' }} title="Filter by">
                {Object.entries(RESOURCES).map(([r, cfg]) => <option key={r} value={r}>{cfg.one}</option>)}
              </select>
            )}
            <select value={whoKey} onChange={(e) => setWhoKey(e.target.value)} style={{ width: 'auto', minWidth: 180 }} title={R.one}>
              <option value="">All {R.plural.toLowerCase()}</option>
              {allOfKind.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
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
          {(view === 'month' || view === 'week') && events.some((ev) => (ev.delays || []).length) && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: DELAY_RED, display: 'inline-block' }} /><strong>Delayed</strong> (day not worked)
            </span>
          )}
          {(view === 'month' || view === 'week') && (() => {
            // The work phases on the bars shown (their colour fills the bar on those days).
            const works = new Map();
            for (const ev of events) for (const x of ev.phases || []) if (!works.has(x.work_type)) works.set(x.work_type, x.color);
            return works.size ? (
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <span className="muted">· work:</span>
                {[...works].map(([name, c]) => (
                  <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: c, border: '1px solid rgba(0,0,0,0.25)', display: 'inline-block' }} />{name}
                  </span>
                ))}
                <span className="muted">(status = stripe under the bar)</span>
              </span>
            ) : null;
          })()}
          <span className="muted">
            · dashed = reschedule waiting for the SBU{rights?.can_edit && !readOnly ? ' · drag the end of a bar to move its start or finish, its middle to shift it' : ''}
          </span>
        </div>

        {!loading && query && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            {view === 'crew' || view === 'day'
              ? `${shownCrew.length} ${R.one.toLowerCase()} booking(s) match "${query}"`
              : `${events.length} project(s) match "${query}"`}
          </div>
        )}
        {loading ? <LoadingSpinner /> : (view === 'crew' || view === 'day') && query && !shownPeople.length ? (
          <div className="empty-state">No {R.one.toLowerCase()} is booked on anything matching "{query}" {view === 'day' ? 'on this day' : 'this week'}.</div>
        ) : view === 'day' ? (
          <DayView dayKey={from} slots={shownCrew} people={shownPeople} kind={R} onOpen={(s) => openProject(s.project_id)} />
        ) : view === 'crew' ? (
          <CrewView days={days} slots={shownCrew} people={shownPeople} kind={R} todayKey={todayKey} onDay={openDay} onOpen={(s) => openProject(s.project_id)} />
        ) : view === 'list' ? (
          <ListView days={listDay ? days.filter((d) => ymd(d) === listDay) : days} byDay={byDay} todayKey={todayKey} onOpen={open}
            onWholeMonth={listDay ? () => setListDay('') : null} />
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
                  <div key={k}
                    onDragOver={(ev) => { ev.preventDefault(); if (dropKey !== k) setDropKey(k); }}
                    onDragLeave={() => setDropKey((cur) => (cur === k ? '' : cur))}
                    onDrop={(ev) => onDropDay(ev, k)}
                    style={{
                      background: dropKey === k ? 'rgba(37,99,235,0.10)' : 'var(--surface)', minHeight: view === 'week' ? 480 : 104, padding: 4,
                      opacity: inMonth ? 1 : 0.45, outline: dropKey === k ? '2px dashed var(--accent)' : 'none', outlineOffset: -2,
                    }}>
                    <button type="button" onClick={() => openDay(k)} title="Open this day by installer"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: k === todayKey ? 700 : 400, color: k === todayKey ? 'var(--accent)' : 'inherit', textDecoration: 'underline dotted' }}>
                      {d.getDate()}
                    </button>
                    {Array.from(list.slice(0, max), (e, lane) => (e ? (
                      <EventBar key={`${e.id}${e.ghost ? 'g' : ''}`} e={e} dayKey={k} weekStart={d.getDay() === 0} wrap={view === 'week'}
                        draggable={canDrag(e)} onOpen={() => (e.ghost ? openGhost(e) : open(e))} />
                    ) : (
                      // an empty row keeps the bars below it level with the rest of the week
                      <div key={`gap${lane}`} style={{ height: view === 'week' ? BAR_H_WEEK : BAR_H, marginTop: 3 }} />
                    )))}
                    {list.slice(max).filter(Boolean).length > 0 && (
                      <button type="button" className="link-btn" onClick={() => openDayList(k)} title="List every job order scheduled this day"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, marginTop: 2, display: 'block' }}>
                        +{list.slice(max).filter(Boolean).length} more
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {modal?.kind === 'reschedule' && (
        <RescheduleModal project={modal.project} newFrom={modal.newFrom} newTo={modal.newTo}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />
      )}
      {modal?.kind === 'summary' && <ProjectSummaryModal projectId={modal.id} onClose={() => setModal(null)} />}
      {modal?.kind === 'decision' && (
        <DecisionModal request={modal.request} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />
      )}
    </div>
  );
}

// One project on one day. The bar runs across the project's days; its name shows on its first day and
// again at the start of each week, so a long project reads as one bar per row.
// Dragging (asked 2026-11-09): the grip on the bar's first day moves the start, the grip on its last day
// the finish, anywhere else shifts the whole range; the drop opens the reschedule dialog. A ghost (dashed)
// is a reschedule waiting for the SBU -- clicking it opens the request.
const BAR_H = 19;
const DELAY_RED = '#dc2626';
// Week: room for the whole title (up to three lines) and the project / JO line under it (asked 2026-11-10).
const BAR_H_WEEK = 80;
const CLAMP3 = { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
const GRIP = { position: 'absolute', top: 0, bottom: 0, width: 9, cursor: 'ew-resize', background: 'rgba(255,255,255,0.35)' };
function EventBar({ e, dayKey, weekStart, wrap, draggable, onOpen }) {
  const start = String(e.date_from).slice(0, 10);
  const end = String(e.date_to || e.date_from).slice(0, 10);
  const first = dayKey === start;
  const last = dayKey === end;
  const label = first || weekStart || wrap;
  const color = STATUS_COLOR[e.status] || '#64748b';
  // Work phases (2026-11-11): on a day a phase runs, the bar is that phase's colour (Assembling yellow,
  // Installation orange); two phases on one day split it top / bottom. A day with no phase keeps the
  // status colour.
  const today = e.ghost ? [] : (e.phases || []).filter((x) => dayKey >= x.date_from && dayKey <= x.date_to);
  // A day lost to a delay (bad weather, site not ready) is red and says DELAYED, over any phase colour.
  const lost = e.ghost ? null : (e.delays || []).find((x) => dayKey >= x.date_from && dayKey <= x.date_to);
  const fill = lost ? DELAY_RED : !today.length ? color
    : today.length === 1 ? today[0].color
      : `linear-gradient(to bottom, ${today.map((x, i) => `${x.color} ${(i * 100) / today.length}% ${((i + 1) * 100) / today.length}%`).join(', ')})`;
  const range = `${displayDate(start)}${end !== start ? ` – ${displayDate(end)}` : ''}`;
  const work = (today.length ? ` · ${today.map((x) => x.work_type).join(' + ')}` : '')
    + (lost ? ` · DELAYED: ${lost.work_type} not worked -- ${lost.reason}${lost.status === 'for_approval' ? ' (waiting for the SBU)' : ''}` : '');
  const lostText = lost ? `DELAYED${lost.status === 'for_approval' ? ' (for SBU)' : ''} · ${lost.reason}` : '';
  const startDrag = (ev, mode) => {
    ev.stopPropagation();
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', JSON.stringify({ id: e.id, mode, grab: dayKey }));
  };
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(ev) => ev.key === 'Enter' && onOpen()}
      draggable={draggable} onDragStart={(ev) => startDrag(ev, 'move')}
      title={e.ghost
        ? `Proposed: ${range} · ${e.pending_reason || ''} · waiting for the SBU -- click to open`
        : `${e.project_no} · ${e.title} (${STATUS_LABEL[e.status]}) · ${range}${work} · ${e.progress}%${e.pending_id ? ' · reschedule waiting for the SBU' : ''}${draggable ? ' · drag to reschedule' : ''}`}
      style={{
        position: 'relative',
        display: 'block', width: wrap ? '100%' : 'calc(100% + 8px)', margin: wrap ? '3px 0 0' : '3px -4px 0', textAlign: 'left',
        cursor: draggable ? 'grab' : 'pointer',
        background: e.ghost ? 'transparent' : fill, color: e.ghost ? color : today.length && !lost ? '#1f2937' : '#fff',
        border: e.ghost ? `1px dashed ${color}` : 'none',
        // the status stays readable on a phase-coloured bar: a stripe of its colour along the bottom
        boxShadow: today.length || lost ? `inset 0 -3px 0 ${color}` : 'none', fontSize: wrap ? 12 : 11, lineHeight: 1.35,
        padding: wrap ? '4px 8px' : '2px 6px', whiteSpace: wrap ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        // One fixed height per view: a continuation day carries no text (it collapsed to a thin line), and
        // bars of different heights would not line up across the week's lanes.
        height: wrap ? BAR_H_WEEK : BAR_H, boxSizing: 'border-box',
        borderRadius: wrap ? 4 : `${first ? 4 : 0}px ${last ? 4 : 0}px ${last ? 4 : 0}px ${first ? 4 : 0}px`,
        textDecoration: e.status === 'cancelled' ? 'line-through' : 'none',
        fontWeight: e.ghost ? 600 : 400, userSelect: 'none',
      }}>
      {draggable && first && <span draggable onDragStart={(ev) => startDrag(ev, 'start')} title="Drag to move the start" style={{ ...GRIP, left: 0 }} />}
      {draggable && last && <span draggable onDragStart={(ev) => startDrag(ev, 'end')} title="Drag to move the finish" style={{ ...GRIP, right: 0 }} />}
      {(() => {
        const text = label ? (e.ghost ? `⇄ Proposed: ${e.job_order_no || e.project_no}` : `${e.pending_id ? '⇄ ' : ''}${e.title} (${(STATUS_LABEL[e.status] || e.status).toUpperCase()})`) : '\u00a0';
        // the delayed day always says so, even mid-bar
        const shown = lost ? (label && !e.ghost ? `${lostText} · ${text}` : lostText) : text;
        return wrap ? <div style={{ ...CLAMP3, fontWeight: 600 }}>{shown}</div> : (lost ? <strong>{shown}</strong> : shown);
      })()}
      {wrap && !e.ghost && <div style={{ opacity: 0.9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.project_no}{e.job_order_no ? ` · ${e.job_order_no}` : ''} · {e.progress}%</div>}
    </div>
  );
}

// One day, installer by installer (asked 2026-11-09): a column per installer, a row per hour from
// 12:00 AM to 11:00 PM, each booking a block from its start to its end. A Job Order keeps one colour
// across every installer on it, so a crew on the same job reads as one band.
const HOUR_PX = 40;
const JOB_COLORS = ['#f4b183', '#00b0f0', '#a9d18e', '#ffd966', '#c9a0dc', '#f8a5a5', '#8fd3c7', '#b4c7e7'];
const minutesOf = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

// board (2026-11-13): the production-floor monitor (InstallationBoard.jsx) -- the grid fills the
// screen and a block opens nothing.
export function DayView({ dayKey, slots, people, kind, onOpen, board = false }) {
  const scroller = useRef(null);
  // Open on the working day (7 AM) rather than midnight.
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX; }, [dayKey]);

  const cols = new Map(people.map((p) => [p.key, { id: p.key, name: p.name, slots: [] }]));
  for (const s of slots) {
    if (String(s.work_date).slice(0, 10) !== dayKey) continue;
    const k = resourceKey(s);
    if (!cols.has(k)) cols.set(k, { id: k, name: resourceName(s), slots: [] });
    cols.get(k).slots.push(s);
  }
  const columns = [...cols.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!columns.length) return <div className="empty-state">{kind.none}</div>;

  // One colour per job (JO, else project), in the order the jobs first appear.
  const colorOf = new Map();
  for (const s of [...slots].sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time))) {
    const key = s.job_order_no || s.project_no;
    if (!colorOf.has(key)) colorOf.set(key, JOB_COLORS[colorOf.size % JOB_COLORS.length]);
  }
  const free = columns.filter((c) => !c.slots.length).length;
  // On the monitor (board) every column fits the screen -- no sideways scrolling -- so they share the width
  // with no minimum; in the planner each keeps 140px and the grid scrolls.
  const colMin = board ? 0 : 140;
  const grid = { display: 'grid', gridTemplateColumns: `${board ? 64 : 80}px repeat(${columns.length}, minmax(${colMin}px, 1fr))` };

  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {free} of {columns.length} {kind.plural.toLowerCase()} free all day{board ? '' : ' · click a block to open its project'}
      </div>
      <div className="table-wrap" ref={scroller} style={{ maxHeight: board ? 'calc(100vh - 110px)' : 620, overflow: 'auto' }}>
        <div style={{ minWidth: board ? 0 : 80 + columns.length * 140 }}>
          {/* Their names, kept in view while scrolling the hours */}
          <div style={{ ...grid, position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ padding: 6, fontWeight: 700, fontSize: 12 }}>{kind.plural}</div>
            {columns.map((c) => {
              const hrs = c.slots.reduce((n, s) => n + slotHours(s), 0);
              return (
                <div key={c.id} style={{ padding: 6, borderLeft: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', overflowWrap: 'anywhere' }}>{c.name}</div>
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
                    <button key={s.id} type="button" onClick={() => onOpen?.(s)}
                      title={`${s.work_type ? `${s.work_type} · ` : ''}${timeText(s.start_time)} – ${timeText(s.end_time)} · ${s.project_no} · ${s.project_title}${s.note ? ` · ${s.note}` : ''}`}
                      style={{
                        position: 'absolute', top, height, left: 3, right: 3, overflow: 'hidden', textAlign: 'left', cursor: board ? 'default' : 'pointer',
                        background: colorOf.get(s.job_order_no || s.project_no), color: '#1f2937', border: '1px solid rgba(0,0,0,0.15)',
                        borderRadius: 4, padding: '3px 6px', fontSize: 11, lineHeight: 1.3, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                      }}>
                      <span>
                        {s.work_type && (
                          <strong style={{ display: 'inline-block', fontSize: 11, marginBottom: 2, padding: '0 5px', borderRadius: 3, background: s.work_color, border: '1px solid rgba(0,0,0,0.2)' }}>{s.work_type}</strong>
                        )}
                        <span style={{ display: 'block' }}>{timeText(s.start_time)} – {timeText(s.end_time)}</span>
                      </span>
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

// The week of one kind -- installers, subcons, drivers or vehicles: EVERY one of them gets a row, booked
// or not, so who / what is free on a given day is plain to see; one column per day, each slot its hours
// and the project / JO.
function CrewView({ days, slots, people: everyone, kind, todayKey, onOpen, onDay }) {
  const people = new Map();
  for (const p of everyone) people.set(p.key, { id: p.key, name: p.name, byDay: new Map(), hours: 0 });
  for (const s of slots) {
    // Someone booked before they stopped being of this kind still shows, with their booking.
    const k0 = resourceKey(s);
    if (!people.has(k0)) people.set(k0, { id: k0, name: resourceName(s), byDay: new Map(), hours: 0 });
    const row = people.get(k0);
    const k = String(s.work_date).slice(0, 10);
    if (!row.byDay.has(k)) row.byDay.set(k, []);
    row.byDay.get(k).push(s);
    row.hours += slotHours(s);
  }
  const rows = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!rows.length) return <div className="empty-state">{kind.none}</div>;
  const freeOn = (k) => rows.filter((r) => !(r.byDay.get(k) || []).length).length;
  return (
    <div className="table-wrap">
      <table style={{ minWidth: 900, tableLayout: 'fixed', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ width: 170 }}>{kind.one}</th>
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
                        {s.work_type && <div style={{ marginTop: 2 }}><span style={{ background: s.work_color, color: '#1f2937', borderRadius: 3, padding: '0 4px', fontWeight: 600 }}>{s.work_type}</span></div>}
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

function ListView({ days, byDay, todayKey, onOpen, onWholeMonth }) {
  const withEvents = days.filter((d) => (byDay.get(ymd(d)) || []).some(Boolean));
  // One day, from "+N more": a way back to the whole month above the table.
  const back = onWholeMonth && (
    <div style={{ marginBottom: 8 }}>
      <button type="button" className="btn btn-sm" onClick={onWholeMonth}>‹ Whole month</button>
    </div>
  );
  if (!withEvents.length) return <>{back}<div className="empty-state">No projects scheduled {onWholeMonth ? 'on this day' : 'in this month'}.</div></>;
  return (
    <div className="table-wrap">
      {back}
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
              ...(byDay.get(k) || []).filter(Boolean).map((e) => (
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
