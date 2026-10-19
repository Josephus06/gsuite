import { DUE_BADGE } from '../utils/fleet';

// A Fleet table cell: the date (or km) and an Overdue / Due soon / OK badge.
export default function FleetDueCell({ d, children }) {
  const b = DUE_BADGE[d?.status || 'none'];
  return (
    <td>
      <div>{children || '—'}</div>
      {d && d.status !== 'none' && <span className={`badge ${b.cls}`} style={{ fontSize: 11 }}>{b.text}{d.days_left != null && d.status !== 'ok' ? ` · ${d.days_left < 0 ? `${-d.days_left}d ago` : `${d.days_left}d`}` : ''}</span>}
    </td>
  );
}

