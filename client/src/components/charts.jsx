// Small dependency-free SVG chart primitives for the Dashboard's holographic look --
// no charting library added, everything here is plain SVG + the glow styling lives in
// dashboard.css (drop-shadow filters keyed to each chart's stroke color).

import { useEffect, useRef, useState } from 'react';

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

// Animates from 0 to `value` over `duration`ms using an ease-out curve -- used to give
// stat numbers a "materializing" feel on load instead of just appearing. Re-triggers
// whenever `value` itself changes (e.g. dashboard data reloads).
export function useCountUp(value, duration = 900) {
  const [display, setDisplay] = useState(0);
  const target = num(value);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    let raf;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      setDisplay(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return display;
}

// A continuously-spinning 3D ring (real CSS 3D: perspective + rotateX tilt + an
// infinite rotateY loop on the ring itself, plus a slow counter-orbiting particle) --
// used in place of the flat GaugeRing where the dashboard wants a genuinely animated
// holographic centerpiece rather than a static progress ring.
export function Holo3DOrb({ value, max = 100, size = 150, color = '#22d3ee', label, sub }) {
  const pct = Math.max(0, Math.min(1, num(value) / (max || 1)));
  const animated = useCountUp(value);
  return (
    <div className="holo3d-orb-scene" style={{ width: size, height: size }}>
      <div className="holo3d-orb-ring-wrap">
        <div className="holo3d-orb-ring holo3d-orb-ring-outer" style={{ '--orb-color': color, '--orb-pct': pct }} />
        <div className="holo3d-orb-ring holo3d-orb-ring-inner" style={{ '--orb-color': color }} />
        <div className="holo3d-orb-particle" style={{ '--orb-color': color }} />
      </div>
      <div className="holo3d-orb-center">
        <div className="holo-donut-value">{label ?? `${Math.round(animated)}%`}</div>
        {sub && <div className="holo-donut-sub">{sub}</div>}
      </div>
    </div>
  );
}

// A hand-rolled CSS 3D bar chart -- each bar is a real extruded box (front + top +
// side faces via transform-style: preserve-3d), the whole scene sits on a fixed
// isometric tilt (kept static, not spinning, so the values stay legible) and gently
// "breathes" (a few degrees of oscillating tilt) so it still reads as animated/alive,
// with each bar growing in from zero height on mount.
export function Holo3DBars({ data, color = '#22d3ee', width = 320, height = 120, labels }) {
  const values = (data || []).map(num);
  const max = Math.max(...values, 1);
  const barW = 26;
  const gap = 16;
  const depth = 10;

  return (
    <div className="holo3d-bars-scene" style={{ width, height: height + 46 }}>
      <div className="holo3d-bars-stage" style={{ height }}>
        {values.map((v, i) => {
          const h = Math.max(6, (v / max) * height);
          return (
            <div
              key={i}
              className="holo3d-bar"
              style={{
                '--bar-h': `${h}px`, '--bar-w': `${barW}px`, '--bar-d': `${depth}px`, '--bar-color': color,
                left: `${i * (barW + gap)}px`, animationDelay: `${i * 90}ms`,
              }}
            >
              <div className="holo3d-bar-top" />
              <div className="holo3d-bar-front" />
            </div>
          );
        })}
      </div>
      {labels && (
        <div className="holo3d-bars-labels" style={{ width: values.length * (barW + gap) }}>
          {labels.map((l, i) => <span key={i} style={{ width: barW + gap }}>{l}</span>)}
        </div>
      )}
    </div>
  );
}

// A smooth-ish trend line with a soft gradient fill underneath, used inside stat cards
// (mirrors the small wavy charts in the reference dashboard's top stat row).
export function Sparkline({ data, color = '#22d3ee', width = 140, height = 40, id }) {
  const gradId = `spark-grad-${id}`;
  const values = (data && data.length ? data : [0, 0]).map(num);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = width / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 6) - 3]);
  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const fillPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="holo-sparkline">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradId})`} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
    </svg>
  );
}

// Multi-segment ring built from stacked SVG circles (stroke-dasharray trick) -- no path
// arc math needed. `data` = [{ label, value, color }]. Falls back to a single greyed-out
// ring when there's nothing to show yet.
export function DonutChart({ data, size = 150, thickness = 16, centerLabel, centerSub }) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = (data || []).reduce((s, d) => s + num(d.value), 0);
  const segments = total > 0 ? data : [{ label: 'No data', value: 1, color: 'rgba(255,255,255,0.08)' }];
  let offset = 0;

  return (
    <div className="holo-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(43,45,66,0.09)" strokeWidth={thickness} />
        {segments.map((seg, i) => {
          const fraction = num(seg.value) / (total > 0 ? total : 1);
          const dash = fraction * c;
          const el = (
            <circle
              key={i}
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={seg.color} strokeWidth={thickness}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={total > 0 ? { filter: `drop-shadow(0 0 5px ${seg.color})` } : undefined}
            />
          );
          offset += dash;
          return el;
        })}
      </svg>
      {(centerLabel || centerSub) && (
        <div className="holo-donut-center">
          {centerLabel && <div className="holo-donut-value">{centerLabel}</div>}
          {centerSub && <div className="holo-donut-sub">{centerSub}</div>}
        </div>
      )}
    </div>
  );
}

// Single-value circular progress ring (e.g. Win Rate / KPI gauges).
export function GaugeRing({ value, max = 100, size = 120, thickness = 12, color = '#22d3ee', label, sub }) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, num(value) / (max || 1)));
  const dash = pct * c;

  return (
    <div className="holo-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(43,45,66,0.09)" strokeWidth={thickness} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={thickness}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: 'stroke-dasharray 0.6s ease' }}
        />
      </svg>
      <div className="holo-donut-center">
        <div className="holo-donut-value">{label ?? `${Math.round(pct * 100)}%`}</div>
        {sub && <div className="holo-donut-sub">{sub}</div>}
      </div>
    </div>
  );
}

// Horizontal glowing bars, one row per item -- used for Sales by Department / Top
// Customers, where a label + relative magnitude matters more than precise geometry.
export function BarList({ data, color = '#a78bfa', formatValue }) {
  const max = Math.max(...(data || []).map((d) => num(d.value)), 1);
  if (!data || !data.length) return <p className="muted">No data yet.</p>;
  return (
    <div className="holo-barlist">
      {data.map((d, i) => (
        <div className="holo-barlist-row" key={i}>
          <div className="holo-barlist-label">{d.label}</div>
          <div className="holo-barlist-track">
            <div
              className="holo-barlist-fill"
              style={{ width: `${(num(d.value) / max) * 100}%`, background: d.color || color, boxShadow: `0 0 8px ${d.color || color}` }}
            />
          </div>
          <div className="holo-barlist-value">{formatValue ? formatValue(d.value) : d.value}</div>
        </div>
      ))}
    </div>
  );
}
