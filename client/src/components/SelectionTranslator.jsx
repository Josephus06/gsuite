import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';

const MIN_CHARS = 2;
const MAX_CHARS = 2000;

// Highlight any text in the app -- an incident report, a memo, a customer's remark typed in
// Cebuano or Tagalog -- and a small "Translate" button appears beside it; clicking it shows the
// English (POST /api/translate, server/src/routes/translate.js). Mounted once in Layout.
//
// SAVE puts the English on the page for everyone from then on, in place of the original. It is a
// display swap, never an edit: the record keeps the words the person wrote (on HR records they are
// the evidence), the translated text is dotted-underlined with the original in its tooltip, and
// highlighting it again offers "Show original" and Remove.
//
// How the swap is done: only the text of the existing DOM text nodes is changed (node.data), never
// the node structure -- React owns that structure, and wrapping its nodes in new elements would
// break its next update. When React re-renders a node back to the original, the MutationObserver
// sees it and swaps it again.
//
// Portalled to <body> for the same reason Modal is: every .card has a backdrop-filter, and a
// position:fixed element inside one is measured against the card, not the screen.
const UI_ATTR = 'data-translator-ui';
const SKIP = `[${UI_ATTR}], script, style, textarea, input, select, [contenteditable="true"]`;

function readSelection() {
  // Text selected inside an input/textarea is not part of window.getSelection() in every browser.
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.type || '')))) {
    const { selectionStart: s, selectionEnd: e } = el;
    if (s != null && e != null && e > s) {
      const r = el.getBoundingClientRect();
      return { text: el.value.slice(s, e), rect: r, node: null };
    }
    return null;
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r.width && !r.height) return null;
  // Save only works on a selection inside ONE text node -- that is the unit the page swap replaces.
  const single = sel.anchorNode === sel.focusNode && sel.anchorNode?.nodeType === Node.TEXT_NODE;
  return { text: sel.toString(), rect: r, node: single ? sel.anchorNode : null };
}

