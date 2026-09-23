import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';

// The month of expected collections, in the shape of the production schedule so the two read
// alike -- but the chips carry CUSTOMER names, because the question here is who is paying us on
// a given day and how much, not which document it came from.
//
// Shared deliberately between the Treasury > Collection Forecast page and the dashboard card.
// Two copies would eventually disagree about a day's total, and the whole point of the calendar
// is that the number on the cell and the number in the popup are the same number.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const pad = (n) => String(n).padStart(2, '0');
function thisMonth() {
  const t = new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
}
function formatDayHeading(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

export default function CollectionForecastCalendar({ customerId }) {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState({ calendar: [], invoiceCount: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: d } = await api.get('/collection-forecast/calendar', {
          params: { month, customer_id: customerId || undefined },
        });
        if (!cancelled) setData(d);
      } catch {
        // Leave the month showing what it had rather than blanking the calendar on a hiccup.
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [month, customerId]);

  const byDay = new Map((data.calendar || []).map((d) => [d.day, d]));
  const [year, monthNo] = month.split('-').map(Number);
  const first = new Date(year, monthNo - 1, 1);
  const daysInMonth = new Date(year, monthNo, 0).getDate();
  const leading = first.getDay();
  const todayKey = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  })();

  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(`${year}-${pad(monthNo)}-${pad(d)}`);

  const shift = (delta) => {
    const base = new Date(year, monthNo - 1 + delta, 1);
    setMonth(`${base.getFullYear()}-${pad(base.getMonth() + 1)}`);
  };

  return (
    <div className="artist-calendar">
      <div className="artist-calendar-head">
        <button type="button" className="btn btn-sm" onClick={() => shift(-1)} disabled={loading}>&lsaquo;</button>
        <strong>{MONTH_NAMES[monthNo - 1]} {year}</strong>
        <button type="button" className="btn btn-sm" onClick={() => shift(1)} disabled={loading}>&rsaquo;</button>
        <span className="muted artist-calendar-count">
          {loading
            ? 'Loading...'
            : `${data.invoiceCount} invoice${data.invoiceCount === 1 ? '' : 's'} · ${money(data.total)} expected`}
        </span>
      </div>

      <div className="artist-calendar-grid">
        {WEEKDAYS.map((w) => <div key={w} className="artist-calendar-weekday">{w}</div>)}
        {cells.map((key, i) => {
          if (!key) return <div key={`pad-${i}`} className="artist-calendar-day is-empty" />;
          const entry = byDay.get(key);
          const customers = entry?.customers || [];
          // Every day opens, including empty ones -- a click that does nothing is
          // indistinguishable from the feature being broken, and "nothing expected" is
          // itself worth confirming.
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className={`artist-calendar-day is-clickable${key === todayKey ? ' is-today' : ''}${customers.length ? ' has-jobs' : ''}`}
              title={customers.length
                ? `${entry.invoiceCount} invoice(s), ${money(entry.total)} -- click to see them`
                : 'Nothing forecast -- click to confirm'}
              onClick={() => setOpenDay(key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenDay(key); } }}
            >
              <span className="artist-calendar-daynum">{Number(key.slice(8, 10))}</span>
              {customers.length > 0 && (
                <div className="cal-tally">
                  <span className="cal-tally-item">{money(entry.total)}</span>
                </div>
              )}
              {customers.slice(0, 3).map((c) => (
                <span
                  key={c.customerId}
                  className="artist-calendar-chip"
                  title={`${c.customerName} · ${c.invoiceCount} invoice(s) · ${money(c.total)}`}
                >
                  {c.customerName}
                </span>
              ))}
              {customers.length > 3 && (
                <span className="artist-calendar-more">+{customers.length - 3} more</span>
              )}
            </div>
          );
        })}
      </div>

      {openDay && (
        <Modal title={`Expected on ${formatDayHeading(openDay)}`} onClose={() => setOpenDay(null)} large>
          <DayBreakdown entry={byDay.get(openDay)} />
        </Modal>
      )}
    </div>
  );
}

// One row per CUSTOMER with their invoice count and total, expanding to the invoices behind it.
// Collapsed by default: the day's question is who and how much, and a day with a dozen customers
// would otherwise open as a wall of invoice numbers.
function DayBreakdown({ entry }) {
  const [openCustomer, setOpenCustomer] = useState(null);
  const customers = entry?.customers || [];

  if (!customers.length) {
    return (
      <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
        Nothing forecast for collection on this day.
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 32 }} />
            <th>Customer</th>
            <th className="text-right">Invoices</th>
            <th className="text-right">Total Expected</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => {
            const open = openCustomer === c.customerId;
            return [
              <tr
                key={c.customerId}
                className="is-clickable"
                onClick={() => setOpenCustomer(open ? null : c.customerId)}
              >
                <td>{open ? '▾' : '▸'}</td>
                <td>{c.customerName}</td>
                <td className="text-right">{c.invoiceCount}</td>
                <td className="text-right">{money(c.total)}</td>
              </tr>,
              open && (
                <tr key={`${c.customerId}-detail`}>
                  <td />
                  <td colSpan={3} style={{ padding: 0 }}>
                    <table style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th>Invoice No</th>
                          <th>Date Created</th>
                          <th>Due Date</th>
                          <th className="text-right">Amount Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td>{inv.invoiceNo}</td>
                            <td>{inv.dateCreated}</td>
                            <td>{inv.dateDue || '—'}</td>
                            <td className="text-right">{money(inv.amountDue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              ),
            ];
          })}
          <tr>
            <td />
            <td><strong>Total</strong></td>
            <td className="text-right"><strong>{entry.invoiceCount}</strong></td>
            <td className="text-right"><strong>{money(entry.total)}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
