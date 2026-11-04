import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import Pagination from '../components/Pagination';
import { displayDate, displayMonth, displayAuditTime } from '../utils/dates';

// Design > Design Schedule (flow of 2026-11-03; server: routes/designSchedule.js). Sales -- Account
// Officers, their Supervisors, the SBU -- put their JO / NSTDJO on the calendar with a preferred artist;
// the SBU forwards every unsent slot to Design as one calendar; a Design Supervisor sets each slot's
// Layout Job Type + Qty, may revise its time or artist (the SBU approves revisions), and approving
// assigns every order to its artist. An approved slot not finished by the end of its day carries over
// to the top of today.
const ROUTE = '/design-schedule';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PHASE_BADGE = {
  Draft: 'badge-muted',
  'For Approval': 'badge-warning',
  Revised: 'badge-danger',
  Confirmed: 'badge-info',
  Assigned: 'badge-success',
  Done: 'badge-muted',
  Cancelled: 'badge-muted',
};
const PHASE_LABEL = {
  Draft: 'Draft - not sent',
  'For Approval': 'With Design',
  Revised: 'Revised - SBU to approve',
  Confirmed: 'Approved',
  Assigned: 'Artist assigned',
  Done: 'Layout done',
};

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// "2026-10-31 09:00:00" -> "9:00 am"
function timeOf(v) {
  const [h, m] = String(v).split(' ')[1].split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
const hhmm = (v) => String(v || '').split(' ')[1]?.slice(0, 5) || '';
const slotText = (start, end) => `${displayDate(String(start).slice(0, 10))}, ${timeOf(start)} - ${timeOf(end)}`;
// Several slots at the same date and time: which was booked first (same_time_count / booked_rank from the server).
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 >> 3 ^ 1 && n % 10] || 'th'}`;
const sharesTime = (e) => !e.ghost && Number(e.same_time_count) > 1;
const bookedText = (e) => (sharesTime(e) ? `booked ${ordinal(Number(e.booked_rank))} of ${Number(e.same_time_count)} at this time` : '');
const byBooking = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id;
const orderLink = (s) => (s.order_type === 'JO' ? `/job-orders/${s.order_id}` : `/non-standard-job-orders/${s.order_id}`);
const runLink = (s) => (s.order_type === 'JO' ? `/assigned-jo/${s.order_id}` : `/assigned-jo/nstdjo/${s.order_id}`);
const errorOf = (err) => err.response?.data?.error || err.message;
const artistLabel = (a) => (a ? `${a.first_name} ${a.last_name}` : '');

// A pending reschedule on an approved slot waits on the side that did not make it.
function awaitingMe(s, side) {
  if (s.status !== 'Confirmed' || !s.proposed_by_side) return false;
  if (side.both) return true;
  return s.proposed_by_side === 'DESIGN' ? side.sbu : side.design;
}

function ArtistPicker({ artists, value, onSelect }) {
  return (
    <EntityPicker
      label="Artist" items={artists} value={value || ''} getLabel={artistLabel}
      columns={[{ key: 'name', label: 'Name', render: artistLabel }, { key: 'position_title', label: 'Position' }]}
      searchKeys={['first_name', 'last_name']}
      onSelect={(a) => onSelect(a.id)}
    />
  );
}

export default function DesignSchedule() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [artistId, setArtistId] = useState('');
  const [events, setEvents] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(ymd(new Date()));
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const [forwarding, setForwarding] = useState(false);
  // Modals: { kind: 'new' | 'detail' | 'move' | 'day' | 'batch', ... }
  const [modal, setModal] = useState(null);

  // Month / Week / Day (asked 2026-11-03). Month is the 6-week grid of `month`; Week and Day follow the
  // selected day. The window fetched is exactly the days on screen.
  const [view, setView] = useState('month');
  const [search, setSearch] = useState('');
  let days;
  if (view === 'month') {
    const gridStart = new Date(month);
    gridStart.setDate(1 - month.getDay());
    days = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  } else {
    const [y, m, d] = selectedDay.split('-').map(Number);
    const first = view === 'week' ? new Date(y, m - 1, d - new Date(y, m - 1, d).getDay()) : new Date(y, m - 1, d);
    days = Array.from({ length: view === 'week' ? 7 : 1 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  }
  const from = ymd(days[0]);
  const to = ymd(days[days.length - 1]);

  // Moves the selected day, keeping the month in step with it.
  function goTo(k) {
    setSelectedDay(k);
    const [y, m] = k.split('-').map(Number);
    setMonth(new Date(y, m - 1, 1));
  }
  function step(n) {
    if (view === 'month') setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
    else goTo(shiftDay(selectedDay, view === 'week' ? 7 * n : n));
  }

  useEffect(() => {
    api.get(`${ROUTE}/meta`).then(({ data }) => setMeta(data));
    api.get(`${ROUTE}/batches`).then(({ data }) => setBatches(data));
  }, [reloadKey]);

  useEffect(() => {
    setLoading(true);
    api.get(ROUTE, { params: { from, to, artist_id: artistId || undefined } }).then(({ data }) => {
      setEvents(data);
      setLoading(false);
    });
  }, [from, to, artistId, reloadKey]);

  // Opened from a notification: /design-schedule?id=12 (a slot) or ?batch=3 (a calendar)
  useEffect(() => {
    const id = searchParams.get('id');
    const batch = searchParams.get('batch');
    if (id) setModal({ kind: 'detail', id });
    else if (batch) setModal({ kind: 'batch', id: batch });
  }, [searchParams]);

  function refresh() { setReloadKey((k) => k + 1); }
  function closeModal() {
    // A slot opened from the day view goes back to that day.
    setModal(modal?.back ? { kind: 'day', date: modal.back } : null);
    if (searchParams.get('id') || searchParams.get('batch')) setSearchParams({}, { replace: true });
  }

  async function forwardAll() {
    if (!window.confirm(`Forward all ${meta.unsent} unsent slot(s) to Design as one calendar?`)) return;
    setError('');
    setForwarding(true);
    try {
      const { data } = await api.post(`${ROUTE}/forward`);
      refresh();
      setModal({ kind: 'batch', id: data.id });
    } catch (err) {
      setError(errorOf(err));
    } finally { setForwarding(false); }
  }

  if (!meta) return <LoadingSpinner />;
  const { side } = meta;

  // Each slot on the day it shows (carried-over ones on today, first), plus a dashed ghost on the
  // day a pending reschedule / revision would move it to.
  // Search: order no., customer, artist, account officer, description, type or status -- across the
  // days on screen.
  const q = search.trim().toLowerCase();
  const shown = q
    ? events.filter((e) => [e.order_no, e.customer_name, e.artist_name, e.preferred_artist_name, e.sales_rep_name, e.description, e.order_type, PHASE_LABEL[e.phase] || e.phase]
      .some((v) => String(v || '').toLowerCase().includes(q)))
    : events;
  const byDay = new Map();
  const put = (k, e) => { if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); };
  for (const e of shown) {
    put(e.display_date, e);
    // A carried-over slot also stays on the day it was scheduled, marked Not done, for monitoring
    // (asked 2026-11-04) -- a copy: it cannot be dragged, and opens the same slot.
    if (e.carried_over_from) put(e.carried_over_from, { ...e, carried_over_from: null, missed: true });
    if (e.proposed_start) put(String(e.proposed_start).slice(0, 10), { ...e, ghost: true });
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (!!b.carried_over_from - !!a.carried_over_from)
      || String(a.ghost ? a.proposed_start : a.scheduled_start).slice(11).localeCompare(String(b.ghost ? b.proposed_start : b.scheduled_start).slice(11))
      || byBooking(a, b));
  }
  const todayKey = meta.today;

  // Which slots this user may drag to another day (the server checks whose they are).
  function canMove(e) {
    if (e.ghost || e.missed) return false;
    if (e.status === 'Draft') return side.sales;
    return e.status === 'Confirmed' && e.phase !== 'Done' && (side.sbu || side.design);
  }

  function onDrop(ev, date) {
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    const schedule = events.find((x) => String(x.id) === id);
    if (schedule && canMove(schedule)) setModal({ kind: 'move', schedule, date });
  }

  // Opens the day view. Stepping past the month shown turns the calendar too, so that day's slots load.
  function openDay(k) {
    goTo(k);
    setModal({ kind: 'day', date: k });
  }
  const title = view === 'month' ? displayMonth(month)
    : view === 'week' ? `${displayDate(from)} – ${displayDate(to)}`
      : `${WEEKDAYS[days[0].getDay()]}, ${displayDate(from)}`;

  // A Design Supervisor clicking a slot that is waiting on them gets its whole calendar -- that is where
  // the job types, revisions and the Approve / Send back buttons are.
  function openSlot(e, back) {
    if (side.design && e.status === 'For Approval' && e.batch_id) setModal({ kind: 'batch', id: e.batch_id });
    else setModal({ kind: 'detail', id: e.id, ...(back ? { back } : {}) });
  }

  const batchNeedsMe = (b) => (b.status === 'For Approval' && side.design) || (b.status === 'For SBU Approval' && side.sbu);
  const proposals = events.filter((e) => !e.ghost && awaitingMe(e, side));

  return (
    <div className="page">
      {/* Buttons beside the title, not at the far right: on a zoomed-in or narrow screen the right edge
          is the first thing cut off, and Arjie could not find "+ Schedule JO / NSTDJO" (2026-11-03). */}
      <div className="page-header" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <h1>Design Schedule</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {side.sales && (
            <button type="button" className="btn" onClick={() => setModal({ kind: 'new', date: selectedDay >= todayKey ? selectedDay : todayKey })}>
              + Schedule JO / NSTDJO
            </button>
          )}
          {side.sbu && (
            <button type="button" className="btn btn-primary" disabled={forwarding || !meta.unsent} onClick={forwardAll}
              title={meta.unsent ? '' : 'Nothing new on the calendar'}>
              Forward calendar to Design{meta.unsent ? ` (${meta.unsent})` : ''}
            </button>
          )}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {(batches.length > 0 || proposals.length > 0) && (
        <div className="card" style={{ marginBottom: 12 }}>
          {batches.length > 0 && <strong>Calendars in progress</strong>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {batches.map((b) => (
              <button key={b.id} type="button" className={`badge ${batchNeedsMe(b) ? 'badge-danger' : 'badge-warning'}`} style={{ border: 'none', cursor: 'pointer', padding: '6px 10px' }}
                onClick={() => setModal({ kind: 'batch', id: b.id })}>
                Calendar #{b.id} · {b.items.length} order(s) · {b.status === 'For Approval' ? 'with Design' : 'revised - SBU to approve'}
                {batchNeedsMe(b) ? ' · waiting on you' : ''}
              </button>
            ))}
            {proposals.map((e) => (
              <button key={e.id} type="button" className="badge badge-danger" style={{ border: 'none', cursor: 'pointer', padding: '6px 10px' }}
                onClick={() => setModal({ kind: 'detail', id: e.id })}>
                {e.order_no} · reschedule waiting on you
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => step(-1)}>‹</button>
          <h3 style={{ margin: 0, minWidth: 220, textAlign: 'center' }}>{title}</h3>
          <button type="button" className="btn btn-sm" onClick={() => step(1)}>›</button>
          <button type="button" className="btn btn-sm" onClick={() => goTo(todayKey)}>Today</button>
          <div style={{ display: 'flex', gap: 0 }}>
            {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([v, label]) => (
              <button key={v} type="button" className={`btn btn-sm ${view === v ? 'btn-primary' : ''}`} onClick={() => setView(v)}>{label}</button>
            ))}
          </div>
          <input type="search" placeholder="Search JO / NSTDJO, customer, artist, AO..." value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ flex: '1 1 220px', maxWidth: 320 }} />
          {q && <span className="muted" style={{ fontSize: 12 }}>{shown.length} match(es)</span>}
          {!side.artistEmployeeId && (
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              Artist calendar
              <select value={artistId} onChange={(e) => setArtistId(e.target.value)}>
                <option value="">All schedules</option>
                {meta.artists.map((a) => <option key={a.id} value={a.id}>{artistLabel(a)}</option>)}
              </select>
            </label>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, fontSize: 11 }}>
          {Object.keys(PHASE_BADGE).filter((p) => p !== 'Cancelled').map((p) => <span key={p} className={`badge ${PHASE_BADGE[p]}`}>{PHASE_LABEL[p] || p}</span>)}
          <span className="muted">↻ carried over · ✕ not done on its day · ⇄ change pending{side.sales || side.design ? ' · drag a slot to move it' : ''}</span>
        </div>
        {loading ? <LoadingSpinner /> : view === 'day' ? (
          <>
            {side.sales && from >= todayKey && (
              <div style={{ marginBottom: 8 }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setModal({ kind: 'new', date: from, start: '09:00' })}>+ Schedule on this day</button>
              </div>
            )}
            <DayTimeline list={byDay.get(from) || []} canSchedule={side.sales && from >= todayKey}
              onOpen={(e) => openSlot(e)} onNew={(start) => setModal({ kind: 'new', date: from, start })} />
          </>
        ) : view === 'week' ? (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(130px, 1fr))', gap: 1, background: 'var(--color-border)', minWidth: 910 }}>
              {days.map((d) => {
                const k = ymd(d);
                const list = byDay.get(k) || [];
                return (
                  <div key={k} onDragOver={(ev) => ev.preventDefault()} onDrop={(ev) => onDrop(ev, k)}
                    style={{ background: 'var(--color-surface)', minHeight: 380, padding: 6 }}>
                    <button type="button" onClick={() => openDay(k)} title="Open the day"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: k === todayKey ? 700 : 600, color: k === todayKey ? 'var(--color-primary)' : undefined }}>
                      {WEEKDAYS[d.getDay()]} {d.getDate()}
                    </button>
                    {list.map((e) => (
                      <button key={`${e.id}${e.ghost ? 'g' : ''}${e.missed ? 'm' : ''}`} type="button" draggable={canMove(e)}
                        onDragStart={(ev) => ev.dataTransfer.setData('text/plain', String(e.id))}
                        onClick={() => openSlot(e)} className={`badge ${PHASE_BADGE[e.phase]}`}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', marginTop: 4, padding: '4px 6px', whiteSpace: 'normal', fontSize: 11, lineHeight: 1.35,
                          cursor: canMove(e) ? 'grab' : 'pointer', border: e.ghost ? '1px dashed currentColor' : (e.missed ? '1px solid var(--danger, #b91c1c)' : 'none'), opacity: e.ghost ? 0.6 : 1,
                        }}>
                        {e.missed && <div style={{ fontWeight: 700, color: 'var(--danger, #b91c1c)' }}>✕ Not done -- carried over to {displayDate(e.display_date)}</div>}
                        <strong>{e.carried_over_from ? '↻ ' : ''}{timeOf(e.ghost ? e.proposed_start : e.scheduled_start)} - {timeOf(e.ghost ? e.proposed_end : e.scheduled_end)}</strong>
                        <div>{e.order_no} ({e.order_type})</div>
                        <div>{e.customer_name}</div>
                        {sharesTime(e) && <div style={{ fontWeight: 600 }}>{ordinal(Number(e.booked_rank))} booked · {e.created_by_name}</div>}
                        <div style={{ opacity: 0.8 }}>{(e.ghost && e.proposed_artist_name) || e.artist_name || 'no artist'} · {e.ghost ? 'proposed' : (PHASE_LABEL[e.phase] || e.phase)}</div>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(110px, 1fr))', gap: 1, background: 'var(--color-border)', minWidth: 770 }}>
              {WEEKDAYS.map((w) => <div key={w} style={{ background: 'var(--color-surface)', padding: 6, fontWeight: 600, fontSize: 12 }}>{w}</div>)}
              {days.map((d) => {
                const k = ymd(d);
                const list = byDay.get(k) || [];
                const inMonth = d.getMonth() === month.getMonth();
                const selected = k === selectedDay;
                return (
                  <div
                    key={k}
                    onClick={() => openDay(k)}
                    onDragOver={(ev) => ev.preventDefault()}
                    onDrop={(ev) => onDrop(ev, k)}
                    style={{
                      background: 'var(--color-surface)', minHeight: 104, padding: 4, opacity: inMonth ? 1 : 0.45, cursor: 'pointer',
                      outline: selected ? '2px solid var(--color-primary)' : 'none', outlineOffset: -2,
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: k === todayKey ? 700 : 400, color: k === todayKey ? 'var(--color-primary)' : undefined }}>{d.getDate()}</div>
                    {list.slice(0, 4).map((e) => (
                      <EventChip key={`${e.id}${e.ghost ? 'g' : ''}`} e={e} draggable={canMove(e)}
                        onOpen={() => openSlot(e)} />
                    ))}
                    {list.length > 4 && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>+{list.length - 4} more -- click the day</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {modal?.kind === 'day' && (
        <DayModal
          date={modal.date} list={byDay.get(modal.date) || []} canSchedule={side.sales && modal.date >= todayKey}
          onClose={closeModal} onStep={openDay}
          onOpen={(e) => openSlot(e, modal.date)}
          onNew={(start) => setModal({ kind: 'new', date: modal.date, start })}
        />
      )}
      {modal?.kind === 'new' && (
        <NewScheduleModal date={modal.date} start={modal.start} artists={meta.artists} onClose={closeModal} onSaved={() => { closeModal(); refresh(); }} />
      )}
      {modal?.kind === 'move' && (
        <MoveModal schedule={modal.schedule} date={modal.date} side={side} artists={meta.artists} onClose={closeModal} onSaved={() => { closeModal(); refresh(); }} />
      )}
      {modal?.kind === 'detail' && (
        <DetailModal id={modal.id} meta={meta} onClose={closeModal} onChanged={refresh}
          onMove={(schedule) => setModal({ kind: 'move', schedule, date: String(schedule.scheduled_start).slice(0, 10) })}
          onOpenBatch={(batchId) => setModal({ kind: 'batch', id: batchId })} />
      )}
      {modal?.kind === 'batch' && (
        <BatchModal id={modal.id} meta={meta} onClose={closeModal} onChanged={refresh} />
      )}
    </div>
  );
}

function EventChip({ e, draggable, onOpen }) {
  const start = e.ghost ? e.proposed_start : e.scheduled_start;
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(ev) => ev.dataTransfer.setData('text/plain', String(e.id))}
      onClick={(ev) => { ev.stopPropagation(); onOpen(); }}
      title={`${e.missed ? `NOT DONE -- carried over to ${displayDate(e.display_date)} · ` : ''}${e.order_no} · ${e.customer_name || ''} · ${PHASE_LABEL[e.phase] || e.phase}${e.artist_name ? ` · ${e.artist_name}` : ''}${e.carried_over_from ? ` · carried over from ${displayDate(e.carried_over_from)}` : ''}${sharesTime(e) ? ` · ${bookedText(e)} by ${e.created_by_name}` : ''}`}
      className={`badge ${PHASE_BADGE[e.phase]}`}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: draggable ? 'grab' : 'pointer', marginTop: 3,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11,
        border: e.ghost ? '1px dashed currentColor' : (e.missed ? '1px solid var(--danger, #b91c1c)' : 'none'), opacity: e.ghost ? 0.6 : 1,
        textDecoration: e.phase === 'Done' ? 'line-through' : 'none',
      }}
    >
      {e.missed && <strong style={{ color: 'var(--danger, #b91c1c)' }}>✕ Not done </strong>}{e.carried_over_from && '↻ '}{e.proposed_by_side && !e.ghost && '⇄ '}{sharesTime(e) && <strong>{ordinal(Number(e.booked_rank))} </strong>}{timeOf(start)} {e.order_no}
    </button>
  );
}

// One day, hour by hour: each slot drawn from its start to its end, side by side where they overlap.
// Carried-over slots sit in a strip above the timeline -- their times belong to the day they slipped from.
const HOUR_PX = 56;
const minutesOf = (v) => { const [h, m] = String(v).split(' ')[1].split(':').map(Number); return h * 60 + m; };
const shiftDay = (k, n) => { const [y, m, d] = k.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };

function DayModal({ date, list, canSchedule, onClose, onStep, onOpen, onNew }) {
  return (
    <Modal title={displayDate(date)} onClose={onClose} large>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <button type="button" className="btn btn-sm" onClick={() => onStep(shiftDay(date, -1))}>‹ Previous day</button>
        <button type="button" className="btn btn-sm" onClick={() => onStep(shiftDay(date, 1))}>Next day ›</button>
        <span className="muted" style={{ fontSize: 12 }}>{list.length} scheduled</span>
        {canSchedule && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => onNew('09:00')}>+ Schedule on this day</button>}
      </div>
      <DayTimeline list={list} canSchedule={canSchedule} onOpen={onOpen} onNew={onNew} />
    </Modal>
  );
}

// The hour-by-hour body of a day: in the day popup, and inline as the calendar's Day view.
function DayTimeline({ list, canSchedule, onOpen, onNew }) {
  const carried = list.filter((e) => e.carried_over_from);
  const timed = list.filter((e) => !e.carried_over_from).map((e) => ({
    e,
    s: minutesOf(e.ghost ? e.proposed_start : e.scheduled_start),
    f: minutesOf(e.ghost ? e.proposed_end : e.scheduled_end),
  })).sort((a, b) => a.s - b.s || a.f - b.f || byBooking(a.e, b.e));

  // Columns per overlapping cluster: each slot takes the first column free at its start, and every
  // slot in a cluster shares the cluster's column count so they line up.
  let cluster = [];
  let clusterEnd = -1;
  let cols = [];
  const flush = () => { cluster.forEach((x) => { x.n = cols.length; }); cluster = []; cols = []; };
  for (const x of timed) {
    if (x.s >= clusterEnd) { flush(); clusterEnd = -1; }
    let c = cols.findIndex((end) => end <= x.s);
    if (c === -1) { c = cols.length; cols.push(0); }
    cols[c] = Math.max(x.f, x.s + 15);
    x.col = c;
    cluster.push(x);
    clusterEnd = Math.max(clusterEnd, cols[c]);
  }
  flush();

  // Office hours by default, widened to whatever is actually booked.
  const firstHour = Math.min(7, ...timed.map((x) => Math.floor(x.s / 60)));
  const lastHour = Math.max(19, ...timed.map((x) => Math.ceil(x.f / 60)));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;

  return (
    <>
      {carried.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>↻ Carried over -- not finished on the day scheduled</div>
          {carried.map((e) => (
            <button key={e.id} type="button" onClick={() => onOpen(e)} className={`badge ${PHASE_BADGE[e.phase]}`}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', marginTop: 3, padding: '6px 8px' }}>
              <strong>{e.order_no}</strong> ({e.order_type}) · {e.customer_name} · {e.artist_name || 'no artist yet'}
              <span style={{ float: 'right' }}>from {displayDate(e.carried_over_from)}, {timeOf(e.scheduled_start)} - {timeOf(e.scheduled_end)}</span>
            </button>
          ))}
        </div>
      )}

      <div style={{ maxHeight: '60vh', overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 6 }}>
        <div style={{ position: 'relative', height: hours.length * HOUR_PX }}>
          {hours.map((h, i) => (
            <div key={h} onClick={() => canSchedule && onNew(`${String(h).padStart(2, '0')}:00`)}
              title={canSchedule ? `Schedule at ${hourLabel(h)}` : undefined}
              style={{
                position: 'absolute', top: i * HOUR_PX, left: 0, right: 0, height: HOUR_PX,
                borderTop: i ? '1px solid var(--color-border)' : 'none', cursor: canSchedule ? 'copy' : 'default',
              }}>
              <span className="muted" style={{ fontSize: 11, position: 'absolute', left: 6, top: 2 }}>{hourLabel(h)}</span>
            </div>
          ))}
          {timed.map(({ e, s, f, col, n }) => {
            const top = ((s - firstHour * 60) / 60) * HOUR_PX;
            const height = Math.max(((f - s) / 60) * HOUR_PX, 26);
            return (
              <button key={`${e.id}${e.ghost ? 'g' : ''}${e.missed ? 'm' : ''}`} type="button" onClick={() => onOpen(e)}
                className={`badge ${PHASE_BADGE[e.phase]}`}
                title={e.description || ''}
                style={{
                  position: 'absolute', top: top + 1, height: height - 2,
                  left: `calc(56px + (100% - 62px) * ${col / n})`, width: `calc((100% - 62px) / ${n} - 4px)`,
                  textAlign: 'left', cursor: 'pointer', overflow: 'hidden', padding: '3px 6px', fontSize: 12, lineHeight: 1.3,
                  border: e.ghost ? '1px dashed currentColor' : (e.missed ? '1px solid var(--danger, #b91c1c)' : '1px solid rgba(0,0,0,0.08)'), opacity: e.ghost ? 0.6 : 1,
                  display: 'block', whiteSpace: 'normal',
                }}>
                {e.missed && <div style={{ fontWeight: 700, color: 'var(--danger, #b91c1c)' }}>✕ Not done -- carried over to {displayDate(e.display_date)}</div>}
                <div><strong>{timeOf(e.ghost ? e.proposed_start : e.scheduled_start)} - {timeOf(e.ghost ? e.proposed_end : e.scheduled_end)}</strong> · {e.order_no} <span style={{ opacity: 0.7 }}>({e.order_type})</span></div>
                <div>{e.customer_name}{e.artist_name ? ` · ${e.ghost && e.proposed_artist_name ? e.proposed_artist_name : e.artist_name}` : ''}{e.delivery_date ? ` · Delivery ${displayDate(e.delivery_date)}` : ''}</div>
                <div style={{ opacity: 0.8 }}>
                  {e.ghost ? '⇄ proposed new time' : (PHASE_LABEL[e.phase] || e.phase)}{!e.ghost && e.proposed_by_side ? ' · ⇄ change pending' : ''}
                  {e.sales_rep_name ? ` · ${e.sales_rep_name}` : ''}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      {list.length === 0 && <p className="muted" style={{ marginTop: 8 }}>Nothing scheduled{canSchedule ? ' -- click an hour to schedule a JO / NSTDJO there.' : '.'}</p>}
    </>
  );
}

// Several orders at once (asked 2026-11-03): tick the JOs / NSTDJOs, and each becomes its own slot at the
// same date, time and artist. Each keeps its own order's delivery date unless one order is picked and
// the date is changed. One request per order, so one refusal does not stop the rest.
const ORDERS_PER_PAGE = 10;

function NewScheduleModal({ date, start = '09:00', artists, onClose, onSaved }) {
  const [orderType, setOrderType] = useState('JO');
  const [orders, setOrders] = useState(null);
  const [picked, setPicked] = useState([]); // order rows
  const [find, setFind] = useState('');
  const [page, setPage] = useState(1);
  // Multiple off: one order at a time. On: search an order number first, then tick (asked 2026-11-03).
  const [multiple, setMultiple] = useState(false);
  const endDefault = `${String(Math.min(23, Number(start.slice(0, 2)) + 3)).padStart(2, '0')}:${start.slice(3, 5)}`;
  const [form, setForm] = useState({ date, start, end: endDefault, notes: '', delivery_date: '', preferred_artist_id: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOrders(null);
    setPicked([]);
    setPage(1);
    api.get(`${ROUTE}/eligible`, { params: { type: orderType } }).then(({ data }) => setOrders(data));
  }, [orderType]);

  const q = find.trim().toLowerCase();
  const matches = multiple && !q ? [] : (orders || []).filter((o) => !q || [o.order_no, o.customer_name, o.description, o.sub_status]
    .some((v) => String(v || '').toLowerCase().includes(q)));
  const totalPages = Math.max(1, Math.ceil(matches.length / ORDERS_PER_PAGE));
  const pageRows = matches.slice((page - 1) * ORDERS_PER_PAGE, page * ORDERS_PER_PAGE);
  const isPicked = (o) => picked.some((p) => p.id === o.id);
  // One order: its delivery date, changeable. Several: each keeps its own.
  function pick(next) {
    setPicked(next);
    setForm((f) => ({ ...f, delivery_date: next.length === 1 && next[0].delivery_date ? String(next[0].delivery_date).slice(0, 10) : '' }));
  }
  const toggle = (o) => {
    if (!multiple) pick(isPicked(o) ? [] : [o]);
    else pick(isPicked(o) ? picked.filter((p) => p.id !== o.id) : [...picked, o]);
  };
  function setMultipleMode(on) {
    setMultiple(on);
    setPage(1);
    if (!on && picked.length > 1) pick(picked.slice(0, 1));
  }
  const allOnPage = pageRows.length > 0 && pageRows.every(isPicked);
  const togglePage = () => pick(allOnPage
    ? picked.filter((p) => !pageRows.some((o) => o.id === p.id))
    : [...picked, ...pageRows.filter((o) => !isPicked(o))]);

  async function save() {
    setError('');
    if (!picked.length) { setError('Tick at least one order to schedule.'); return; }
    if (!form.preferred_artist_id) { setError('Choose the preferred artist.'); return; }
    setSaving(true);
    const failed = [];
    for (const o of picked) {
      try {
        await api.post(ROUTE, {
          order_type: orderType, order_id: o.id, notes: form.notes, preferred_artist_id: form.preferred_artist_id,
          delivery_date: picked.length === 1 ? (form.delivery_date || null) : (o.delivery_date ? String(o.delivery_date).slice(0, 10) : null),
          scheduled_start: `${form.date}T${form.start}`, scheduled_end: `${form.date}T${form.end}`,
        });
      } catch (err) {
        failed.push({ o, msg: errorOf(err) });
      }
    }
    setSaving(false);
    if (!failed.length) { onSaved(); return; }
    // Keep only the ones that did not go in, so Save can be pressed again for them.
    setPicked(failed.map((x) => x.o));
    setError(`${picked.length - failed.length} scheduled, ${failed.length} not: ${failed.map((x) => `${x.o.order_no}: ${x.msg}`).join(' · ')}`);
  }

  return (
    <Modal title="Schedule for Design" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ minWidth: 240 }}>
          <label>Type</label>
          <select value={orderType} onChange={(e) => setOrderType(e.target.value)}>
            <option value="JO">Job Order (JO)</option>
            <option value="NSTDJO">Non-Standard Job Order (NSTDJO)</option>
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label>Search</label>
          <input type="search" placeholder={multiple ? 'Type the JO / NSTDJO number...' : 'No., customer, description...'} value={find} onChange={(e) => { setFind(e.target.value); setPage(1); }} />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 10, fontWeight: 600, color: 'var(--color-text)' }}>
          <input type="checkbox" checked={multiple} onChange={(e) => setMultipleMode(e.target.checked)} /> Multiple
        </label>
        {multiple ? 'Search a JO / NSTDJO number, tick it, then search the next.' : 'Pick one order -- tick Multiple to schedule several.'}
        {picked.length > 0 && <strong style={{ marginLeft: 8, color: 'var(--color-primary)' }}>{picked.length} selected</strong>}
        {picked.length > 0 && <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => pick([])}>Clear</button>}
      </div>
      {multiple && picked.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {picked.map((o) => (
            <span key={o.id} className="badge badge-info" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {o.order_no}
              <button type="button" onClick={() => toggle(o)} title="Remove" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      {orders === null ? <LoadingSpinner /> : (
        <div style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>{multiple && q && <input type="checkbox" checked={allOnPage} onChange={togglePage} title="Tick every order found" />}</th>
                <th>No.</th><th>Customer</th><th>Description</th><th>Sub Status</th><th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                  {multiple && !q ? 'Search a JO / NSTDJO number to find the orders to tick.' : 'No orders to schedule.'}
                </td></tr>
              )}
              {pageRows.map((o) => (
                <tr key={o.id} onClick={() => toggle(o)} style={{ cursor: 'pointer', background: isPicked(o) ? 'rgba(99, 102, 241, 0.08)' : undefined }}>
                  <td><input type={multiple ? 'checkbox' : 'radio'} checked={isPicked(o)} onChange={() => toggle(o)} onClick={(e) => e.stopPropagation()} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{o.order_no}</td>
                  <td>{o.customer_name}</td>
                  <td>{String(o.description || '').slice(0, 70)}</td>
                  <td>{o.sub_status}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{displayDate(o.delivery_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
        <div className="field">
          <label>Preferred Artist *</label>
          <ArtistPicker artists={artists} value={form.preferred_artist_id} onSelect={(id) => setForm({ ...form, preferred_artist_id: id })} />
        </div>
        <div className="field">
          <label>Delivery Date</label>
          {picked.length > 1 ? (
            <input readOnly tabIndex={-1} value="Each order keeps its own delivery date" />
          ) : (
            <input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} />
          )}
          {picked.length === 1 && form.delivery_date && form.date && form.date > form.delivery_date && (
            <div className="badge-warning" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, marginTop: 4 }}>
              The design slot is after the delivery date.
            </div>
          )}
        </div>
      </div>
      <SlotFields form={form} setForm={setForm} />
      <div className="field">
        <label>Notes for Design</label>
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Saved to the calendar as drafts. The SBU forwards the whole calendar to Design.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" disabled={saving || !picked.length} onClick={save}>
          {saving ? 'Saving...' : picked.length > 1 ? `Save ${picked.length} schedules` : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function SlotFields({ form, setForm }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
      <div className="field"><label>Date</label><input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
      <div className="field"><label>Start</label><input type="time" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></div>
      <div className="field"><label>End</label><input type="time" required value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></div>
    </div>
  );
}

// Moving a slot: a plain edit while it is a draft (time, artist, delivery date), a reschedule proposal
// once approved.
function MoveModal({ schedule, date, side, artists, onClose, onSaved }) {
  const confirmed = schedule.status === 'Confirmed';
  const [form, setForm] = useState({
    date, start: hhmm(schedule.scheduled_start), end: hhmm(schedule.scheduled_end), note: '',
    delivery_date: schedule.delivery_date ? String(schedule.delivery_date).slice(0, 10) : '',
    preferred_artist_id: schedule.preferred_artist_id || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const other = side.both ? null : (side.design ? 'the SBU' : 'the Design Supervisor');

  async function save() {
    setError('');
    setSaving(true);
    const body = { scheduled_start: `${form.date}T${form.start}`, scheduled_end: `${form.date}T${form.end}` };
    try {
      if (confirmed) await api.post(`${ROUTE}/${schedule.id}/reschedule`, { ...body, note: form.note });
      else {
        await api.put(`${ROUTE}/${schedule.id}`, {
          ...body, notes: schedule.notes, delivery_date: form.delivery_date || null, preferred_artist_id: form.preferred_artist_id,
        });
      }
      onSaved();
    } catch (err) {
      setError(errorOf(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={`${confirmed ? 'Reschedule' : 'Edit'} ${schedule.order_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted">Currently {slotText(schedule.scheduled_start, schedule.scheduled_end)}.</p>
      {confirmed && other && (
        <p>This slot is approved, so the new time goes to {other} to accept. Until then it stays where it is.</p>
      )}
      {!confirmed && (
        <>
          <div className="field">
            <label>Preferred Artist</label>
            <ArtistPicker artists={artists} value={form.preferred_artist_id} onSelect={(id) => setForm({ ...form, preferred_artist_id: id })} />
          </div>
          <div className="field">
            <label>Delivery Date</label>
            <input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} />
          </div>
        </>
      )}
      <SlotFields form={form} setForm={setForm} />
      {confirmed && (
        <div className="field">
          <label>Reason</label>
          <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
          {confirmed && other ? 'Send for confirmation' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function DetailModal({ id, meta, onClose, onChanged, onMove, onOpenBatch }) {
  const { side } = meta;
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  function load() {
    api.get(`${ROUTE}/${id}`).then(({ data }) => setS(data)).catch((err) => setError(errorOf(err)));
  }
  useEffect(load, [id]);

  async function act(path, body) {
    setError('');
    setBusy(true);
    try {
      await api.post(`${ROUTE}/${id}/${path}`, body);
      setRejecting(false);
      setReason('');
      onChanged();
      load();
    } catch (err) {
      setError(errorOf(err));
    } finally { setBusy(false); }
  }

  if (!s) {
    return <Modal title="Design Schedule" onClose={onClose}>{error ? <div className="error-banner">{error}</div> : <LoadingSpinner />}</Modal>;
  }

  const movable = s.status === 'Confirmed' && s.phase !== 'Done';
  const mineProposal = s.status === 'Confirmed' && s.proposed_by_side && !side.both
    && ((s.proposed_by_side === 'DESIGN' && side.design) || (s.proposed_by_side === 'SBU' && side.sbu));

  return (
    <Modal title={`${s.order_no} · Design Schedule`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px' }}>
        <div>Order : <Link to={orderLink(s)} className="hi">{s.order_no}</Link> <span className="muted">({s.order_type})</span></div>
        <div>Status : <span className={`badge ${PHASE_BADGE[s.phase]}`}>{PHASE_LABEL[s.phase] || s.phase}</span></div>
        <div>Customer : <span className="hi">{s.customer_name}</span></div>
        <div>Schedule : <span className="hi">{slotText(s.scheduled_start, s.scheduled_end)}</span></div>
        <div>Account Officer : <span className="hi">{s.sales_rep_name || '--'}</span></div>
        <div>Delivery Date : <span className="hi">{s.delivery_date ? displayDate(s.delivery_date) : '--'}</span></div>
        <div>Preferred Artist : <span className="hi">{s.preferred_artist_name || '--'}</span></div>
        <div>Assigned Artist : <span className="hi">{s.assigned_artist_name || '--'}</span></div>
        <div>Layout - Job Type : <span className="hi">{s.plan_layout_job_type_name ? `${s.plan_layout_job_type_name} × ${Number(s.plan_layout_qty || 0)}` : '--'}</span></div>
        <div>Order Sub Status : <span className="hi">{s.order_sub_status}</span></div>
        <div>Scheduled by : <span className="hi">{s.created_by_name} · {displayAuditTime(s.created_at)}</span></div>
        {sharesTime(s) && <div>Booking order : <span className="hi">{ordinal(Number(s.booked_rank))} of {Number(s.same_time_count)} at this date and time</span></div>}
        <div>Approved by : <span className="hi">{s.confirmed_by_name || '--'}</span></div>
      </div>
      {s.description && <p style={{ whiteSpace: 'pre-wrap' }}>{s.description}</p>}
      {s.notes && <p><strong>Notes:</strong> {s.notes}</p>}
      {s.carried_over_from && (
        <div className="badge-warning" style={{ padding: '8px 12px', borderRadius: 6, margin: '8px 0' }}>
          ↻ Not finished on {displayDate(s.carried_over_from)} -- carried over to today, and it moves to the next day each day until the layout is done.
        </div>
      )}
      {s.proposed_by_side && (
        <div className="card" style={{ margin: '8px 0' }}>
          ⇄ <strong>{s.proposed_by_name}</strong> ({s.proposed_by_side === 'DESIGN' ? 'Design' : 'SBU'}) proposed{' '}
          <strong>{slotText(s.proposed_start, s.proposed_end)}</strong>
          {s.proposed_artist_name && <> with <strong>{s.proposed_artist_name}</strong></>}
          {s.proposal_note && <div className="muted">Reason: {s.proposal_note}</div>}
          <div className="muted">Waiting on {s.proposed_by_side === 'DESIGN' ? 'the SBU' : 'the Design Supervisor'}.</div>
        </div>
      )}

      {rejecting ? (
        <div className="field">
          <label>Reason (optional)</label>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setRejecting(false)}>Back</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('proposal/reject', { reason })}>Reject new time</button>
          </div>
        </div>
      ) : (
        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          {side.sales && s.status === 'Draft' && <button type="button" className="btn" onClick={() => onMove(s)}>Edit</button>}
          {s.status !== 'Cancelled' && !['Assigned', 'Done'].includes(s.phase) && (s.status === 'Draft' ? side.sales : side.sbu) && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => window.confirm('Take this slot off the calendar?') && act('cancel')}>Cancel slot</button>
          )}
          {s.batch_id && s.status === 'For Approval' && (
            <button type="button" className="btn btn-primary" onClick={() => onOpenBatch(s.batch_id)}>Open calendar #{s.batch_id}</button>
          )}
          {(side.sbu || side.design) && movable && !s.proposed_by_side && (
            <button type="button" className="btn" onClick={() => onMove(s)}>Reschedule</button>
          )}
          {awaitingMe(s, side) && (
            <>
              <button type="button" className="btn btn-danger" onClick={() => setRejecting(true)}>Reject new time</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('proposal/accept')}>Accept new time</button>
            </>
          )}
          {mineProposal && <button type="button" className="btn" disabled={busy} onClick={() => act('proposal/withdraw')}>Withdraw proposal</button>}
          {side.artistEmployeeId && s.phase === 'Assigned' && <Link className="btn btn-primary" to={runLink(s)}>Open layout timer</Link>}
        </div>
      )}

      {s.history?.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>History</summary>
          <table>
            <thead><tr><th>When</th><th>By</th><th>Field</th><th>From</th><th>To</th></tr></thead>
            <tbody>
              {s.history.map((h, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <tr key={i}><td>{displayAuditTime(h.set_at)}</td><td>{h.set_by_name}</td><td>{h.field_name}</td><td>{h.old_value}</td><td>{h.new_value}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Modal>
  );
}

// One forwarded calendar. Design sets each slot's Layout Job Type + Qty and may revise its time or
// artist, then approves; with revisions it goes to the SBU, who approves them or returns the calendar.
function BatchModal({ id, meta, onClose, onChanged }) {
  const { side } = meta;
  const [batch, setBatch] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revising, setRevising] = useState(null); // the slot being revised
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');

  function load() {
    api.get(`${ROUTE}/batches/${id}`).then(({ data }) => setBatch(data)).catch((err) => setError(errorOf(err)));
  }
  useEffect(load, [id]);

  async function call(method, path, body) {
    setError('');
    setBusy(true);
    try {
      await api[method](`${ROUTE}${path}`, body);
      onChanged();
      load();
      return true;
    } catch (err) {
      setError(errorOf(err));
      return false;
    } finally { setBusy(false); }
  }

  if (!batch) {
    return <Modal title="Design calendar" onClose={onClose}>{error ? <div className="error-banner">{error}</div> : <LoadingSpinner />}</Modal>;
  }

  const reviewing = side.design && batch.status === 'For Approval';
  const answering = side.sbu && batch.status === 'For SBU Approval';
  const revisedCount = batch.items.filter((s) => s.proposed_by_side === 'DESIGN').length;
  const jobTypesFor = (s) => (s.order_type === 'NSTDJO'
    ? meta.pmsJobTypes.filter((p) => String(p.job_type_id) === String(s.nstdjo_job_type_id))
    : meta.pmsJobTypes);
  const saveLayout = (s, patch) => call('put', `/${s.id}/layout`, {
    layout_job_type_id: s.plan_layout_job_type_id || null, layout_qty: s.plan_layout_qty || null, ...patch,
  });

  return (
    <Modal title={`Design calendar #${batch.id}`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        Forwarded by {batch.forwarded_by_name} on {displayAuditTime(batch.forwarded_at)} · {batch.items.length} order(s) ·{' '}
        <strong>{batch.status === 'For Approval' ? 'With Design' : batch.status === 'For SBU Approval' ? 'Revised - waiting on the SBU' : batch.status}</strong>
        {batch.approved_by_name && ` · approved by ${batch.approved_by_name}`}
      </p>
      {batch.return_note && batch.status === 'For Approval' && <div className="error-banner">Returned by the SBU: {batch.return_note}</div>}
      {reviewing && (
        <p style={{ fontSize: 13 }}>
          Set each order&apos;s Layout - Job Type and Qty, then <strong>Approve</strong> the calendar as it is -- or <strong>Revise</strong> a
          slot&apos;s time or artist and <strong>Send it back to the SBU</strong> to approve the revisions.
        </p>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr><th>Order</th><th>Customer / AO</th><th>Schedule</th><th>Artist</th><th>Layout - Job Type</th><th>Qty</th><th>Revision</th></tr>
          </thead>
          <tbody>
            {batch.items.map((s) => (
              <tr key={s.id}>
                <td><Link to={orderLink(s)}>{s.order_no}</Link> <span className="muted">({s.order_type})</span></td>
                <td>{s.customer_name}<div className="muted" style={{ fontSize: 12 }}>{s.sales_rep_name}</div></td>
                <td style={{ whiteSpace: 'nowrap' }}>{slotText(s.scheduled_start, s.scheduled_end)}
                  <div className="muted" style={{ fontSize: 12, fontWeight: sharesTime(s) ? 600 : undefined }}>
                    {sharesTime(s) ? `${ordinal(Number(s.booked_rank))} of ${Number(s.same_time_count)} booked · ` : 'Booked '}by {s.created_by_name}, {displayAuditTime(s.created_at)}
                  </div>
                </td>
                <td>{s.assigned_artist_name || s.preferred_artist_name}</td>
                <td style={{ minWidth: 200 }}>
                  {reviewing ? (
                    <select value={s.plan_layout_job_type_id || ''} disabled={busy} onChange={(e) => saveLayout(s, { layout_job_type_id: e.target.value || null })}>
                      <option value="">-- choose --</option>
                      {jobTypesFor(s).map((p) => <option key={p.id} value={p.id}>{p.display_name} ({p.minutes_consume} min)</option>)}
                    </select>
                  ) : (s.plan_layout_job_type_name || '--')}
                </td>
                <td>
                  {reviewing ? (
                    <input type="number" min="0.0001" step="any" style={{ width: 70 }} defaultValue={s.plan_layout_qty ? Number(s.plan_layout_qty) : ''}
                      onBlur={(e) => { if (String(Number(e.target.value || 0)) !== String(Number(s.plan_layout_qty || 0))) saveLayout(s, { layout_qty: e.target.value || null }); }} />
                  ) : (s.plan_layout_qty ? Number(s.plan_layout_qty) : '--')}
                </td>
                <td style={{ minWidth: 180 }}>
                  {s.proposed_by_side === 'DESIGN' ? (
                    <span className="badge badge-danger" style={{ whiteSpace: 'normal' }}>
                      ⇄ {slotText(s.proposed_start, s.proposed_end)}{s.proposed_artist_name ? ` · ${s.proposed_artist_name}` : ''}
                      {s.proposal_note && <div style={{ opacity: 0.8 }}>{s.proposal_note}</div>}
                    </span>
                  ) : <span className="muted">--</span>}
                  {reviewing && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                      <button type="button" className="btn btn-sm" onClick={() => setRevising(s)}>Revise</button>
                      {s.proposed_by_side === 'DESIGN' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => call('post', `/${s.id}/revise/withdraw`)}>Undo</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {revising && (
        <ReviseForm s={revising} artists={meta.artists} busy={busy} onCancel={() => setRevising(null)}
          onSave={async (body) => { if (await call('post', `/${revising.id}/revise`, body)) setRevising(null); }} />
      )}

      {returning ? (
        <div className="field" style={{ marginTop: 12 }}>
          <label>Why are the revisions not approved? (required)</label>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setReturning(false)}>Back</button>
            <button type="button" className="btn btn-danger" disabled={busy}
              onClick={async () => { if (await call('post', `/batches/${batch.id}/return`, { note })) { setReturning(false); setNote(''); } }}>Return to Design</button>
          </div>
        </div>
      ) : (
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {reviewing && (
            <>
              <button type="button" className="btn btn-warning" disabled={busy || !revisedCount}
                title={revisedCount ? '' : "Revise a slot's time or artist first"}
                onClick={() => call('post', `/batches/${batch.id}/send-back`)}>
                Send revised calendar back to SBU{revisedCount ? ` (${revisedCount})` : ''}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || revisedCount > 0}
                title={revisedCount ? 'Revisions go to the SBU first -- or undo them to approve as it is' : ''}
                onClick={() => call('post', `/batches/${batch.id}/approve`)}>
                Approve calendar &amp; assign artists
              </button>
            </>
          )}
          {answering && (
            <>
              <button type="button" className="btn btn-danger" onClick={() => setReturning(true)}>Return to Design</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => call('post', `/batches/${batch.id}/accept`)}>
                Approve revisions & assign artists
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function ReviseForm({ s, artists, busy, onCancel, onSave }) {
  const [form, setForm] = useState({
    date: String(s.proposed_start || s.scheduled_start).slice(0, 10),
    start: hhmm(s.proposed_start || s.scheduled_start), end: hhmm(s.proposed_end || s.scheduled_end),
    preferred_artist_id: s.proposed_artist_id || s.preferred_artist_id, note: s.proposal_note || '',
  });
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Revise {s.order_no}</h3>
      <div className="field">
        <label>Artist</label>
        <ArtistPicker artists={artists} value={form.preferred_artist_id} onSelect={(id) => setForm({ ...form, preferred_artist_id: id })} />
      </div>
      <SlotFields form={form} setForm={setForm} />
      <div className="field">
        <label>Reason</label>
        <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>Back</button>
        <button type="button" className="btn btn-primary" disabled={busy}
          onClick={() => onSave({
            scheduled_start: `${form.date}T${form.start}`, scheduled_end: `${form.date}T${form.end}`,
            preferred_artist_id: form.preferred_artist_id, note: form.note,
          })}>Save revision</button>
      </div>
    </div>
  );
}
