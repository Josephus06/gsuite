import { parseUtc } from '../../utils/datetime';

// Facebook's relative timestamps: seconds -> "Just now", then m / h, then "Yesterday at
// 4:05 PM", then a date. parseUtc (not `new Date`) because the pool runs dateStrings:true
// and hands back marker-less UTC strings -- see utils/datetime.js.
export function fbTime(iso) {
  const d = parseUtc(iso);
  if (!d) return '';
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);

  if (secs < 60) return 'Just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;

  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (secs < 172800) return `Yesterday at ${time}`;

  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString([], sameYear
    ? { month: 'long', day: 'numeric' }
    : { month: 'long', day: 'numeric', year: 'numeric' });
  return `${date} at ${time}`;
}

// Long form for the hover title on a timestamp.
export function fbTimeFull(iso) {
  const d = parseUtc(iso);
  return d ? d.toLocaleString([], {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) : '';
}
