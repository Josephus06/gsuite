import { useEffect, useRef, useState } from 'react';
import api from '../api/client';

// An address box that suggests as you type, and hands back a pin when one is chosen.
//
// The typed text is always authoritative. Choosing a suggestion fills the box AND captures the
// coordinates; typing freely afterwards clears the pin rather than leaving it pointing at the last
// thing that happened to match. A stop whose address says one place and whose pin says another is
// worse than a stop with no pin -- somebody would drive to the pin.
//
// Philippine addressing defeats any geocoder some of the time: house number and barangay in a
// subdivision OpenStreetMap has never mapped. So this never insists. Type the address, leave it
// unpinned, and it still prints on the run sheet and is still deliverable -- it just will not
// appear on the map.
export default function AddressPicker({
  value, latitude, longitude, onChange, rows = 2, placeholder, label = 'Delivery Address',
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  // Set when a suggestion is picked, so free typing afterwards can tell "this text came from a
  // pin" apart from "this text was typed and the pin is now stale".
  const pinnedText = useRef(value || '');
  const box = useRef(null);

  const pinned = latitude !== null && latitude !== undefined && latitude !== ''
    && longitude !== null && longitude !== undefined && longitude !== '';

  useEffect(() => {
    const q = (value || '').trim();
    if (!open || q.length < 3 || q === pinnedText.current) { setSuggestions([]); return undefined; }
    // Debounced: this proxies to a free geocoder, and a request per keystroke would be rude to it
    // and useless to the person typing.
    const t = setTimeout(() => {
      setSearching(true);
      api.get('/itineraries/geocode', { params: { q } })
        .then(({ data }) => setSuggestions(data || []))
        .catch(() => setSuggestions([]))
        .finally(() => setSearching(false));
    }, 400);
    return () => clearTimeout(t);
  }, [value, open]);

  // Clicking away closes the list without choosing anything.
  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  function choose(s) {
    pinnedText.current = s.label;
    onChange({ address: s.label, latitude: s.latitude, longitude: s.longitude });
    setSuggestions([]);
    setOpen(false);
  }

  function typed(text) {
    // The pin only survives while the text still matches what was pinned.
    const keep = text === pinnedText.current;
    onChange({
      address: text,
      latitude: keep ? latitude : null,
      longitude: keep ? longitude : null,
    });
  }

  return (
    <div className="field" ref={box} style={{ position: 'relative' }}>
      <label>{label}</label>
      <textarea
        rows={rows}
        value={value || ''}
        maxLength={500}
        placeholder={placeholder || 'Start typing — suggestions appear after 3 letters'}
        onChange={(e) => typed(e.target.value)}
        onFocus={() => setOpen(true)}
      />

      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {pinned ? (
          <span style={{ color: '#15803d' }}>
            Pinned at {Number(latitude).toFixed(5)}, {Number(longitude).toFixed(5)} — shows on the map.
            {' '}
            <button type="button" className="link-btn"
              onClick={() => { pinnedText.current = ''; onChange({ address: value, latitude: null, longitude: null }); }}>
              remove pin
            </button>
          </span>
        ) : searching ? 'Looking…'
          : 'Not pinned. Pick a suggestion to put this stop on the map — the address still works without one.'}
      </div>

      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', zIndex: 30, left: 0, right: 0, top: '100%',
          background: 'var(--card, #fff)', border: '1px solid var(--border, #cbd5e1)',
          borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)', maxHeight: 240, overflowY: 'auto',
        }}>
          {suggestions.map((s) => (
            <button
              key={`${s.latitude},${s.longitude},${s.label}`}
              type="button"
              onClick={() => choose(s)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                border: 'none', borderBottom: '1px solid var(--border, #e2e8f0)',
                background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13,
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
