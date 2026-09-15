import { useCallback, useEffect, useRef, useState } from 'react';

// Draw a signature with a mouse, a stylus or a fingertip, and hand back a PNG data URL.
//
// Pointer events, not mouse events: the same handlers then serve a mouse, a pen and a finger,
// which matters because the people signing these forms are as likely to be on a tablet as at a
// desk. touch-action: none on the canvas stops the browser treating a signing stroke as a scroll.
//
// The canvas is sized in DEVICE pixels and scaled back down in CSS, so a stroke drawn on a phone
// is not the blurry upscale that a 300x120 backing store would give. That also means the saved
// PNG is crisp when the printed form scales it into the signature line.
//
// WHAT COMES BACK is a trimmed PNG -- the drawn ink with the surrounding blank cropped off -- so
// the printed form can size it to the line rather than centring a small scribble in a large
// transparent rectangle. Transparent background, so it sits on the ruled line like ink.
const PEN_WIDTH = 2.2;
const PEN_COLOR = '#1a2b4c';

export default function SignaturePad({ value, onChange, height = 150, disabled = false }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const [hasInk, setHasInk] = useState(false);

  // Fits the backing store to the element's real size. Called on mount and on resize, because a
  // canvas that is resized loses its contents -- so an existing signature is re-drawn after.
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = PEN_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PEN_COLOR;
  }, []);

  // Paint an existing signature back onto a freshly sized canvas.
  const restore = useCallback((dataUrl) => {
    const canvas = canvasRef.current;
    if (!canvas || !dataUrl) return;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      // Contain, never stretch: a signature squashed to fit is not that person's signature.
      const scale = Math.min(rect.width / img.width, rect.height / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (rect.width - w) / 2, (rect.height - h) / 2, w, h);
      setHasInk(true);
    };
    img.src = dataUrl;
  }, []);

  useEffect(() => {
    fit();
    if (value) restore(value);
    const onResize = () => {
      // Whatever is on screen right now, kept across the resize.
      const current = dirty.current ? canvasRef.current?.toDataURL('image/png') : value;
      fit();
      if (current) restore(current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fit, restore, value]);

  function pos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e) {
    if (disabled) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
    // A tap with no drag should still leave a mark -- a dot is a legitimate part of a signature.
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath();
    ctx.arc(last.current.x, last.current.y, PEN_WIDTH / 2, 0, Math.PI * 2);
    ctx.fillStyle = PEN_COLOR;
    ctx.fill();
    dirty.current = true;
    setHasInk(true);
  }

  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const p = pos(e);
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  }

  function end(e) {
    if (!drawing.current) return;
    drawing.current = false;
    try { canvasRef.current.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    onChange?.(trimmed());
  }

  // Crop the transparent margin off, so what is saved is the ink and nothing else.
  function trimmed() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const { width, height: h } = canvas;
    const { data } = ctx.getImageData(0, 0, width, h);
    let top = h; let left = width; let right = -1; let bottom = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // Alpha only: the ink is the only thing ever drawn, and the rest stays transparent.
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (right < 0) return null; // nothing drawn

    const pad = 6;
    left = Math.max(0, left - pad); top = Math.max(0, top - pad);
    right = Math.min(width - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);

    const out = document.createElement('canvas');
    out.width = right - left + 1;
    out.height = bottom - top + 1;
    out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = false;
    setHasInk(false);
    onChange?.(null);
  }

  return (
    <div>
      <div
        style={{
          border: '1px solid var(--border, #ddd)', borderRadius: 8,
          background: 'var(--surface, #fff)', position: 'relative', overflow: 'hidden',
        }}
      >
        {/* The ruled line people expect to sign on, drawn behind the canvas rather than on it so
            it never ends up baked into the saved PNG. */}
        <div style={{
          position: 'absolute', left: 24, right: 24, bottom: 34,
          borderBottom: '1px solid var(--border, #ccc)', pointerEvents: 'none',
        }} />
        {!hasInk && (
          <div className="muted" style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', pointerEvents: 'none', fontSize: 13,
          }}>
            {disabled ? 'No signature on file' : 'Sign here — draw with a mouse, pen or finger'}
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', height, touchAction: 'none', cursor: disabled ? 'default' : 'crosshair' }}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
        />
      </div>
      {!disabled && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button type="button" className="btn btn-sm" onClick={clear} disabled={!hasInk}>Clear</button>
          <span className="muted" style={{ fontSize: 12 }}>
            Saved with the rest of the form. Used on the Requested / Noted / Approved By lines when a
            document is printed.
          </span>
        </div>
      )}
    </div>
  );
}