export default function SelectionTranslator() {
  const location = useLocation();
  const { user } = useAuth();
  const [anchor, setAnchor] = useState(null); // { text, x, y, canSave, savedItems }
  const [result, setResult] = useState(null); // { status, translation, language, note, error }
  const [saved, setSaved] = useState([]);
  const [showOriginal, setShowOriginal] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const rootRef = useRef(null);
  const marked = useRef(new Map()); // text node -> { original, shown, items }
  const state = useRef({ saved: [], showOriginal: new Set() });
  state.current = { saved, showOriginal };

  // --- the page swap ---------------------------------------------------------------------------
  const apply = useCallback(() => {
    const { saved: items, showOriginal: hidden } = state.current;
    const active = items.filter((t) => !hidden.has(t.id));
    const activeKey = new Map(active.map((t) => [t.id, t.translation]));
    // Put back anything no longer (or no longer shown as) translated. Compared by id and text, not
    // object identity -- a reload of the same list must not flicker every translated node.
    for (const [node, m] of marked.current) {
      if (!node.isConnected) { marked.current.delete(node); continue; }
      if (node.data === m.shown && !m.items.every((t) => activeKey.get(t.id) === t.translation)) {
        node.data = m.original;
        node.parentElement?.removeAttribute('data-translated');
        node.parentElement?.removeAttribute('title');
        marked.current.delete(node);
      }
    }
    if (!active.length) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim() || node.parentElement?.closest(SKIP)) continue;
      const m = marked.current.get(node);
      if (m && node.data === m.shown) continue; // our swap is still in place
      const base = node.data;
      let out = base;
      const used = [];
      for (const t of active) {
        if (out.includes(t.original_text)) {
          out = out.split(t.original_text).join(t.translation);
          used.push(t);
        }
      }
      if (!used.length) { marked.current.delete(node); continue; }
      node.data = out;
      marked.current.set(node, { original: base, shown: out, items: used });
      const el = node.parentElement;
      if (el) {
        el.setAttribute('data-translated', '1');
        el.setAttribute('title', `Translated${used[0].language ? ` from ${used[0].language}` : ''} — original: "${used.map((t) => t.original_text).join(' / ')}"`);
      }
    }
  }, []);

  // Load this page's saved translations whenever the page changes.
  const loadSaved = useCallback(async () => {
    try {
      const { data } = await api.get('/translate/saved', { params: { path: location.pathname } });
      setSaved(data);
    } catch {
      setSaved([]);
    }
  }, [location.pathname]);

  useEffect(() => {
    marked.current.clear();
    setShowOriginal(new Set());
    loadSaved();
  }, [loadSaved]);

  useEffect(() => {
    apply();
    if (!saved.length && !marked.current.size) return undefined;
    let frame = null;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = null; apply(); });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [saved, showOriginal, apply]);

  // --- the popover ------------------------------------------------------------------------------
  useEffect(() => {
    function close() {
      setAnchor(null);
      setResult(null);
    }
    function onSelect(e) {
      if (rootRef.current?.contains(e.target)) return;
      // Let the browser finish updating the selection first.
      setTimeout(() => {
        const s = readSelection();
        const text = s?.text.trim() || '';
        if (!s || text.length < MIN_CHARS || text.length > MAX_CHARS || !/\p{L}/u.test(text)) {
          close();
          return;
        }
        const x = Math.min(Math.max(8, s.rect.right - 90), window.innerWidth - 150);
        const below = s.rect.bottom + 8;
        const y = below + 40 > window.innerHeight ? Math.max(8, s.rect.top - 40) : below;
        const m = s.node ? marked.current.get(s.node) : null;
        setAnchor({ text, x, y, canSave: !!s.node && !m, savedItems: m ? m.items : null });
        setResult(null);
      }, 0);
    }
    function onDown(e) {
      if (!rootRef.current?.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.shiftKey) onSelect(e);
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

  function close() {
    setAnchor(null);
    setResult(null);
  }

  async function translate() {
    setResult({ status: 'loading' });
    try {
      const { data } = await api.post('/translate', { text: anchor.text });
      setResult({ status: 'done', ...data });
    } catch (err) {
      setResult({ status: 'error', error: err.response?.data?.error || 'Translation failed.' });
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api.post('/translate/saved', {
        path: location.pathname, original: anchor.text, translation: result.translation, language: result.language,
      });
      window.getSelection()?.removeAllRanges();
      close();
      await loadSaved();
    } catch (err) {
      setResult({ ...result, saveError: err.response?.data?.error || 'Could not save.' });
    } finally {
      setSaving(false);
    }
  }

  function toggleOriginal(item) {
    setShowOriginal((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      return next;
    });
    close();
  }

  async function remove(item) {
    if (!confirm('Remove this saved translation? The page will show the original text again.')) return;
    try {
      await api.delete(`/translate/saved/${item.id}`);
      close();
      await loadSaved();
    } catch (err) {
      setResult({ status: 'error', error: err.response?.data?.error || 'Could not remove it.' });
    }
  }

  if (!anchor) return null;

  const panelLeft = Math.min(anchor.x, window.innerWidth - 376);
  const panelTop = anchor.y + 300 > window.innerHeight ? Math.max(8, anchor.y - 260) : anchor.y;
  const panelStyle = {
    position: 'fixed', left: Math.max(8, panelLeft), top: panelTop, zIndex: 3000, width: 360, maxWidth: 'calc(100vw - 16px)',
    maxHeight: 300, overflowY: 'auto', boxShadow: '0 6px 24px rgba(0,0,0,.25)', background: 'var(--color-surface)',
  };
  const isAdmin = user?.account_type === 'System Admin';
  const header = (title) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <button type="button" className="btn btn-sm" onClick={close}>✕</button>
    </div>
  );

  // Highlighting text that is already a saved translation: show where it came from instead.
  if (anchor.savedItems) {
    return createPortal(
      <div ref={rootRef} {...{ [UI_ATTR]: '' }}>
        {!result ? (
          <button
            type="button" className="btn btn-sm"
            style={{ position: 'fixed', left: anchor.x, top: anchor.y, zIndex: 3000, boxShadow: '0 2px 8px rgba(0,0,0,.2)' }}
            onMouseDown={(e) => { e.preventDefault(); setResult({ status: 'saved' }); }}
          >
            🌐 Show original
          </button>
        ) : (
          <div className="card" style={panelStyle}>
            {header('Saved translation')}
            {result.status === 'error' && <div className="error-banner" style={{ margin: '0 0 8px' }}>{result.error}</div>}
            {anchor.savedItems.map((t) => (
              <div key={t.id} style={{ marginBottom: 10 }}>
                <div className="muted" style={{ fontSize: 12 }}>Original{t.language ? ` (${t.language})` : ''}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{t.original_text}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>English</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{t.translation}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Saved by {t.created_by_name || 'someone'}{t.created_at ? ` · ${String(t.created_at).slice(0, 10)}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => toggleOriginal(t)}>Show original on page</button>
                  {(isAdmin || t.created_by_user_id === user?.id) && (
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(t)}>Remove</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>,
      document.body,
    );
  }

  const hiddenHere = saved.filter((t) => showOriginal.has(t.id) && t.original_text === anchor.text);

  return createPortal(
    <div ref={rootRef} {...{ [UI_ATTR]: '' }}>
      {!result && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          style={{ position: 'fixed', left: anchor.x, top: anchor.y, zIndex: 3000, boxShadow: '0 2px 8px rgba(0,0,0,.2)' }}
          // mousedown, not click: keeps the text selected while the button is pressed.
          onMouseDown={(e) => {
            e.preventDefault();
            if (hiddenHere.length) toggleOriginal(hiddenHere[0]);
            else translate();
          }}
        >
          🌐 {hiddenHere.length ? 'Show English' : 'Translate'}
        </button>
      )}
      {result && (
        <div className="card" style={panelStyle}>
          {header(`English${result.language && result.language.toLowerCase() !== 'english' ? ` · from ${result.language}` : ''}`)}
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
              {result.saveError && <div className="error-banner" style={{ margin: '8px 0 0' }}>{result.saveError}</div>}
              {anchor.canSave && result.translation !== anchor.text && (
                <>
                  <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 8 }} onClick={save} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    Shows the English on this page for everyone. The original is kept — highlight it to see it.
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
