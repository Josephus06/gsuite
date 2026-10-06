import { useState } from 'react';

// The Day / Week / Month switch shared by the General Manager's dashboard calendars (asked
// 2026-10-06). One anchor date, three ways to look around it:
//   month  the anchor's month, Sunday-first grid with blank leading cells (what they always showed)
//   week   the seven days, Sunday to Saturday, around the anchor -- may straddle two months
//   day    the anchor alone
// `months` is every YYYY-MM the visible days fall in: the calendar endpoints are monthly, so a week
// across a month end asks for both. Day keys are built from local dates, never toISOString(), which
// slides a day back here in UTC+8 before 08:00.
export const CALENDAR_RANGES = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };

export function useCalendarRange(range = 'month') {
  const [anchor, setAnchor] = useState(() => dayKey(new Date()));
  const a = parse(anchor);

  let cells = [];
  let title = '';
  if (range === 'day') {
    cells = [anchor];
    title = a.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } else if (range === 'week') {
    const start = new Date(a.getFullYear(), a.getMonth(), a.getDate() - a.getDay());
    for (let i = 0; i < 7; i += 1) cells.push(dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
    const end = parse(cells[6]);
    const short = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    title = `${short(start)} – ${short(end)}, ${end.getFullYear()}`;
  } else {
    const y = a.getFullYear(); const m = a.getMonth();
    const leading = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < leading; i += 1) cells.push(null);
    for (let d = 1; d <= days; d += 1) cells.push(dayKey(new Date(y, m, d)));
    title = `${MONTH_NAMES[m]} ${y}`;
  }
  const days = cells.filter(Boolean);
  const months = [...new Set(days.map((k) => k.slice(0, 7)))];

  const shift = (delta) => {
    if (range === 'day') setAnchor(dayKey(new Date(a.getFullYear(), a.getMonth(), a.getDate() + delta)));
    else if (range === 'week') setAnchor(dayKey(new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * delta)));
    else setAnchor(dayKey(new Date(a.getFullYear(), a.getMonth() + delta, 1)));
  };

  return { cells, days, months, title, shift, todayKey: dayKey(new Date()), first: days[0], last: days[days.length - 1] };
}

// The Day / Week / Month buttons.
export function CalendarRangeSwitch({ value, onChange }) {
  return (
    <div className="status-tabs" style={{ margin: 0 }}>
      {CALENDAR_RANGES.map((r) => (
        <button key={r.key} type="button" className={`status-tab ${value === r.key ? 'active' : ''}`} onClick={() => onChange(r.key)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}
