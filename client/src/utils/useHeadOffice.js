import { useEffect, useState } from 'react';
import api from '../api/client';

// Location filters start on Head Office (asked 2026-10-14: "all location filter default must set
// to head office"). The id is looked up once per page load and shared by every screen.
//   undefined -- still looking; ''  -- none found (or no access to the list): no default
let pending = null;
export function headOfficeLocationId() {
  if (!pending) {
    pending = api.get('/lookups/locations')
      .then(({ data }) => {
        const locs = Array.isArray(data) ? data : (data?.rows || []);
        const ho = locs.find((l) => String(l.location_name || '').trim().toLowerCase() === 'head office');
        return ho ? String(ho.id) : '';
      })
      .catch(() => { pending = null; return ''; });
  }
  return pending;
}

// A location filter's state, starting at null (= not decided yet) and set to Head Office once
// known. A screen waits for it to stop being null before its first load, so the first list it
// shows is already Head Office's. Choosing "All" afterwards sets '' and stays.
export function useHeadOfficeFilter() {
  const [value, setValue] = useState(null);
  useEffect(() => {
    let alive = true;
    headOfficeLocationId().then((id) => { if (alive) setValue((v) => (v === null ? id : v)); });
    return () => { alive = false; };
  }, []);
  return [value, setValue];
}
