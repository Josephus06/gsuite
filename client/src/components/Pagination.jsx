const BATCH_SIZE = 5;

// Shared Previous/page-numbers/Next control, reused by every paginated list in the app
// (10 items per page everywhere) instead of duplicating the same markup per page. Page
// numbers show 5 at a time in a sliding batch -- pages 1-5, then once you move past page
// 5 (via Next or the page-6+ jump) it shows 6-10, and so on, rather than ever listing
// every page number at once.
export default function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const batchStart = Math.floor((page - 1) / BATCH_SIZE) * BATCH_SIZE + 1;
  const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, totalPages);
  const batchPages = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

  return (
    <div className="picker-pagination" style={{ marginTop: 16 }}>
      <button type="button" disabled={page === 1} onClick={() => onChange(page - 1)}>Previous</button>
      {batchStart > 1 && (
        <button type="button" onClick={() => onChange(batchStart - 1)}>…</button>
      )}
      {batchPages.map((p) => (
        <button key={p} type="button" className={p === page ? 'active' : ''} onClick={() => onChange(p)}>{p}</button>
      ))}
      {batchEnd < totalPages && (
        <button type="button" onClick={() => onChange(batchEnd + 1)}>…</button>
      )}
      <button type="button" disabled={page === totalPages} onClick={() => onChange(page + 1)}>Next</button>
    </div>
  );
}
