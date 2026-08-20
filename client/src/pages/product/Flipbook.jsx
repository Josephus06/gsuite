import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// A real page-turning flipbook: sheets rotate around the spine in 3D rather than sliding or
// cross-fading.
//
// The book is a stack of LEAVES, not pages. One leaf is one sheet of paper carrying two pages
// -- its front and its back -- which is why the page list is chunked in twos and why turning
// one leaf advances the reader by two pages. Anything that treats a page as the unit ends up
// showing the same sheet's back and front simultaneously.
//
// Stacking order is the other half of the illusion. An unturned leaf must sit above the ones
// behind it, and a turned leaf must sit above the ones already turned -- the two orders are
// opposite, so z-index is computed per leaf from whether it has turned yet.
export default function Flipbook({ pages, renderPage }) {
  const leaves = useMemo(() => {
    const out = [];
    for (let i = 0; i < pages.length; i += 2) out.push([pages[i], pages[i + 1] || null]);
    return out;
  }, [pages]);

  // How many leaves have been turned: 0 = closed on the cover, leaves.length = fully read.
  const [turned, setTurned] = useState(0);
  // 145%: the size the book is actually read at. Fitting the whole spread on screen at 100%
  // leaves body copy too small to read, so it opens where a reader would have put it anyway.
  const DEFAULT_ZOOM = 1.45;
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const stageRef = useRef(null);

  const canBack = turned > 0;
  const canForward = turned < leaves.length;
  const next = useCallback(() => setTurned((t) => Math.min(leaves.length, t + 1)), [leaves.length]);
  const prev = useCallback(() => setTurned((t) => Math.max(0, t - 1)), []);

  // Arrow keys read the book the way a keyboard user expects; Home/End jump to the covers.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); next(); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
      if (e.key === 'Home') { e.preventDefault(); setTurned(0); }
      if (e.key === 'End') { e.preventDefault(); setTurned(leaves.length); }
    }
    const el = stageRef.current;
    el?.addEventListener('keydown', onKey);
    return () => el?.removeEventListener('keydown', onKey);
  }, [next, prev, leaves.length]);

  const pageLabel = turned === 0
    ? 'Cover'
    : turned >= leaves.length
      ? 'Back cover'
      : `Pages ${turned * 2} – ${Math.min(pages.length, turned * 2 + 1)} of ${pages.length}`;

  return (
    <div className="flipbook-wrap">
      <div
        className="flipbook-stage"
        ref={stageRef}
        tabIndex={0}
        style={{ '--pf-zoom': zoom }}
        aria-label="Company profile flipbook. Use the left and right arrow keys to turn pages."
      >
        <div className={`flipbook-book${turned === 0 ? ' is-closed' : ''}`}>
          {leaves.map(([front, back], i) => {
            const isTurned = i < turned;
            return (
              <div
                key={front?.number || `leaf-${i}`}
                className={`flipbook-leaf${isTurned ? ' is-turned' : ''}`}
                // Turned leaves stack upward so the most recently turned sits on top of the
                // pile on the left; unturned leaves stack downward for the pile on the right.
                style={{ zIndex: isTurned ? i : leaves.length - i }}
              >
                <div className="flipbook-face flipbook-front" onClick={next}>
                  {renderPage(front)}
                  <span className="flipbook-gloss" />
                </div>
                <div className="flipbook-face flipbook-back" onClick={prev}>
                  {back ? renderPage(back) : <div className="flipbook-page flipbook-blank" />}
                  <span className="flipbook-gloss back" />
                </div>
              </div>
            );
          })}
          {/* Sits under the leaves and only shows through the gap at the spine, which is what
              stops the open book looking like two unrelated floating rectangles. */}
          <div className="flipbook-spine" aria-hidden="true" />
        </div>
      </div>

      <div className="flipbook-controls">
        <button type="button" className="btn btn-sm" onClick={prev} disabled={!canBack}>‹ Back</button>
        <span className="flipbook-counter">{pageLabel}</span>
        <button type="button" className="btn btn-sm" onClick={next} disabled={!canForward}>Next ›</button>

        <span className="flipbook-zoom">
          <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
          <span className="flipbook-zoom-value">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.min(2.2, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
        </span>
      </div>

      {/* Jumping straight to a section beats turning twenty leaves to reach the client list. */}
      <div className="flipbook-jump">
        {leaves.map(([front], i) => (
          <button
            key={`dot-${front?.number || i}`}
            type="button"
            title={front?.heading || front?.title || front?.section || `Leaf ${i + 1}`}
            className={`flipbook-dot${i === turned ? ' active' : ''}${i < turned ? ' done' : ''}`}
            onClick={() => setTurned(i)}
          />
        ))}
      </div>
    </div>
  );
}
