import { useMemo, useState } from 'react';
import Modal from './Modal';
import Pagination from './Pagination';

const PAGE_SIZE = 10;

export default function EntityPicker({
  label, items, value, getLabel, columns, searchKeys, onSelect, placeholder, required, disabled,
  triggerLabel, triggerClassName,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const selected = items.find((i) => String(i.id) === String(value));

  const filtered = useMemo(() => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter((item) => searchKeys.some((k) => String(item[k] ?? '').toLowerCase().includes(q)));
  }, [items, search, searchKeys]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function openPicker() {
    if (disabled) return;
    setSearch('');
    setPage(1);
    setOpen(true);
  }

  function choose(item) {
    onSelect(item);
    setOpen(false);
  }

  return (
    <>
      {triggerLabel ? (
        <button type="button" className={triggerClassName || 'btn'} onClick={openPicker} disabled={disabled}>
          {triggerLabel}
        </button>
      ) : (
        <div className="picker-input">
          <input
            readOnly
            required={required}
            value={selected ? getLabel(selected) : ''}
            placeholder={placeholder || `Select ${label}...`}
            onClick={openPicker}
            disabled={disabled}
          />
          <button type="button" className="btn" onClick={openPicker} disabled={disabled} aria-label={`Search ${label}`}>
            🔍
          </button>
        </div>
      )}

      {open && (
        <Modal title={label} onClose={() => setOpen(false)} large>
          <div className="picker-search" style={{ margin: '0 -24px 16px' }}>
            <input
              autoFocus
              placeholder="Search..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {pageItems.length === 0 && (
                  <tr><td colSpan={columns.length} className="muted" style={{ textAlign: 'center', padding: 20 }}>No results.</td></tr>
                )}
                {pageItems.map((item) => (
                  <tr key={item.id} className="picker-row" onClick={() => choose(item)}>
                    {columns.map((c) => <td key={c.key}>{c.render ? c.render(item) : item[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </Modal>
      )}
    </>
  );
}
