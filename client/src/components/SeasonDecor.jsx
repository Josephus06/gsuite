// The seasonal overlay (utils/season.js). Static -- nothing moves (asked 2026-11-14: "remove the
// moving objects, focus on the static design like the cobwebs"). Fixed to the screen's edges, faint,
// and never takes a click (pointer-events: none).
//   spooky    -- cobwebs in all four corners, a spider hanging from one, bats in the top right,
//                pumpkins in the bottom corners and a purple mist along the bottom.
//   christmas -- a string of lights under the menu bar, holly in the top corners, a snow bank
//                along the bottom with a few snowflakes.

// A cobweb for a corner; `side` places and mirrors it.
function Web({ side, size = 130 }) {
  const rings = [30, 58, 88, 120];
  const spokes = [0, 18, 36, 54, 72, 90];
  const pt = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];
  return (
    <svg className={`season-web season-web-${side}`} viewBox="0 0 130 130" width={size} height={size}>
      {spokes.map((d) => { const [x, y] = pt(130, d); return <line key={d} x1="0" y1="0" x2={x} y2={y} />; })}
      {rings.map((r) => (
        <path key={r} d={spokes.map((d, i) => { const [x, y] = pt(r, d); const [mx, my] = pt(r * 0.86, d - 9); return i ? `Q ${mx} ${my} ${x} ${y}` : `M ${x} ${y}`; }).join(' ')} />
      ))}
    </svg>
  );
}

const LIGHT_COLORS = ['#e53935', '#43a047', '#fdd835', '#1e88e5', '#fb8c00'];

export default function SeasonDecor({ season }) {
  if (season === 'spooky') {
    return (
      <div className="season-decor season-decor-spooky" aria-hidden="true">
        <Web side="tl" />
        <Web side="tr" />
        <Web side="bl" size={110} />
        <Web side="br" size={110} />
        <span className="season-spider"><span className="season-spider-thread" />🕷️</span>
        <span className="season-bats">🦇<small>🦇</small>🦇</span>
        <span className="season-pumpkin season-pumpkin-left">🎃</span>
        <span className="season-pumpkin season-pumpkin-right">🎃<small>🕯️</small></span>
        <div className="season-fog" />
      </div>
    );
  }
  if (season === 'christmas') {
    return (
      <div className="season-decor season-decor-christmas" aria-hidden="true">
        <div className="season-lights">
          {Array.from({ length: 40 }, (_, i) => <span key={i} style={{ background: LIGHT_COLORS[i % LIGHT_COLORS.length], color: LIGHT_COLORS[i % LIGHT_COLORS.length] }} />)}
        </div>
        <span className="season-holly season-holly-left">🎄</span>
        <span className="season-holly season-holly-right">🎁</span>
        <span className="season-flakes season-flakes-left">❄ ❅<br />❆</span>
        <span className="season-flakes season-flakes-right">❅ ❄<br />❆</span>
        <div className="season-snow" />
      </div>
    );
  }
  return null;
}
