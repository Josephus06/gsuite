// Generate Report (asked 2026-11-09): one day of the Crew & Vehicle Schedule as a PNG -- a column per
// installer / subcon / driver, a row per hour from 12:00 AM to 11:00 PM, each booking a block from its
// start to its end in its Job Order's colour (the Day view's colours). Drawn straight onto a canvas, so
// the whole day is in the picture at once: no scroll, no screenshot library.
import { displayDate } from '../../utils/dates';
import { resourceKey, resourceName, timeText } from './common';

export const JOB_COLORS = ['#f4b183', '#00b0f0', '#a9d18e', '#ffd966', '#c9a0dc', '#f8a5a5', '#8fd3c7', '#b4c7e7'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const HOUR = 44; // px per hour
const GUTTER = 84; // the hour labels
const COL = 170; // px per person
const HEAD = 58; // names row
const TITLE = 64; // title block
const PAD = 20;
const FONT = '"Segoe UI", Roboto, Arial, sans-serif';

// A block's colour is its Job Order's (each job its own colour); the work (Assembling / Installation,
// 2026-11-11) is a tag on it in the work type's colour.
const blockKey = (s) => s.job_order_no || s.project_no;
const minutesOf = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

// Words into lines no wider than `width`, at most `max` lines (the last one cut with an ellipsis).
function wrap(ctx, text, width, max) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    lines.length = max;
    let last = lines[max - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    lines[max - 1] = `${last}…`;
  }
  return lines;
}

/**
 * dayKey  YYYY-MM-DD
 * kind    RESOURCES entry (one, plural)
 * people  [{ key, name }] -- everyone of that kind, booked or not
 * slots   that kind's slots (from /crew), any days -- only dayKey's are drawn
 * Resolves to a PNG Blob.
 */
