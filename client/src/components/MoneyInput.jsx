import { useLayoutEffect, useRef, useState } from 'react';

// An amount box that writes the money format as you type (asked 2026-11-10): thousands commas
// appear on their own, one decimal point, two decimal places -- 1500000 reads 1,500,000 and becomes
// 1,500,000.00 when you leave the box. The value it hands back is the plain number as a string
// ("1500000.5"), or '' when empty, so the form saves what it always did.

const clean = (s) => {
  const t = String(s ?? '').replace(/[^\d.]/g, '');
  const dot = t.indexOf('.');
  const int = (dot < 0 ? t : t.slice(0, dot)).replace(/^0+(?=\d)/, '');
  return dot < 0 ? int : `${int || '0'}.${t.slice(dot + 1).replace(/\./g, '').slice(0, 2)}`;
};
const group = (raw) => {
  if (raw === '') return '';
  const [int, dec] = raw.split('.');
  const withCommas = (int || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec === undefined ? withCommas : `${withCommas}.${dec}`;
};
const padded = (raw) => (raw === '' || Number.isNaN(Number(raw)) ? '' : group(Number(raw).toFixed(2)));

export default function MoneyInput({ value, onChange, ...rest }) {
  const ref = useRef(null);
  const caret = useRef(null);
  const [focused, setFocused] = useState(false);
  const raw = clean(value);
  const shown = focused ? group(raw) : padded(raw);

  // Keep the caret after the same digit once commas are added or removed around it.
  useLayoutEffect(() => {
    if (caret.current == null || !ref.current) return;
    const want = caret.current;
    caret.current = null;
    let pos = 0;
    let seen = 0;
    while (pos < shown.length && seen < want) { if (/[\d.]/.test(shown[pos])) seen += 1; pos += 1; }
    ref.current.setSelectionRange(pos, pos);
  });

  function handle(e) {
    const el = e.target;
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    caret.current = before.replace(/[^\d.]/g, '').length;
    onChange(clean(el.value));
  }

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="decimal"
      value={shown}
      onChange={handle}
      onFocus={(e) => { setFocused(true); rest.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); rest.onBlur?.(e); }}
    />
  );
}
