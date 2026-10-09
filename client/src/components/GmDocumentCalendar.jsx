import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Modal from './Modal';
import { useCalendarRange } from '../utils/calendarRange';

// The General Manager dashboard's Weighted Sales and Invoice calendars: one month of sales orders
// or invoices by the day they were created, as customer chips with the day's total -- laid out
// like CollectionForecastCalendar so the switch between them reads as one calendar.
// GET /dashboard/gm-calendar decides which rows count (the same as the Weighted Sales card).
//
// The Invoice calendar counts invoices AND the month's Delivery Tickets, open or converted, each ticket
// on the day it was raised -- orange while open, blue once converted (asked 2026-10-05). An invoice
// converted from a ticket is never counted, so the ticket's amount is not counted twice.
//
// `range` is the dashboard's Day / Week / Month switch (utils/calendarRange.jsx): the month grid, one
// week of it, or a single day laid out in full. The endpoint is monthly, so a week across a month end
// fetches both months, and the header's count and total are of the days on screen.
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const TYPES = {
  sales: { noun: 'sales order', plural: 'Sales Orders', docLabel: 'Sales Order No', amountLabel: 'Net of Tax', path: (id) => `/sales-orders/${id}` },
  invoices: {
    noun: 'document', plural: 'Invoices / DTs', docLabel: 'Invoice / DT No', amountLabel: 'Amount',
    path: (id, kind) => (kind === 'dt' ? `/delivery-tickets/${id}` : `/sales-invoices/${id}`),
  },
};

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const EMPTY = { calendar: [], count: 0, total: 0 };

