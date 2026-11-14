import { useEffect, useState } from 'react';
import { applyTheme, resolveTheme } from './theme';

// Seasonal look (asked 2026-11-14): the app dresses for the time of year on its own -- spooky in
// October and November, Christmas in December. Anyone can switch it off (back to the original look)
// from the topbar; the choice is kept per browser. index.html applies it before first paint
// (mirrors seasonFor / activeSeason / applySeason).
//
// Spooky is a full dark redesign (styles/spooky.css, scoped to html.spooky): while it is on, the
// page runs on the dark palette whatever Day / Night / Glass is stored, and the stored choice comes
// back the moment Spooky is switched off. Christmas only adds accents (styles/season.css).
const STORAGE_KEY = 'season-theme'; // 'off' = original look; anything else = follow the calendar

export const SEASONS = {
  spooky: { label: 'Night of the Ledger', icon: '🌙' },
  christmas: { label: 'Christmas', icon: '🎄' },
};

// The season for a date: Oct-Nov spooky, Dec Christmas, otherwise none.
export function seasonFor(date = new Date()) {
  const m = date.getMonth(); // 0 = Jan
  if (m === 9 || m === 10) return 'spooky';
  if (m === 11) return 'christmas';
  return null;
}

export function seasonEnabled() {
  try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { return true; }
}

// The season in effect right now: this month's, unless switched off.
export function activeSeason() {
  return seasonEnabled() ? seasonFor() : null;
}

const listeners = new Set();

export function applySeason(season) {
  const root = document.documentElement;
  if (season) root.dataset.season = season;
  else delete root.dataset.season;
  const spooky = season === 'spooky';
  root.classList.toggle('spooky', spooky);
  // Spooky is built on the dark palette; anything else gets the stored Day / Night / Glass back.
  applyTheme(spooky ? 'dark' : resolveTheme());
  listeners.forEach((fn) => fn(season));
}

export function setSeasonEnabled(on) {
  try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* applies for this session */ }
  const s = on ? seasonFor() : null;
  applySeason(s);
  return s;
}

// The season currently on screen, for components that show something different during it
// (Lookups' "Search the crypt..."). Follows the topbar toggle.
export function useSeason() {
  const [season, setSeason] = useState(() => document.documentElement.dataset.season || null);
  useEffect(() => {
    listeners.add(setSeason);
    return () => { listeners.delete(setSeason); };
  }, []);
  return season;
}
