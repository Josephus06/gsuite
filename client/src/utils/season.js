// Seasonal look (asked 2026-11-14): the app dresses for the time of year on its own -- spooky in
// October and November, Christmas in December -- on top of whichever Day / Night / Glass theme is
// on. Anyone can switch it off (back to the original look) from the topbar; the choice is kept per
// browser. index.html applies it before first paint (mirrors seasonFor / activeSeason).
const STORAGE_KEY = 'season-theme'; // 'off' = original look; anything else = follow the calendar

export const SEASONS = {
  spooky: { label: 'Spooky', icon: '🎃' },
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

export function applySeason(season) {
  if (season) document.documentElement.dataset.season = season;
  else delete document.documentElement.dataset.season;
}

export function setSeasonEnabled(on) {
  try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* applies for this session */ }
  const s = on ? seasonFor() : null;
  applySeason(s);
  return s;
}