export default function GmDocumentCalendar({ type, range = 'month' }) {
  const cfg = TYPES[type];
  const { cells, days, months, title, shift, todayKey } = useCalendarRange(range);
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState(null);
  const monthsKey = months.join(',');

  // Weighted Sales only: Location and Department filters (asked 2026-10-09). Location starts on Head
  // Office, Department on all. locationId stays null until the locations have loaded and Head Office
  // is chosen, so the first fetch is already the Head Office one rather than all locations, then it.
  const withFilters = type === 'sales';
  const [locations, setLocations] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [locationId, setLocationId] = useState(withFilters ? null : '');
  const [divisionId, setDivisionId] = useState('');
  useEffect(() => {
    if (!withFilters) return;
    const rows = (d) => (Array.isArray(d) ? d : (d?.rows || []));
    Promise.all([api.get('/lookups/locations'), api.get('/lookups/sales-divisions')])
      .then(([l, d]) => {
        const locs = rows(l.data);
        setLocations(locs);
        setDivisions(rows(d.data).filter((x) => x.is_active === undefined || Number(x.is_active)));
        const ho = locs.find((x) => String(x.location_name || x.name || '').trim().toLowerCase() === 'head office');
        setLocationId((cur) => (cur === null ? (ho ? String(ho.id) : '') : cur));
      })
      .catch(() => setLocationId((cur) => (cur === null ? '' : cur)));
  }, [withFilters]);

  useEffect(() => {
    if (locationId === null) return;
    let cancelled = false;
    setLoading(true);
    const filters = withFilters ? { location_id: locationId || undefined, sales_division_id: divisionId || undefined } : {};
    Promise.all(monthsKey.split(',').map((month) => api.get('/dashboard/gm-calendar', { params: { type, month, ...filters } })))
      .then((rs) => { if (!cancelled) setData({ calendar: rs.flatMap((r) => r.data.calendar || []) }); })
      .catch(() => { if (!cancelled) setData(EMPTY); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, monthsKey, withFilters, locationId, divisionId]);

  const byDay = new Map((data.calendar || []).map((d) => [d.day, d]));
  // The header speaks for the days on screen -- a week's or a day's, not the whole month's.
  const visible = days.map((k) => byDay.get(k)).filter(Boolean);
  const shownCount = visible.reduce((t, e) => t + Number(e.count || 0), 0);
  const shownTotal = visible.reduce((t, e) => t + Number(e.total || 0), 0);
  const openEntry = openDay ? byDay.get(openDay) : null;
  const dayEntry = range === 'day' ? byDay.get(days[0]) : null;

  return (
    <div className="artist-calendar">
      <div className="artist-calendar-head">
        <button type="button" className="btn btn-sm" onClick={() => shift(-1)} disabled={loading}>&lsaquo;</button>
        <strong>{title}</strong>
        <button type="button" className="btn btn-sm" onClick={() => shift(1)} disabled={loading}>&rsaquo;</button>
        {withFilters && (
          <>
            <select value={locationId ?? ''} onChange={(e) => setLocationId(e.target.value)} title="Location" style={{ width: 'auto', minWidth: 140 }}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name || l.name}</option>)}
            </select>
            <select value={divisionId} onChange={(e) => setDivisionId(e.target.value)} title="Department" style={{ width: 'auto', minWidth: 140 }}>
              <option value="">All departments</option>
              {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </>
        )}
        <span className="muted artist-calendar-count">
          {loading ? 'Loading...' : `${plural(shownCount, cfg.noun)} · ${money(shownTotal)}`}
        </span>
      </div>

      {/* Day: the day's whole breakdown in place of a single-cell grid. */}
      {range === 'day' && !loading && (dayEntry
        ? <CustomerTable cfg={cfg} customers={dayEntry.customers} count={dayEntry.count} total={dayEntry.total} />
        : <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Nothing on this day.</div>)}

      {range !== 'day' && <div className="artist-calendar-grid">
        {WEEKDAYS.map((w) => <div key={w} className="artist-calendar-weekday">{w}</div>)}
        {cells.map((key, i) => {
          if (!key) return <div key={`pad-${i}`} className="artist-calendar-day is-empty" />;
          const entry = byDay.get(key);
          const customers = entry?.customers || [];
          // Three chips a day; the rest fold into "+n more". A customer whose only document that day
          // is a ticket shows as the coloured DT chip below instead, not twice.
          const chips = customers.filter((c) => c.docs.some((d) => d.kind !== 'dt'));
          const dts = entry?.dts || [];
          const titleParts = [];
          if (entry?.count) titleParts.push(`${plural(entry.count, cfg.noun)}, ${money(entry.total)}`);
          if (dts.length) titleParts.push(`incl. ${plural(dts.length, 'delivery ticket')}`);
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className={`artist-calendar-day is-clickable${key === todayKey ? ' is-today' : ''}${chips.length || dts.length ? ' has-jobs' : ''}`}
              title={titleParts.length ? `${titleParts.join(' · ')} -- click to see them` : 'Nothing on this day -- click to confirm'}
              onClick={() => setOpenDay(key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenDay(key); } }}
            >
              <span className="artist-calendar-daynum">{Number(key.slice(8, 10))}</span>
              {entry?.total > 0 && (
                <div className="cal-tally">
                  <span className="cal-tally-item">{money(entry.total)}</span>
                </div>
              )}
              {chips.slice(0, 3).map((c) => (
                <span
                  key={c.customerId}
                  className="artist-calendar-chip"
                  title={`${c.customerName} · ${plural(c.count, cfg.noun)} · ${money(c.total)}`}
                >
                  {c.customerName}
                </span>
              ))}
              {chips.length > 3 && <span className="artist-calendar-more">+{chips.length - 3} more</span>}
              {dts.slice(0, 3).map((t) => (
                <span
                  key={`dt-${t.id}`}
                  className={`artist-calendar-chip ${t.status === 'converted' ? 'cal-dt-converted' : 'cal-dt-open'}`}
                  title={`${t.docNo} · ${t.customerName} · ${t.status === 'converted' ? 'converted' : 'open'} · ${money(t.amount)}`}
                >
                  {t.docNo}
                </span>
              ))}
              {dts.length > 3 && <span className="artist-calendar-more">+{dts.length - 3} DT</span>}
            </div>
          );
        })}
      </div>}

      {openDay && (
        <Modal
          title={new Date(`${openDay}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          onClose={() => setOpenDay(null)}
          large
        >
          {!openEntry ? (
            <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Nothing on this day.</div>
          ) : (
            <CustomerTable cfg={cfg} customers={openEntry.customers} count={openEntry.count} total={openEntry.total} />
          )}
        </Modal>
      )}
    </div>
  );
}

// One row per customer with their count and total, expanding to the documents behind it.
function CustomerTable({ cfg, customers, count, total }) {
  const navigate = useNavigate();
  const [openCustomer, setOpenCustomer] = useState(null);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 32 }} />
            <th>Customer</th>
            <th className="text-right">{cfg.plural}</th>
            <th className="text-right">{cfg.amountLabel}</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => {
            const open = openCustomer === c.customerId;
            return [
              <tr key={c.customerId} className="is-clickable" onClick={() => setOpenCustomer(open ? null : c.customerId)}>
                <td>{open ? '▾' : '▸'}</td>
                <td>{c.customerName}</td>
                <td className="text-right">{c.count}</td>
                <td className="text-right">{money(c.total)}</td>
              </tr>,
              open && (
                <tr key={`${c.customerId}-docs`}>
                  <td />
                  <td colSpan={3} style={{ padding: 0 }}>
                    <table style={{ width: '100%' }}>
                      <thead><tr><th>{cfg.docLabel}</th><th className="text-right">{cfg.amountLabel}</th></tr></thead>
                      <tbody>
                        {c.docs.map((d) => (
                          <tr key={`${d.kind || 'doc'}-${d.id}`} className="is-clickable" onClick={() => navigate(cfg.path(d.id, d.kind))}>
                            <td className="link-btn">
                              {d.kind === 'dt'
                                ? <span className={`artist-calendar-chip ${d.status === 'converted' ? 'cal-dt-converted' : 'cal-dt-open'}`} title={d.status === 'converted' ? 'Converted -- its invoice is not counted again' : 'Open'}>{d.docNo}</span>
                                : d.docNo}
                            </td>
                            <td className="text-right">{money(d.amount)}</td>
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
            <td className="text-right"><strong>{count}</strong></td>
            <td className="text-right"><strong>{money(total)}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
