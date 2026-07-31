// Light/dark theme handling.
//
// The palette lives in index.css as CSS custom properties: :root holds light, and
// :root[data-theme="dark"] overrides them. The data-theme attribute is ALWAYS set --
// index.html sets it inline before first paint (so a dark-mode user never sees a white
// flash), and this module keeps it in step afterwards.
//
// Three stored states, not two: 'light' and 'dark' are explicit user choices, and no stored
// value at all means "follow the OS", which is the default for someone who has never touched
// the toggle. That's why resolve() consults matchMedia rather than assuming light.
const STORAGE_KEY = 'theme';

export function storedTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    // Private mode / blocked storage -- fall back to following the OS every load.
    return null;
  }
}

export function systemTheme() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// The theme actually in effect right now: the user's explicit choice if they made one.
export function resolveTheme() {
  return storedTheme() || systemTheme();
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Keeps native widgets (scrollbars, form controls, the browser's own UI) in step with the
  // chosen theme rather than the OS one.
  document.documentElement.style.colorScheme = theme;
}

export function setTheme(theme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* not fatal -- applies for this session */ }
  applyTheme(theme);
  return theme;
}

// Subscribes to OS theme changes, but only acts while the user is still on "follow the OS".
// Returns an unsubscribe function.
export function watchSystemTheme(onChange) {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};
  const handler = () => {
    if (storedTheme()) return;
    const next = systemTheme();
    applyTheme(next);
    onChange(next);
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
