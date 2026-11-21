import { useState } from 'react';
import { pct, date } from './stpUtils';
import './stp.css';

// Small display components shared by the STP screens. Score colours: 4-5 blue (primary), 3 gray,
// 1-2 orange (warning) -- theme tokens only, so day / night / glass all follow.

// Line icons drawn to the app's NavIcon spec: 24px box, 1.6 stroke, round caps and joins, no fills.
const ICONS = {
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></>,
  potential: <><path d="M4 19h16" /><path d="M6 15l4-4 3 3 5-6" /><path d="M14 8h4v4" /></>,
  revenue: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6.5 9.5v.01M17.5 14.5v.01" /></>,
  penetration: <><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12Z" /><path d="M15 3.8A8.5 8.5 0 0 1 20.2 9H15Z" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  recency: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  frequency: <><path d="M4 16l4-5 3.5 3 4-6L20 12" /><path d="M4 20h16" /></>,
  volume: <><path d="M5 20V12M10 20V7M15 20v-5M20 20V4" /></>,
  character: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3 10h18M7 14.5h3" /></>,
  reps: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3 3 0 0 1 0 5.6" /><path d="M17.5 20a5 5 0 0 0-2.3-4.2" /></>,
  workload: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-5" /></>,
  alert: <><path d="M12 4 21 19.5H3Z" /><path d="M12 10v4M12 17v.01" /></>,
  map: <><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6Z" /><path d="M9 4v14M15 6v14" /></>,
  visit: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" /></>,
  terms: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  history: <><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4v4h4" /><path d="M12 8v4l2.5 1.5" /></>,
  segment: <><path d="M4 7.5 12 3l8 4.5-8 4.5Z" /><path d="M4 12l8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
};

export function Icon({ name, size = 18, className = '' }) {
  return (
    <svg className={`stp-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] || <rect x="5" y="5" width="14" height="14" rx="2" />}
    </svg>
  );
}

const band = (s) => (s == null ? 'none' : s >= 4 ? 'good' : s === 3 ? 'mid' : 'low');

// Initials in a tinted circle -- accounts and reps have no pictures of their own.
export function Avatar({ name, size = 32, tone = 'primary' }) {
  const words = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  return <span className={`stp-avatar ${tone}`} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">{initials}</span>;
}

export function ScoreChip({ value, title }) {
  return <span className={`stp-chip ${band(value)}`} title={title}>{value ?? '–'}</span>;
}

// Five steps, filled up to the score -- the 1-5 scale read at a glance.
export function Steps({ value }) {
  return (
    <div className={`stp-steps ${band(value)}`} role="img" aria-label={value == null ? 'Not scored' : `${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={value != null && i <= value ? 'on' : ''} />)}
    </div>
  );
}

// The total RFVC score as a ring: the arc is the score out of 5, coloured by its tier.
export function ScoreRing({ value, tier, size = 116 }) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const share = value == null ? 0 : Math.max(0, Math.min(5, Number(value))) / 5;
  return (
    <div className="stp-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={value == null ? 'Not scored' : `Score ${Number(value).toFixed(2)} of 5`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="track" strokeWidth={stroke} />
        {value != null && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" className={`arc tier-${tier || 'none'}`} strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={`${c * share} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
      </svg>
      <div className="stp-ring-label">
        <div className="num">{value == null ? '—' : Number(value).toFixed(2)}</div>
        <div className="of">out of 5</div>
      </div>
    </div>
  );
}

// short: just the letter (table cells); otherwise "Tier A".
export function TierPill({ tier, prospect, short }) {
  if (!tier) return <span className={`stp-pill tier-${prospect ? 'Prospect' : 'none'}`}>{prospect ? 'Prospect' : 'Not scored'}</span>;
  return <span className={`stp-pill tier-${tier}`}>{short ? tier : `Tier ${tier}`}</span>;
}

export function StatusPill({ status }) {
  return <span className={`stp-pill st-${String(status).split(' ')[0]}`}>{status}</span>;
}

export function Bar({ value, over, label = true }) {
  const w = value == null ? 0 : Math.max(0, Math.min(1, Number(value))) * 100;
  return (
    <div className={`stp-bar${over ? ' over' : ''}`}>
      <div className="track"><div className="fill" style={{ width: `${w}%` }} /></div>
      {label && <span className="pct">{pct(value)}</span>}
    </div>
  );
}

export function Kpi({ label, value, hint, icon, tone = 'primary' }) {
  return (
    <div className="card stp-kpi">
      {icon && <span className={`stp-kpi-icon ${tone}`}><Icon name={icon} size={20} /></span>}
      <div className="stp-kpi-body">
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
    </div>
  );
}

// Where an account stands on visits: a status pill with its own icon and words, not colour alone.
export function VisitStatus({ next, overdue, today }) {
  if (!next) return <span className="stp-status none"><Icon name="calendar" size={14} />Not scheduled</span>;
  if (overdue) return <span className="stp-status late"><Icon name="alert" size={14} />Overdue since {date(next)}</span>;
  const days = Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days <= 7) return <span className="stp-status soon"><Icon name="calendar" size={14} />Due {days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}</span>;
  return <span className="stp-status ok"><Icon name="check" size={14} />On track · {date(next)}</span>;
}

// Total score across scoring runs, oldest to newest: one series, so no legend -- the card title
// names it. Hover shows the run's date and score.
export function ScoreTrend({ points, height = 84 }) {
  const [hover, setHover] = useState(null);
  const data = points.filter((p) => p.total_score != null);
  if (data.length < 2) return <p className="muted" style={{ margin: '4px 0 12px' }}>The trend appears after the second scoring run.</p>;
  const width = 560;
  const pad = { l: 26, r: 10, t: 10, b: 18 };
  const x = (i) => pad.l + (i * (width - pad.l - pad.r)) / (data.length - 1);
  const y = (v) => pad.t + ((5 - Number(v)) / 4) * (height - pad.t - pad.b);
  const d = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.total_score).toFixed(1)}`).join(' ');
  const h = hover == null ? null : data[hover];
  return (
    <div className="stp-trend">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Total score over time"
        onMouseLeave={() => setHover(null)}>
        {[1, 3, 5].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} className="grid" />
            <text x={pad.l - 8} y={y(g) + 4} className="axis" textAnchor="end">{g}</text>
          </g>
        ))}
        <path d={d} className="line" vectorEffect="non-scaling-stroke" />
        {data.map((p, i) => (
          <g key={p.id}>
            <circle cx={x(i)} cy={y(p.total_score)} r={hover === i ? 5 : 3.5} className="dot" />
            <rect x={x(i) - (width / data.length) / 2} y={0} width={width / data.length} height={height} fill="transparent"
              onMouseEnter={() => setHover(i)} />
          </g>
        ))}
      </svg>
      {h && (
        <div className="stp-tip" style={{ left: `${(x(hover) / width) * 100}%` }}>
          <strong>{Number(h.total_score).toFixed(2)}</strong> · {date(h.period_end)}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon, title, children, action }) {
  return (
    <div className="stp-empty">
      <span className="stp-empty-icon"><Icon name={icon} size={26} /></span>
      <div className="title">{title}</div>
      {children && <div className="text">{children}</div>}
      {action}
    </div>
  );
}

export function PeriodSelect({ fy, setFy, years }) {
  const options = years?.length ? years : [fy];
  return (
    <label className="stp-period">
      <Icon name="calendar" size={16} />
      <select value={fy} onChange={(e) => setFy(Number(e.target.value))} aria-label="Period (fiscal year)">
        {options.map((y) => <option key={y} value={y}>FY {y}</option>)}
      </select>
    </label>
  );
}
