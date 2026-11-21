import { pct } from './stpUtils';
import './stp.css';

// Small display components shared by the STP screens. Score colours: 4-5 blue, 3 gray, 1-2 orange.
const band = (s) => (s == null ? 'none' : s >= 4 ? 'good' : s === 3 ? 'mid' : 'low');

export function ScoreChip({ value, title }) {
  return <span className={`stp-chip ${band(value)}`} title={title}>{value ?? '–'}</span>;
}

export function Dots({ value }) {
  return (
    <div className={`stp-dots ${band(value)}`} aria-label={value == null ? 'Not scored' : `${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={value != null && i <= value ? 'on' : ''} />)}
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

export function Bar({ value, over }) {
  const w = value == null ? 0 : Math.max(0, Math.min(1, Number(value))) * 100;
  return (
    <div className={`stp-bar${over ? ' over' : ''}`}>
      <div className="track"><div className="fill" style={{ width: `${w}%` }} /></div>
      <span className="pct">{pct(value)}</span>
    </div>
  );
}

export function Kpi({ label, value, hint }) {
  return (
    <div className="card stp-kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}


export function PeriodSelect({ fy, setFy, years }) {
  const options = years?.length ? years : [fy];
  return (
    <label className="stp-period">
      Period
      <select value={fy} onChange={(e) => setFy(Number(e.target.value))}>
        {options.map((y) => <option key={y} value={y}>FY {y}</option>)}
      </select>
    </label>
  );
}

