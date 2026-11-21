import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import { displayDate } from '../../utils/dates';

// Shared helpers of the STP screens (routes/stp.js): formatting, the Period (fiscal year) hook,
// the lookups every screen loads and table sorting. Components are in StpBits.jsx.

export const ROUTE = '/stp';

// ₱#,##0 -- whole pesos, as every STP amount is shown.
export function peso(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  const whole = Math.round(Math.abs(n));
  return `${n < 0 && whole !== 0 ? '-' : ''}₱${whole.toLocaleString('en-US')}`;
}

export const pct = (v, digits = 0) => (v == null ? '—' : `${(Number(v) * 100).toFixed(digits)}%`);
export const date = (v) => (v ? displayDate(String(v).slice(0, 10)) : '—');
export const scoreText = (v) => (v == null ? '—' : Number(v).toFixed(2));

export const FLAG_LABELS = {
  big_buyer_slow_payer: 'Big buyer, slow payer',
  slipping_away: 'Slipping away',
  unvisited_prospect: 'Unvisited prospect',
};
export const SHORT_FLAG = { big_buyer_slow_payer: 'Slow payer', slipping_away: 'Slipping away', unvisited_prospect: 'Unvisited' };

const STORAGE_KEY = 'stp.fiscal_year';

// The Period (fiscal year): from the URL (?fy=), else the last one this viewer chose, else the
// current year. Kept in the URL so a link to a filtered screen opens on the same period.
export function usePeriod() {
  const [params, setParams] = useSearchParams();
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked: fall back */ }
  const fromUrl = params.get('fy');
  const fy = Number(fromUrl || stored || new Date().getFullYear());
  const setFy = useCallback((next) => {
    try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* ignore */ }
    setParams((p) => { const n = new URLSearchParams(p); n.set('fy', String(next)); return n; }, { replace: true });
  }, [setParams]);
  return [fy, setFy];
}

export function useStpMeta(fy) {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    api.get('/stp/meta', { params: { fiscal_year: fy } })
      .then(({ data }) => setMeta(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load STP settings.'));
  }, [fy]);
  useEffect(() => { reload(); }, [reload]);
  return { meta, error, reload };
}

export const apiError = (e, fallback) => e.response?.data?.error || fallback;

// Click-to-sort for the list tables. Numbers sort numerically, nulls last either way.
export function useSort(initialKey, initialDir = 'asc') {
  const [sort, setSort] = useState({ key: initialKey, dir: initialDir });
  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'account_name' ? 'asc' : 'desc' }));
  const apply = (rows, getters = {}) => {
    const get = getters[sort.key] || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const nx = Number(x);
      const ny = Number(y);
      const cmp = Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '' ? nx - ny : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  };
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  return { sort, toggle, apply, arrow };
}
