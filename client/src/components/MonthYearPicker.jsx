import { useEffect, useRef, useState } from 'react';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Month/Year picker matching the real system's "Date as of:" filter (a month grid under a
// year, with Clear / This month). value = { year, month } (month is 1-12) or null.
export default function MonthYearPicker({ value, onChange, placeholder = 'Select month' }) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(value?.year || new Date().getFullYear());
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  useEffect(() => { if (open && value?.year) setViewYear(value.year); }, [open, value]);

  const label = value?.year && value?.month ? `${MONTHS_LONG[value.month - 1]} ${value.year}` : placeholder;

  return (
    <div ref={ref} style={{ position: 'relative', maxWidth: 260 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', textAlign: 'left', padding: '8px 12px', border: '1px solid var(--border, #d1d5db)',
          borderRadius: 8, background: 'var(--surface, #fff)', cursor: 'pointer', display: 'flex',
          justifyContent: 'space-between', alignItems: 'center', color: value?.year ? 'inherit' : 'var(--muted,#888)',
        }}
      >
        <span>{label}</span>
        <span aria-hidden style={{ opacity: 0.6 }}>🗓</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 260, zIndex: 30,
            background: 'var(--surface, #fff)', border: '1px solid var(--border, #ddd)', borderRadius: 8,
            boxShadow: '0 6px 20px rgba(0,0,0,0.15)', padding: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--panel-2,#f3f4f6)', borderRadius: 6, padding: '6px 8px', marginBottom: 6 }}>
            <button type="button" className="link-btn" style={{ padding: '0 8px', fontSize: 16 }} onClick={() => setViewYear((y) => y - 1)}>‹</button>
            <strong>{viewYear}</strong>
            <button type="button" className="link-btn" style={{ padding: '0 8px', fontSize: 16 }} onClick={() => setViewYear((y) => y + 1)}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
            {MONTHS_SHORT.map((m, i) => {
              const selected = value?.year === viewYear && value?.month === i + 1;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { onChange({ year: viewYear, month: i + 1 }); setOpen(false); }}
                  style={{
                    padding: '8px 0', border: 'none', borderRadius: 6, cursor: 'pointer',
                    background: selected ? 'var(--brand, #4b5563)' : 'transparent',
                    color: selected ? '#fff' : 'inherit', fontWeight: selected ? 600 : 400,
                  }}
                >
                  {m}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--border,#eee)' }}>
            <button type="button" className="link-btn" style={{ color: 'var(--link,#2563eb)' }} onClick={() => { onChange(null); setOpen(false); }}>Clear</button>
            <button type="button" className="link-btn" style={{ color: 'var(--link,#2563eb)' }} onClick={() => { const n = new Date(); onChange({ year: n.getFullYear(), month: n.getMonth() + 1 }); setOpen(false); }}>This month</button>
          </div>
        </div>
      )}
    </div>
  );
}
