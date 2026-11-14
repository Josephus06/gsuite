// Spooky theme decorations (styles/spooky.css; on while html.spooky is set -- utils/season.js).
// Rendered once, by Layout. Everything here is inline SVG, fixed, behind the page content
// (.content sits above it), and never takes a click (pointer-events: none):
//   - a glowing moon at the top right, under the menu bar;
//   - three bats near it with orange eyes, wings flapping and each drifting on its own delay;
//   - a faint purple / orange fog along the bottom of the screen.
// The slime drip under the menu bar and the cobweb on each card are drawn by spooky.css.
// prefers-reduced-motion stops the flapping and drifting (spooky.css).

function Bat({ className, style }) {
  return (
    <svg className={`sp-bat ${className}`} style={style} viewBox="0 0 64 32" width="44" height="22" aria-hidden="true">
      <g className="sp-bat-wings">
        <path
          d="M32 12c-2-4-6-6-10-6 1 2 1 4 0 5-3-3-8-4-12-3 2 2 2 4 1 6-4-1-8 0-11 2 6 1 11 4 14 8 2-2 5-3 8-2 2-2 5-3 8-2 1-2 1-5 2-8z
             M32 12c2-4 6-6 10-6-1 2-1 4 0 5 3-3 8-4 12-3-2 2-2 4-1 6 4-1 8 0 11 2-6 1-11 4-14 8-2-2-5-3-8-2-2-2-5-3-8-2-1-2-1-5-2-8z"
          fill="#0B0710"
          stroke="#2A2135"
          strokeWidth="0.6"
        />
      </g>
      <ellipse cx="32" cy="15" rx="4.2" ry="6" fill="#0B0710" />
      <path d="M29 10l1-3 1.6 2.4M35 10l-1-3-1.6 2.4" fill="#0B0710" stroke="#0B0710" strokeWidth="1" />
      <circle cx="30.4" cy="13.4" r="1.1" fill="#FF7A1A" />
      <circle cx="33.6" cy="13.4" r="1.1" fill="#FF7A1A" />
    </svg>
  );
}

export default function SpookyDecor() {
  return (
    <div className="sp-decor" aria-hidden="true">
      <div className="sp-moon" />
      <Bat className="sp-bat-1" />
      <Bat className="sp-bat-2" />
      <Bat className="sp-bat-3" />
      <div className="sp-fog" />
    </div>
  );
}
