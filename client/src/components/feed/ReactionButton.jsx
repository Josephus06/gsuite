import { useEffect, useRef, useState } from 'react';
import { REACTIONS, REACTION_BY_KEY } from './reactions';

// The Like control plus the hover-to-expand picker.
//
// Desktop opens the bar on hover (CSS :hover on .fb-react-wrap). Touch has no hover, so a
// long-press opens it explicitly via the .open class and a tap just toggles Like -- same
// split Facebook uses.
export default function ReactionButton({ myReaction, onReact, compact = false }) {
  const [open, setOpen] = useState(false);
  const [popKey, setPopKey] = useState(null);
  const holdRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocDown(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [open]);

  useEffect(() => () => clearTimeout(holdRef.current), []);

  function choose(key) {
    setOpen(false);
    // Same reaction again clears it, which is how FB's toggle behaves.
    const next = myReaction === key ? null : key;
    if (next) setPopKey(next);
    onReact(next);
  }

  function onTouchStart() {
    holdRef.current = setTimeout(() => setOpen(true), 350);
  }
  function onTouchEnd() {
    clearTimeout(holdRef.current);
  }

  const active = myReaction ? REACTION_BY_KEY[myReaction] : null;

  const label = active ? active.label : 'Like';
  const emoji = active ? active.emoji : '👍';

  return (
    <div className={`fb-react-wrap${compact ? ' compact' : ''}`} ref={wrapRef}>
      <div className={`fb-react-bar${open ? ' open' : ''}`}>
        {REACTIONS.map((r) => (
          <button
            key={r.key}
            type="button"
            className="fb-react-emoji"
            data-label={r.label}
            aria-label={r.label}
            onClick={() => choose(r.key)}
          >
            {r.emoji}
          </button>
        ))}
      </div>

      {compact ? (
        <button
          type="button"
          className={myReaction ? 'active' : ''}
          style={active ? { color: active.color } : undefined}
          onClick={() => choose(myReaction || 'like')}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {label}
        </button>
      ) : (
        <button
          type="button"
          className={`fb-action${myReaction ? ` reacted ${myReaction}` : ''}`}
          onClick={() => choose(myReaction || 'like')}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <span className={`emoji${popKey ? ' fb-pop' : ''}`} onAnimationEnd={() => setPopKey(null)}>{emoji}</span>
          {label}
        </button>
      )}
    </div>
  );
}
