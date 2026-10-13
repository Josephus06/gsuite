import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// A page's action bar that stays in view under the top menu while the page scrolls (2026-10-13;
// Forms first). Not CSS position: sticky -- that pins to the nearest overflow container, and here
// that is .content (overflow: auto) while it is the WINDOW that scrolls, so the bar either floated
// with a gap or slid under the menu. Instead: watch every scroll (capture catches any scroller),
// and once the bar's place passes the menu's bottom edge, fix it there at its own width. A
// placeholder keeps its height so the page does not jump.
export default function StickyActionBar({ className = '', children }) {
  const placeRef = useRef(null);
  const barRef = useRef(null);
  const [fixed, setFixed] = useState(null); // { top, left, width, height } while pinned

  useEffect(() => {
    let frame = 0;
    function measure() {
      frame = 0;
      const place = placeRef.current;
      const bar = barRef.current;
      if (!place || !bar) return;
      const nav = document.querySelector('.topnav');
      const navBottom = Math.max(0, nav ? nav.getBoundingClientRect().bottom : 0);
      const r = place.getBoundingClientRect();
      if (r.top < navBottom) {
        setFixed((cur) => {
          const next = { top: navBottom, left: r.left, width: r.width, height: cur?.height || bar.offsetHeight };
          return cur && cur.top === next.top && cur.left === next.left && cur.width === next.width ? cur : next;
        });
      } else {
        setFixed(null);
      }
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    measure();
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Keep the placeholder's height in step with the bar's (buttons can wrap onto two rows).
  useLayoutEffect(() => {
    if (fixed && barRef.current && barRef.current.offsetHeight !== fixed.height) {
      setFixed((cur) => (cur ? { ...cur, height: barRef.current.offsetHeight } : cur));
    }
  });

  return (
    <div ref={placeRef} style={fixed ? { height: fixed.height, marginBottom: 16 } : undefined}>
      <div
        ref={barRef}
        className={`page-header sticky-action-bar ${fixed ? 'is-pinned' : ''} ${className}`}
        style={fixed ? { position: 'fixed', top: fixed.top, left: fixed.left, width: fixed.width, margin: 0 } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
