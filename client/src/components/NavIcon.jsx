// One line icon per top-level module, for the slide-out nav panel.
//
// Inline SVG rather than an icon package: eighteen glyphs is a few kilobytes here against
// ~100KB for a library of two thousand, and the whole set is drawn to one spec -- 24px box,
// 1.6 stroke, round caps and joins, no fills -- so nothing looks heavier or lighter than its
// neighbours. `currentColor` throughout, so a row's colour carries its icon with it and the
// active and hover states need no icon rules of their own.
//
// Keyed by the module's LABEL, which is what the nav structure carries. An unknown label falls
// back to a neutral square rather than rendering nothing: a missing icon that leaves a hole
// knocks the labels out of alignment, which reads as broken layout instead of a missing glyph.

const PATHS = {
  Dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  Tickets: <><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" /><path d="M14 5v14" strokeDasharray="2 2.5" /></>,
  Manual: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 20.5Z" /></>,
  HRD: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3 3 0 0 1 0 5.6" /><path d="M17.5 20a5 5 0 0 0-2.3-4.2" /></>,
  Forms: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  Product: <><path d="M12 3 20.5 7.5v9L12 21l-8.5-4.5v-9Z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>,
  Archiver: <><rect x="3" y="4" width="18" height="4.5" rx="1.5" /><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5" /><path d="M10 13h4" /></>,
  CRM: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.6" fill="currentColor" /></>,
  Commission: <><path d="M19 5 5 19" /><circle cx="7.5" cy="7.5" r="2.5" /><circle cx="16.5" cy="16.5" r="2.5" /></>,
  'Master Lists': <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></>,
  Inventory: <><path d="M12 3 21 7l-9 4-9-4Z" /><path d="M3 12l9 4 9-4" /><path d="M3 17l9 4 9-4" /></>,
  Assets: <><path d="M3 21h18" /><path d="M5 21V9.5L12 5l7 4.5V21" /><path d="M9.5 21v-5h5v5" /></>,
  Sales: <><path d="M3.5 16.5 9 11l3.5 3.5L20 7" /><path d="M15 7h5v5" /></>,
  Costing: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8.5 7h7" /><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15v3.5" /></>,
  Design: <><path d="M12 3 5 7.5v9L12 21l7-4.5v-9Z" /><path d="m12 21 3.2-9.3L5 7.5M12 21 8.8 11.7 19 7.5M15.2 11.7H8.8" /></>,
  Purchasing: <><circle cx="9.5" cy="19.5" r="1.4" /><circle cx="17" cy="19.5" r="1.4" /><path d="M2.5 3.5h2.2l2.3 11.2h11.3l1.7-8H6" /></>,
  Production: <><path d="M3 20.5V10l5.5 3.5V10L14 13.5V10l6 3.5v7Z" /><path d="M20 13.5 19.2 4h-3.4l-.5 6" /></>,
  Accounting: <><path d="M3 9.5 12 4l9 5.5" /><path d="M4.5 9.5v9M9.5 9.5v9M14.5 9.5v9M19.5 9.5v9" /><path d="M2.5 20.5h19" /></>,
};

const FALLBACK = <rect x="4.5" y="4.5" width="15" height="15" rx="3.5" />;

export default function NavIcon({ label, size = 19 }) {
  return (
    <svg
      className="navicon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: every icon sits beside its own text label, so announcing it would make a
      // screen reader read each row twice.
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[label] || FALLBACK}
    </svg>
  );
}
