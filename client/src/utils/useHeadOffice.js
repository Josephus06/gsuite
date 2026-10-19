import { useEffect, useState } from 'react';
import api from '../api/client';

// Office Location filters start on the SIGNED-IN USER'S Default Login Location (Users > User
// Branches, the row ticked "Default Login Location") -- asked 2026-10-19: a Head Office user's
// screens open on Head Office, a branch user's on their branch. Before that every screen opened on
// Head Office for everyone (2026-10-14). A user with no default branch still falls back to Head Office.
//
// Looked up once per signed-in account and shared by every screen; signing in as someone else (a new
// token) looks it up again.
//   undefined -- still looking; ''  -- none found (or no access to the list): no default
let pending = null;
let pendingToken = null;

function headOffice() {
  return api.get('/lookups/locations')
    .then(({ data }) => {
      const locs = Array.isArray(data) ? data : (data?.rows || []);
      const ho = locs.find((l) => String(l.location_name || '').trim().toLowerCase() === 'head office');
      return ho ? String(ho.id) : '';
    })
    .catch(() => '');
}

export function defaultOfficeLocationId() {
  let token = null;
  try { token = localStorage.getItem('token'); } catch { /* storage blocked: treat as one session */ }
  if (!pending || token !== pendingToken) {
    pendingToken = token;
    pending = api.get('/auth/me')
      .then(({ data }) => {
        const id = data?.default_branch?.location_id;
        return id ? String(id) : headOffice();
      })
      .catch(() => headOffice())
      .catch(() => { pending = null; return ''; });
  }
  return pending;
}
// The name the screens already call it by.
export const headOfficeLocationId = defaultOfficeLocationId;

// A location filter's state, starting at null (= not decided yet) and set to the user's default
// office once known. A screen waits for it to stop being null before its first load, so the first
// list it shows is already that office's. Choosing "All" afterwards sets '' and stays.
export function useHeadOfficeFilter() {
  const [value, setValue] = useState(null);
  useEffect(() => {
    let alive = true;
    defaultOfficeLocationId().then((id) => { if (alive) setValue((v) => (v === null ? id : v)); });
    return () => { alive = false; };
  }, []);
  return [value, setValue];
}