export function renderDayPng({ dayKey, kind, people, slots }) {
  const daySlots = slots.filter((s) => String(s.work_date).slice(0, 10) === dayKey);
  const cols = new Map(people.map((p) => [p.key, { name: p.name, slots: [] }]));
  for (const s of daySlots) {
    const k = resourceKey(s);
    if (!cols.has(k)) cols.set(k, { name: resourceName(s), slots: [] });
    cols.get(k).slots.push(s);
  }
  const columns = [...cols.values()].sort((a, b) => a.name.localeCompare(b.name));
  const colorOf = new Map();
  for (const s of [...daySlots].sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time))) {
    const key = blockKey(s);
    if (!colorOf.has(key)) colorOf.set(key, JOB_COLORS[colorOf.size % JOB_COLORS.length]);
  }

  const n = Math.max(columns.length, 1);
  const width = PAD * 2 + GUTTER + n * COL;
  const legendH = colorOf.size ? 30 : 0;
  const height = PAD * 2 + TITLE + HEAD + 24 * HOUR + legendH;
  const scale = 2; // sharp when zoomed or printed
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Title
  const [y, m, d] = dayKey.split('-').map(Number);
  const free = columns.filter((c) => !c.slots.length).length;
  ctx.fillStyle = '#111827';
  ctx.font = `700 20px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillText(`${kind.plural} Schedule — ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}, ${displayDate(dayKey)}`, PAD, PAD);
  ctx.font = `13px ${FONT}`;
  ctx.fillStyle = '#4b5563';
  ctx.fillText(`${columns.length} ${kind.plural.toLowerCase()} · ${free} available all day · ${daySlots.length} booking(s)`, PAD, PAD + 28);

  const top = PAD + TITLE;
  const gridTop = top + HEAD;
  const left = PAD + GUTTER;

  // Names row
  ctx.fillStyle = '#f3f4f6';
  ctx.fillRect(PAD, top, width - PAD * 2, HEAD);
  ctx.fillStyle = '#111827';
  ctx.font = `700 12px ${FONT}`;
  ctx.fillText(kind.plural, PAD + 6, top + 8);
  columns.forEach((c, i) => {
    const x = left + i * COL;
    ctx.font = `700 12px ${FONT}`;
    ctx.fillStyle = '#111827';
    const lines = wrap(ctx, c.name.toUpperCase(), COL - 12, 2);
    lines.forEach((l, j) => ctx.fillText(l, x + 6, top + 7 + j * 15));
    const hrs = c.slots.reduce((t, s) => t + (minutesOf(s.end_time) - minutesOf(s.start_time)) / 60, 0);
    ctx.font = `${c.slots.length ? 400 : 600} 11px ${FONT}`;
    ctx.fillStyle = c.slots.length ? '#4b5563' : '#16a34a';
    ctx.fillText(c.slots.length ? `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)} hrs booked` : 'Available all day', x + 6, top + 7 + lines.length * 15 + 2);
  });

  // Hour rows and column lines
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  for (let h = 0; h <= 24; h += 1) {
    const yy = gridTop + h * HOUR + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD, yy); ctx.lineTo(width - PAD, yy); ctx.stroke();
    if (h < 24) {
      ctx.fillStyle = '#374151';
      ctx.font = `11px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(hourLabel(h), left - 8, yy + 4);
      ctx.textAlign = 'left';
    }
  }
  for (let i = 0; i <= n; i += 1) {
    const xx = left + i * COL + 0.5;
    ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, gridTop + 24 * HOUR); ctx.stroke();
  }
  ctx.strokeStyle = '#9ca3af';
  ctx.strokeRect(PAD + 0.5, top + 0.5, width - PAD * 2 - 1, HEAD + 24 * HOUR - 1);

  // Bookings
  columns.forEach((c, i) => {
    const x = left + i * COL;
    for (const s of c.slots) {
      const y0 = gridTop + (minutesOf(s.start_time) / 60) * HOUR;
      const h = Math.max(20, ((minutesOf(s.end_time) - minutesOf(s.start_time)) / 60) * HOUR);
      ctx.fillStyle = colorOf.get(blockKey(s));
      ctx.fillRect(x + 3, y0 + 1, COL - 6, h - 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.strokeRect(x + 3.5, y0 + 1.5, COL - 7, h - 3);
      ctx.save();
      ctx.beginPath(); ctx.rect(x + 3, y0 + 1, COL - 6, h - 2); ctx.clip();
      ctx.fillStyle = '#111827';
      // The work (Assembling / Installation) on top when the slot has one, as on the planners' sheet.
      let ty = y0 + 5;
      if (s.work_type) {
        ctx.font = `700 11px ${FONT}`;
        const tw = ctx.measureText(s.work_type).width + 10;
        ctx.fillStyle = s.work_color || '#b4c7e7';
        ctx.fillRect(x + 7, ty - 1, tw, 15);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.strokeRect(x + 7.5, ty - 0.5, tw - 1, 14);
        ctx.fillStyle = '#111827';
        ctx.fillText(s.work_type, x + 12, ty + 1);
        ty += 17;
      }
      ctx.font = `11px ${FONT}`;
      ctx.fillText(`${timeText(s.start_time)} – ${timeText(s.end_time)}`, x + 8, ty);
      ctx.font = `700 12px ${FONT}`;
      const label = `(${s.job_order_no || s.project_no})`;
      // the JO at the foot of a tall block, on the next line of a short one
      ctx.fillText(label, x + 8, h > 40 + (ty - y0 - 5) ? y0 + h - 18 : ty + 13);
      const titleTop = ty + 16;
      if (h - (titleTop - y0) > 34 && s.project_title) {
        ctx.font = `11px ${FONT}`;
        wrap(ctx, s.project_title, COL - 18, Math.floor((h - (titleTop - y0) - 22) / 14)).forEach((l, j) => ctx.fillText(l, x + 8, titleTop + j * 14));
      }
      ctx.restore();
    }
  });

  // Legend: which colour is which job
  if (colorOf.size) {
    let lx = PAD;
    const ly = gridTop + 24 * HOUR + 10;
    ctx.font = `12px ${FONT}`;
    for (const [job, color] of colorOf) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly, 14, 14);
      ctx.fillStyle = '#111827';
      ctx.fillText(job, lx + 20, ly + 1);
      lx += 20 + ctx.measureText(job).width + 18;
    }
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
