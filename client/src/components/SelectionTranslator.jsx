import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../api/client';

const MIN_CHARS = 2;
const MAX_CHARS = 2000;

// Highlight any text in the app -- an incident report, a memo, a customer's remark typed in
// Cebuano or Tagalog -- and a small "Translate" button appears beside it; clicking it shows the
// English (POST /api/translate, server/src/routes/translate.js). Mounted once in Layout.
//
// Portalled to <body> for the same reason Modal is: every .card has a backdrop-filter, and a
// position:fixed element inside one is measured against the card, not the screen.
function readSelection() {
  // Text selected inside an input/textarea is not part of window.getSelection() in every browser.
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.type || '')))) {
    const { selectionStart: s, selectionEnd: e } = el;
    if (s != null && e != null && e > s) {
      const r = el.getBoundingClientRect();
      return { text: el.value.slice(s, e), rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
    }
    return null;
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { text: sel.toString(), rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
}

export default function SelectionTranslator() {
  const [anchor, setAnchor] = useState(null); // { text, x, y } -- where the button sits
  const [result, setResult] = useState(null); // { status, translation, language, error }
  const rootRef = useRef(null);

  useEffect(() => {
    function onSelect(e) {
      if (rootRef.current?.contains(e.target)) return;
      // Let the browser finish updating the selection first.
      setTimeout(() => {
        const s = readSelection();
        const text = s?.text.trim() || '';
        if (!s || text.length < MIN_CHARS || text.length > MAX_CHARS || !/\p{L}/u.test(text)) {
          setAnchor(null);
          setResult(null);
          return;
        }
        const x = Math.min(Math.max(8, s.rect.right - 90), window.innerWidth - 110);
        const below = s.rect.bottom + 8;
        const y = below + 40 > window.innerHeight ? Math.max(8, s.rect.top - 40) : below;
        setAnchor({ text, x, y });
        setResult(null);
      }, 0);
    }
    function onDown(e) {
      if (!rootRef.current?.contains(e.target)) {
        setAnchor(null);
        setResult(null);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        setAnchor(null);
        setResult(null);
      } else if (e.shiftKey) {
        onSelect(e);
      }
    }
    function onScroll() {
      setAnchor((a) => (a && !result ? null : a));
    }
    document.addEventListener('mouseup', onSelect);
    document.addEventListener('touchend', onSelect);
    document.addEventListener('keyup', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onSelect);
      document.removeEventListener('touchend', onSelect);
      document.removeEventListener('keyup', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [result]);

  async function translate() {
    setResult({ status: 'loading' });
    try {
      const { data } = await api.post('/translate', { text: anchor.text });
      setResult({ status: 'done', ...data });
    } catch (err) {
      setResult({ status: 'error', error: err.response?.data?.error || 'Translation failed.' });
    }
  }

  if (!anchor) return null;

  const panelLeft = Math.min(anchor.x, window.innerWidth - 376);
  const panelTop = anchor.y + 280 > window.innerHeight ? Math.max(8, anchor.y - 240) : anchor.y;

  return createPortal(
    <div ref={rootRef}>
      {!result && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          style={{ position: 'fixed', left: anchor.x, top: anchor.y, zIndex: 3000, boxShadow: '0 2px 8px rgba(0,0,0,.2)' }}
          // mousedown, not click: keeps the text selected while the button is pressed.
          onMouseDown={(e) => { e.preventDefault(); translate(); }}
        >
          🌐 Translate
        </button>
      )}
      {result && (
        <div
          className="card"
          style={{
            position: 'fixed', left: Math.max(8, panelLeft), top: panelTop, zIndex: 3000, width: 360, maxWidth: 'calc(100vw - 16px)',
            maxHeight: 260, overflowY: 'auto', boxShadow: '0 6px 24px rgba(0,0,0,.25)', background: 'var(--color-surface)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>
              English{result.language && result.language.toLowerCase() !== 'english' ? ` · from ${result.language}` : ''}
            </strong>
            <button type="button" className="btn btn-sm" onClick={() => { setAnchor(null); setResult(null); }}>✕</button>
          </div>
          {result.status === 'loading' && <div className="muted">Translating…</div>}
          {result.status === 'error' && <div className="error-banner" style={{ margin: 0 }}>{result.error}</div>}
          {result.status === 'done' && (
            <>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{result.translation}</div>
              {result.note && (
                <div style={{ fontSize: 12, marginTop: 6, color: 'var(--color-text-secondary)' }}>
                  <strong>Note:</strong> {result.note}
                </div>
              )}
              <div className="muted" style={{ fontSize: 12, marginTop: 8, borderTop: '1px solid var(--color-border)', paddingTop: 6 }}>
                “{anchor.text.length > 120 ? `${anchor.text.slice(0, 120)}…` : anchor.text}”
                <div style={{ marginTop: 4 }}>Machine translation — check anything important with the person who wrote it.</div>
              </div>
              <button
                type="button" className="btn btn-sm" style={{ marginTop: 8 }}
                onClick={() => navigator.clipboard?.writeText(result.translation)}
              >
                Copy
              </button>
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
