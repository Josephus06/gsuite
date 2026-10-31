import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate, displayMonth, displayAuditTime } from '../utils/dates';

// Design > Design Schedule (2026-10-31). The SBU puts a JO / NSTDJO on the calendar and forwards it;
// a Design Supervisor confirms or rejects it, then assigns the artist through the same endpoints the
// order screens use. A confirmed slot moved by one side waits for the other side to accept it. A
// confirmed slot not finished by the end of its day carries over to the top of today (server-side:
// routes/designSchedule.js decorate()).
const ROUTE = '/design-schedule';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PHASE_BADGE = {
  Draft: 'badge-muted',
  'For Confirmation': 'badge-warning',
  Rejected: 'badge-danger',
  Confirmed: 'badge-info',
  Assigned: 'badge-success',
  Done: 'badge-muted',
  Cancelled: 'badge-muted',
};
const PHASE_LABEL = {
  Confirmed: 'Confirmed - needs artist',
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
const orderLink = (s) => (s.order_type === 'JO' ? `/job-orders/${s.order_id}` : `/non-standard-job-orders/${s.order_id}`);
const runLink = (s) => (s.order_type === 'JO' ? `/assigned-jo/${s.order_id}` : `/assigned-jo/nstdjo/${s.order_id}`);
const errorOf = (err) => err.response?.data?.error || err.message;

// A pending proposal waits on the side that did not make it. An account on both sides answers anything.
function awaitingMe(s, side) {
  if (!s.proposed_by_side) return false;
  if (side.both) return true;
  return s.proposed_by_side === 'DESIGN' ? side.sbu : side.design;
}

export default function DesignSchedule() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [artistId, setArtistId] = useState('');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(ymd(new Date()));
  const [reloadKey, setReloadKey] = useState(0);
  // Modals: { kind: 'new', date } | { kind: 'detail', id } | { kind: 'move', schedule, date }
  const [modal, setModal] = useState(null);

  const gridStart = new Date(month);
  gridStart.setDate(1 - month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  const from = ymd(days[0]);
  const to = ymd(days[41]);

  useEffect(() => { api.get(`${ROUTE}/meta`).then(({ data }) => setMeta(data)); }, []);

  useEffect(() => {
    setLoading(true);
    api.get(ROUTE, { params: { from, to, artist_id: artistId || undefined } }).then(({ data }) => {
      setEvents(data);
      setLoading(false);
    });
  }, [from, to, artistId, reloadKey]);

  // Opened from a notification: /design-schedule?id=12
  useEffect(() => {
    const id = searchParams.get('id');
    if (id) setModal({ kind: 'detail', id });
  }, [searchParams]);

  function refresh() { setReloadKey((k) => k + 1); }
  function closeModal() {
    // A slot opened from the day view goes back to that day.
    setModal(modal?.back ? { kind: 'day', date: modal.back } : null);
    if (searchParams.get('id')) setSearchParams({}, { replace: true });
  }

  if (!meta) return <LoadingSpinner />;
  const { side } = meta;

  // Each slot on the day it shows (carried-over ones on today, first), plus a dashed ghost on the
  // day a pending reschedule would move it to.
  const byDay = new Map();
  const put = (k, e) => { if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); };
  for (const e of events) {
    put(e.display_date, e);
    if (e.proposed_start) put(String(e.proposed_start).slice(0, 10), { ...e, ghost: true });
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (!!b.carried_over_from - !!a.carried_over_from)
      || String(a.ghost ? a.proposed_start : a.scheduled_start).slice(11).localeCompare(String(b.ghost ? b.proposed_start : b.scheduled_start).slice(11)));
  }
  const todayKey = meta.today;

  // Which slots this user may drag to another day.
  function canMove(e) {
    if (e.ghost) return false;
    if (['Draft', 'Rejected', 'For Confirmation'].includes(e.status)) return side.sbu;
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
    setSelectedDay(k);
    const [y, m] = k.split('-').map(Number);
    if (y !== month.getFullYear() || m - 1 !== month.getMonth()) setMonth(new Date(y, m - 1, 1));
    setModal({ kind: 'day', date: k });
  }

  const needsMe = events.filter((e) => !e.ghost && (
    (side.design && e.status === 'For Confirmation')
    || (side.design && e.phase === 'Confirmed')
    || awaitingMe(e, side)
    || (side.sbu && e.status === 'Rejected')
  ));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Design Schedule</h1>
        {side.sbu && (
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'new', date: selectedDay >= todayKey ? selectedDay : todayKey })}>
            + Schedule JO / NSTDJO
          </button>
        )}
      </div>

      {needsMe.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Waiting on you ({needsMe.length})</strong>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {needsMe.map((e) => (
              <button key={e.id} type="button" className={`badge ${PHASE_BADGE[e.phase]}`} style={{ border: 'none', cursor: 'pointer' }}
                onClick={() => setModal({ kind: 'detail', id: e.id })}>
                {e.order_no} · {e.proposed_by_side ? 'reschedule' : (PHASE_LABEL[e.phase] || e.phase)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
          <h3 style={{ margin: 0, minWidth: 170, textAlign: 'center' }}>{displayMonth(month)}</h3>
          <button type="button" className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
          <button type="button" className="btn btn-sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setSelectedDay(todayKey); }}>Today</button>
          {!side.artistEmployeeId && (
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              Artist calendar
              <select value={artistId} onChange={(e) => setArtistId(e.target.value)}>
                <option value="">All schedules</option>
                {meta.artists.map((a) => <option key={a.id} value={a.id}>{a.first_name} {a.last_name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, fontSize: 11 }}>
          {Object.keys(PHASE_BADGE).filter((p) => p !== 'Cancelled').map((p) => <span key={p} className={`badge ${PHASE_BADGE[p]}`}>{PHASE_LABEL[p] || p}</span>)}
          <span className="muted">↻ carried over · ⇄ reschedule pending{side.sbu || side.design ? ' · drag a slot to move it' : ''}</span>
        </div>
        {loading ? <LoadingSpinner /> : (
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
                        onOpen={() => setModal({ kind: 'detail', id: e.id })} />
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
          date={modal.date} list={byDay.get(modal.date) || []} canSchedule={side.sbu && modal.date >= todayKey}
          onClose={closeModal} onStep={openDay}
          onOpen={(e) => setModal({ kind: 'detail', id: e.id, back: modal.date })}
          onNew={(start) => setModal({ kind: 'new', date: modal.date, start })}
        />
      )}
      {modal?.kind === 'new' && (
        <NewScheduleModal date={modal.date} start={modal.start} onClose={closeModal} onSaved={() => { closeModal(); refresh(); }} />
      )}
      {modal?.kind === 'move' && (
        <MoveModal schedule={modal.schedule} date={modal.date} side={side} onClose={closeModal} onSaved={() => { closeModal(); refresh(); }} />
      )}
      {modal?.kind === 'detail' && (
        <DetailModal id={modal.id} meta={meta} onClose={closeModal} onChanged={refresh}
          onMove={(schedule) => setModal({ kind: 'move', schedule, date: String(schedule.scheduled_start).slice(0, 10) })} />
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
      title={`${e.order_no} · ${e.customer_name || ''} · ${PHASE_LABEL[e.phase] || e.phase}${e.artist_name ? ` · ${e.artist_name}` : ''}${e.carried_over_from ? ` · carried over from ${displayDate(e.carried_over_from)}` : ''}`}
      className={`badge ${PHASE_BADGE[e.phase]}`}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: draggable ? 'grab' : 'pointer', marginTop: 3,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11,
        border: e.ghost ? '1px dashed currentColor' : 'none', opacity: e.ghost ? 0.6 : 1,
        textDecoration: e.phase === 'Done' ? 'line-through' : 'none',
      }}
    >
      {e.carried_over_from && '↻ '}{e.proposed_by_side && !e.ghost && '⇄ '}{timeOf(start)} {e.order_no}
    </button>
  );
}

// One day, hour by hour: each slot drawn from its start to its end, side by side where they overlap.
// Carried-over slots sit in a strip above the timeline -- their times belong to the day they slipped from.
const HOUR_PX = 56;
const minutesOf = (v) => { const [h, m] = String(v).split(' ')[1].split(':').map(Number); return h * 60 + m; };
const shiftDay = (k, n) => { const [y, m, d] = k.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };

function DayModal({ date, list, canSchedule, onClose, onStep, onOpen, onNew }) {
  const carried = list.filter((e) => e.carried_over_from);
  const timed = list.filter((e) => !e.carried_over_from).map((e) => ({
    e,
    s: minutesOf(e.ghost ? e.proposed_start : e.scheduled_start),
    f: minutesOf(e.ghost ? e.proposed_end : e.scheduled_end),
  })).sort((a, b) => a.s - b.s || a.f - b.f);

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
    <Modal title={displayDate(date)} onClose={onClose} large>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <button type="button" className="btn btn-sm" onClick={() => onStep(shiftDay(date, -1))}>‹ Previous day</button>
        <button type="button" className="btn btn-sm" onClick={() => onStep(shiftDay(date, 1))}>Next day ›</button>
        <span className="muted" style={{ fontSize: 12 }}>{list.length} scheduled</span>
        {canSchedule && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => onNew('09:00')}>+ Schedule on this day</button>}
      </div>

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
              <button key={`${e.id}${e.ghost ? 'g' : ''}`} type="button" onClick={() => onOpen(e)}
                className={`badge ${PHASE_BADGE[e.phase]}`}
                title={e.description || ''}
                style={{
                  position: 'absolute', top: top + 1, height: height - 2,
                  left: `calc(56px + (100% - 62px) * ${col / n})`, width: `calc((100% - 62px) / ${n} - 4px)`,
                  textAlign: 'left', cursor: 'pointer', overflow: 'hidden', padding: '3px 6px', fontSize: 12, lineHeight: 1.3,
                  border: e.ghost ? '1px dashed currentColor' : '1px solid rgba(0,0,0,0.08)', opacity: e.ghost ? 0.6 : 1,
                  display: 'block', whiteSpace: 'normal',
                }}>
                <div><strong>{timeOf(e.ghost ? e.proposed_start : e.scheduled_start)} - {timeOf(e.ghost ? e.proposed_end : e.scheduled_end)}</strong> · {e.order_no} <span style={{ opacity: 0.7 }}>({e.order_type})</span></div>
                <div>{e.customer_name}{e.artist_name ? ` · ${e.artist_name}` : ''}{e.delivery_date ? ` · Delivery ${displayDate(e.delivery_date)}` : ''}</div>
                <div style={{ opacity: 0.8 }}>
                  {e.ghost ? '⇄ proposed new time' : (PHASE_LABEL[e.phase] || e.phase)}{!e.ghost && e.proposed_by_side ? ' · ⇄ reschedule pending' : ''}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      {list.length === 0 && <p className="muted" style={{ marginTop: 8 }}>Nothing scheduled{canSchedule ? ' -- click an hour to schedule a JO / NSTDJO there.' : '.'}</p>}
    </Modal>
  );
}

function NewScheduleModal({ date, start = '09:00', onClose, onSaved }) {
  const [orderType, setOrderType] = useState('JO');
  const [orders, setOrders] = useState([]);
  const endDefault = `${String(Math.min(23, Number(start.slice(0, 2)) + 3)).padStart(2, '0')}:${start.slice(3, 5)}`;
  const [form, setForm] = useState({ order_id: '', date, start, end: endDefault, notes: '', delivery_date: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOrders([]);
    setForm((f) => ({ ...f, order_id: '', delivery_date: '' }));
    api.get(`${ROUTE}/eligible`, { params: { type: orderType } }).then(({ data }) => setOrders(data));
  }, [orderType]);

  async function save(forward) {
    setError('');
    if (!form.order_id) { setError('Choose the order to schedule.'); return; }
    setSaving(true);
    try {
      await api.post(ROUTE, {
        order_type: orderType, order_id: form.order_id, notes: form.notes, delivery_date: form.delivery_date || null, forward,
        scheduled_start: `${form.date}T${form.start}`, scheduled_end: `${form.date}T${form.end}`,
      });
      onSaved();
    } catch (err) {
      setError(errorOf(err));
      setSaving(false);
    }
  }

  return (
    <Modal title="Schedule for Design" onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Type</label>
        <select value={orderType} onChange={(e) => setOrderType(e.target.value)}>
          <option value="JO">Job Order (JO)</option>
          <option value="NSTDJO">Non-Standard Job Order (NSTDJO)</option>
        </select>
      </div>
      <div className="field">
        <label>{orderType}</label>
        <EntityPicker
          label={orderType} items={orders} value={form.order_id} getLabel={(o) => `${o.order_no} - ${o.customer_name || ''}`}
          columns={[
            { key: 'order_no', label: 'No.' }, { key: 'customer_name', label: 'Customer' },
            { key: 'description', label: 'Description', render: (o) => String(o.description || '').slice(0, 60) },
            { key: 'sub_status', label: 'Sub Status' },
            { key: 'delivery_date', label: 'Delivery', render: (o) => displayDate(o.delivery_date) },
          ]}
          searchKeys={['order_no', 'customer_name', 'description']}
          // Delivery Date starts as the order's own; the SBU can change it for this schedule.
          onSelect={(o) => setForm({ ...form, order_id: o.id, delivery_date: o.delivery_date ? String(o.delivery_date).slice(0, 10) : '' })}
        />
        <div className="muted" style={{ fontSize: 12 }}>Orders waiting for Design that are not on the schedule yet.</div>
      </div>
      <div className="field">
        <label>Delivery Date</label>
        <input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} />
        {form.delivery_date && form.date && form.date > form.delivery_date && (
          <div className="badge-warning" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, marginTop: 4 }}>
            The design slot is after the delivery date.
          </div>
        )}
      </div>
      <SlotFields form={form} setForm={setForm} />
      <div className="field">
        <label>Notes for Design</label>
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn" disabled={saving} onClick={() => save(false)}>Save as Draft</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => save(true)}>Save &amp; Forward to Design</button>
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

// Moving a slot: a plain edit while Design has not confirmed it, a reschedule proposal once they have.
function MoveModal({ schedule, date, side, onClose, onSaved }) {
  const confirmed = schedule.status === 'Confirmed';
  const [form, setForm] = useState({
    date, start: hhmm(schedule.scheduled_start), end: hhmm(schedule.scheduled_end), note: '',
    delivery_date: schedule.delivery_date ? String(schedule.delivery_date).slice(0, 10) : '',
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
      else await api.put(`${ROUTE}/${schedule.id}`, { ...body, notes: schedule.notes, delivery_date: form.delivery_date || null });
      onSaved();
    } catch (err) {
      setError(errorOf(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={`${confirmed ? 'Reschedule' : 'Move'} ${schedule.order_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted">Currently {slotText(schedule.scheduled_start, schedule.scheduled_end)}.</p>
      {confirmed && other && (
        <p>This slot is confirmed, so the new time goes to {other} to accept. Until then it stays where it is.</p>
      )}
      {!confirmed && (
        <div className="field">
          <label>Delivery Date</label>
          <input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} />
        </div>
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

function DetailModal({ id, meta, onClose, onChanged, onMove }) {
  const { side } = meta;
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 'reject' | 'reject-proposal' | 'assign' -- the inline sub-form currently open.
  const [sub, setSub] = useState(null);
  const [reason, setReason] = useState('');

  function load() {
    api.get(`${ROUTE}/${id}`).then(({ data }) => setS(data)).catch((err) => setError(errorOf(err)));
  }
  useEffect(load, [id]);

  async function act(path, body) {
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post(`${ROUTE}/${id}/${path}`, body);
      setS((prev) => ({ ...data, history: prev?.history || [] }));
      setSub(null);
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

  const editable = ['Draft', 'Rejected', 'For Confirmation'].includes(s.status);
  const movable = s.status === 'Confirmed' && s.phase !== 'Done';
  const mineProposal = s.proposed_by_side && !side.both
    && ((s.proposed_by_side === 'DESIGN' && side.design) || (s.proposed_by_side === 'SBU' && side.sbu));

  return (
    <Modal title={`${s.order_no} · Design Schedule`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px' }}>
        <div>Order : <Link to={orderLink(s)} className="hi">{s.order_no}</Link> <span className="muted">({s.order_type})</span></div>
        <div>Status : <span className={`badge ${PHASE_BADGE[s.phase]}`}>{PHASE_LABEL[s.phase] || s.phase}</span></div>
        <div>Customer : <span className="hi">{s.customer_name}</span></div>
        <div>Schedule : <span className="hi">{slotText(s.scheduled_start, s.scheduled_end)}</span></div>
        <div>Delivery Date : <span className="hi">{s.delivery_date ? displayDate(s.delivery_date) : '--'}</span></div>
        <div>Artist : <span className="hi">{s.artist_name || '--'}</span></div>
        <div>Order Sub Status : <span className="hi">{s.order_sub_status}</span></div>
        <div>Scheduled by : <span className="hi">{s.created_by_name}</span></div>
        <div>Confirmed by : <span className="hi">{s.confirmed_by_name || '--'}</span></div>
      </div>
      {s.description && <p style={{ whiteSpace: 'pre-wrap' }}>{s.description}</p>}
      {s.notes && <p><strong>Notes:</strong> {s.notes}</p>}
      {s.carried_over_from && (
        <div className="badge-warning" style={{ padding: '8px 12px', borderRadius: 6, margin: '8px 0' }}>
          ↻ Not finished on {displayDate(s.carried_over_from)} -- carried over to today on the artist&apos;s calendar.
        </div>
      )}
      {s.status === 'Rejected' && s.reject_reason && <div className="error-banner">Rejected by Design: {s.reject_reason}</div>}
      {s.proposed_by_side && (
        <div className="card" style={{ margin: '8px 0' }}>
          ⇄ <strong>{s.proposed_by_name}</strong> ({s.proposed_by_side === 'DESIGN' ? 'Design' : 'SBU'}) proposed moving this to{' '}
          <strong>{slotText(s.proposed_start, s.proposed_end)}</strong>
          {s.proposal_note && <div className="muted">Reason: {s.proposal_note}</div>}
          <div className="muted">Waiting on {s.proposed_by_side === 'DESIGN' ? 'the SBU' : 'the Design Supervisor'}.</div>
        </div>
      )}

      {sub === 'reject' || sub === 'reject-proposal' ? (
        <div className="field">
          <label>{sub === 'reject' ? 'Why is this slot rejected? (required)' : 'Reason (optional)'}</label>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setSub(null)}>Back</button>
            <button type="button" className="btn btn-danger" disabled={busy}
              onClick={() => act(sub === 'reject' ? 'reject' : 'proposal/reject', { reason })}>Reject</button>
          </div>
        </div>
      ) : sub === 'assign' ? (
        <AssignArtistForm s={s} meta={meta} onCancel={() => setSub(null)} onDone={() => { setSub(null); onChanged(); load(); }} />
      ) : (
        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          {side.sbu && editable && <button type="button" className="btn" onClick={() => onMove(s)}>Edit date / time</button>}
          {side.sbu && ['Draft', 'Rejected'].includes(s.status) && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('forward')}>Forward to Design Supervisor</button>
          )}
          {side.sbu && s.status !== 'Cancelled' && !['Assigned', 'Done'].includes(s.phase) && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => window.confirm('Cancel this schedule?') && act('cancel')}>Cancel schedule</button>
          )}
          {side.design && s.status === 'For Confirmation' && (
            <>
              <button type="button" className="btn btn-danger" onClick={() => setSub('reject')}>Reject</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('confirm')}>Confirm</button>
            </>
          )}
          {side.design && ['Confirmed', 'Assigned'].includes(s.phase) && (
            <button type="button" className="btn btn-primary" onClick={() => setSub('assign')}>{s.phase === 'Assigned' ? 'Reassign Artist' : 'Assign Artist'}</button>
          )}
          {(side.sbu || side.design) && movable && !s.proposed_by_side && (
            <button type="button" className="btn" onClick={() => onMove(s)}>Reschedule</button>
          )}
          {awaitingMe(s, side) && (
            <>
              <button type="button" className="btn btn-danger" onClick={() => setSub('reject-proposal')}>Reject new time</button>
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

// The same assignment the JO / NSTDJO screens make, through the same endpoints. Planned Start is the
// confirmed slot -- that is what was agreed with the SBU, so it is not re-typed here.
function AssignArtistForm({ s, meta, onCancel, onDone }) {
  const [form, setForm] = useState({
    layout_job_type_id: s.layout_job_type_id || '', artist_id: s.artist_id || '', layout_qty: s.layout_qty || 1,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // An NSTDJO's layout job type has to belong to its own job type (nonStandardJobOrders.js assign-artist).
  const pmsJobTypes = s.order_type === 'NSTDJO'
    ? meta.pmsJobTypes.filter((p) => String(p.job_type_id) === String(s.nstdjo_job_type_id))
    : meta.pmsJobTypes;
  const plannedStart = String(s.scheduled_start).slice(0, 16).replace(' ', 'T');
  const minutes = pmsJobTypes.find((p) => String(p.id) === String(form.layout_job_type_id))?.minutes_consume;
  const plannedEnd = minutes && Number(form.layout_qty)
    ? new Date(new Date(plannedStart).getTime() + Number(minutes) * Number(form.layout_qty) * 60000).toLocaleString()
    : '';

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (s.order_type === 'JO') {
        await api.put(`/job-orders/${s.order_id}/assign-design`, {
          layout_job_type_id: form.layout_job_type_id, artist_id: form.artist_id, layout_qty: form.layout_qty, planned_start_at: plannedStart,
        });
      } else {
        await api.put(`/non-standard-job-orders/${s.order_id}/assign-artist`, {
          layout_job_type_id: form.layout_job_type_id || null, artist_employee_id: form.artist_id, layout_qty: form.layout_qty, planned_start_at: plannedStart,
        });
      }
      onDone();
    } catch (err) {
      setError(errorOf(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} style={{ marginTop: 8 }}>
      <h3>Assign Layout Job Type / Artist</h3>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Layout - Job Type</label>
        <EntityPicker
          label="Layout - Job Type" items={pmsJobTypes} value={form.layout_job_type_id} getLabel={(p) => p.display_name}
          columns={[{ key: 'code', label: 'Code' }, { key: 'display_name', label: 'Display Name' }, { key: 'minutes_consume', label: 'Minutes Consume' }]}
          searchKeys={['code', 'display_name']}
          onSelect={(p) => setForm({ ...form, layout_job_type_id: p.id })}
        />
      </div>
      <div className="field">
        <label>Artist</label>
        <EntityPicker
          label="Artist" items={meta.artists} value={form.artist_id} getLabel={(a) => `${a.first_name} ${a.last_name}`}
          columns={[{ key: 'name', label: 'Name', render: (a) => `${a.first_name} ${a.last_name}` }, { key: 'position_title', label: 'Position' }]}
          searchKeys={['first_name', 'last_name']}
          onSelect={(a) => setForm({ ...form, artist_id: a.id })}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <div className="field">
          <label>Qty</label>
          <input type="number" min="0.0001" step="any" required value={form.layout_qty} onChange={(e) => setForm({ ...form, layout_qty: e.target.value })} />
        </div>
        <div className="field"><label>Planned Start <span className="muted">(the schedule)</span></label><input readOnly tabIndex={-1} value={new Date(plannedStart).toLocaleString()} /></div>
        <div className="field"><label>Planned End <span className="muted">(Minutes × Qty)</span></label><input readOnly tabIndex={-1} value={plannedEnd} /></div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>Back</button>
        <button type="submit" className="btn btn-primary" disabled={saving || !form.artist_id}>Save</button>
      </div>
    </form>
  );
}
