// Small dependency-free SVG chart primitives for the Dashboard's holographic look --
// no charting library added, everything here is plain SVG + the glow styling lives in
// dashboard.css (drop-shadow filters keyed to each chart's stroke color).

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

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
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={thickness} />
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
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={thickness} />
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
