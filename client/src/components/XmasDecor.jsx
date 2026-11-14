import { useMemo } from 'react';

// Christmas theme decorations (styles/xmas.css; on while html.xmas is set -- utils/season.js).
// Rendered once, by Layout, only while Christmas is the season. Inline SVG and CSS shapes only,
// fixed, behind the page content (z-index -1), never taking a click (pointer-events: none):
//   - a string of lights under the menu bar: a wavy wire and 30 glowing bulbs, alternate ones
//     twinkling out of step;
//   - a frosted Christmas tree at the top right: three pale tiers, blue ornaments, a pulsing ice star;
//   - about 40 snowflakes falling at their own speeds with a slight sideways drift;
//   - soft snowdrifts along the bottom.
// The snow cap and holly on each card are drawn by xmas.css. prefers-reduced-motion stops it all.
// Blue and white (2026-11-14: the frosty winter-night palette).
const BULBS = ['#FFFFFF', '#7FC8F8', '#BFE3FF', '#4A96F0', '#E6F4FF'];

function Tree() {
  return (
    <svg className="xm-tree" viewBox="0 0 120 160" width="120" height="160" aria-hidden="true">
      <rect x="52" y="132" width="16" height="22" rx="2" fill="#8BA2C2" />
      <path d="M60 78 L108 136 H12 Z" fill="#A9C6E8" />
      <path d="M60 50 L98 104 H22 Z" fill="#C3D9F2" />
      <path d="M60 22 L86 72 H34 Z" fill="#DCEBFA" />
      <path d="M24 128 Q60 112 98 126" stroke="#FFFFFF" strokeWidth="1.5" fill="none" opacity="0.8" />
      <path d="M32 98 Q60 86 90 96" stroke="#FFFFFF" strokeWidth="1.5" fill="none" opacity="0.8" />
      {[[40, 118, '#4A96F0'], [62, 124, '#7FC8F8'], [86, 116, '#4A96F0'], [48, 92, '#BFE3FF'], [72, 90, '#4A96F0'], [58, 64, '#7FC8F8'], [30, 128, '#7FC8F8'], [94, 130, '#4A96F0']]
        .map(([cx, cy, c]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4" fill={c} />)}
      <g className="xm-star">
        <path d="M60 4 L64 15 L76 15 L66.5 22 L70 33 L60 26 L50 33 L53.5 22 L44 15 L56 15 Z" fill="#BFE3FF" />
      </g>
    </svg>
  );
}

export default function XmasDecor() {
  const flakes = useMemo(() => Array.from({ length: 40 }, (_, i) => ({
    left: (i * 61 + 13) % 100,
    size: 2 + (i % 5),
    opacity: 0.35 + ((i * 7) % 6) / 10,
    dur: 9 + ((i * 13) % 10),
    delay: -((i * 29) % 18),
    drift: (i % 2 ? 1 : -1) * (10 + ((i * 17) % 30)),
  })), []);
  return (
    <div className="xm-decor" aria-hidden="true">
      <div className="xm-lights">
        <svg className="xm-wire" viewBox="0 0 1200 20" preserveAspectRatio="none">
          <path d="M0 4 Q20 16 40 4 T80 4 T120 4 T160 4 T200 4 T240 4 T280 4 T320 4 T360 4 T400 4 T440 4 T480 4 T520 4 T560 4 T600 4 T640 4 T680 4 T720 4 T760 4 T800 4 T840 4 T880 4 T920 4 T960 4 T1000 4 T1040 4 T1080 4 T1120 4 T1160 4 T1200 4" stroke="#2C4670" strokeWidth="2" fill="none" />
        </svg>
        <div className="xm-bulbs">
          {Array.from({ length: 30 }, (_, i) => {
            const c = BULBS[i % BULBS.length];
            return <span key={i} className={i % 2 ? 'xm-bulb xm-twinkle' : 'xm-bulb'} style={{ background: c, color: c, animationDelay: `${-((i * 0.37) % 2)}s` }} />;
          })}
        </div>
      </div>
      <Tree />
      {flakes.map((f, i) => (
        <span
          key={i}
          className="xm-flake"
          style={{ left: `${f.left}%`, width: f.size, height: f.size, opacity: f.opacity, animationDuration: `${f.dur}s`, animationDelay: `${f.delay}s`, '--drift': `${f.drift}px` }}
        />
      ))}
      <svg className="xm-drifts" viewBox="0 0 1200 120" preserveAspectRatio="none">
        <path d="M0 70 Q150 30 300 62 T600 56 T900 50 T1200 60 V120 H0 Z" fill="#E6F0FA" opacity="0.07" />
        <path d="M0 92 Q200 60 420 86 T820 80 T1200 84 V120 H0 Z" fill="#E6F0FA" opacity="0.1" />
      </svg>
    </div>
  );
}
