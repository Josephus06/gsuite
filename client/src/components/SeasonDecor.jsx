// The Christmas overlay (utils/season.js; Spooky has its own, SpookyDecor). Static, fixed to the
// screen's edges, faint, and never takes a click (pointer-events: none).
//   christmas -- a string of lights under the menu bar, holly in the top corners, a snow bank
//                along the bottom with a few snowflakes.

const LIGHT_COLORS = ['#e53935', '#43a047', '#fdd835', '#1e88e5', '#fb8c00'];

export default function SeasonDecor({ season }) {
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
