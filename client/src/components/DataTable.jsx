import { useEffect, useState } from 'react';
import Pagination from './Pagination';

const PAGE_SIZE = 10;

// `paginate` is opt-in (default off) since this component is also reused for
// detail-view sub-tables (audit logs, GL Impact, session logs, ...) where a handful of
// rows never needs paging. Only the top-level list pages pass paginate.
export default function DataTable({ columns, rows, actions, emptyLabel = 'No records yet.', paginate = false }) {
  const [page, setPage] = useState(1);

  useEffect(() => { if (paginate) setPage(1); }, [paginate, rows.length]);

  if (!rows.length) {
    return <div className="empty-state">{emptyLabel}</div>;
  }

  const totalPages = paginate ? Math.max(1, Math.ceil(rows.length / PAGE_SIZE)) : 1;
  const pageRows = paginate ? rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : rows;

  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              {actions && <th></th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr key={row.id}>
                {columns.map((c) => (
                  <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>
                ))}
                {actions && (
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>{actions(row)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paginate && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
    </div>
  );
}
