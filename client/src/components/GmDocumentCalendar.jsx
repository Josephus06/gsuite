import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Modal from './Modal';

// The General Manager dashboard's Weighted Sales and Invoice calendars: one month of sales orders
// or invoices by the day they were created, as customer chips with the day's total -- laid out
// like CollectionForecastCalendar so the switch between them reads as one calendar.
// GET /dashboard/gm-calendar decides which rows count (the same as the Weighted Sales card).
//
// The Invoice calendar shows invoices only (asked 2026-10-05): open Delivery Tickets no longer
// ride along, and an invoice converted from a ticket raised in an earlier month is left out.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const TYPES = {
  sales: { noun: 'sales order', plural: 'Sales Orders', docLabel: 'Sales Order No', amountLabel: 'Net of Tax', path: (id) => `/sales-orders/${id}` },
  invoices: { noun: 'invoice', plural: 'Invoices', docLabel: 'Invoice No', amountLabel: 'Amount', path: (id) => `/sales-invoices/${id}` },
};

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const EMPTY = { calendar: [], count: 0, total: 0 };

export default function GmDocumentCalendar({ type }) {
  const cfg = TYPES[type];
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/dashboard/gm-calendar', { params: { type, month } })
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(EMPTY); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, month]);

  const byDay = new Map((data.calendar || []).map((d) => [d.day, d]));
  const [year, monthNo] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNo, 0).getDate();
  const leading = new Date(year, monthNo - 1, 1).getDay();
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(`${year}-${pad(monthNo)}-${pad(d)}`);

  const shift = (delta) => {
    const base = new Date(year, monthNo - 1 + delta, 1);
    setMonth(`${base.getFullYear()}-${pad(base.getMonth() + 1)}`);
  };
  const openEntry = openDay ? byDay.get(openDay) : null;

  return (
    <div className="artist-calendar">
      <div className="artist-calendar-head">
        <button type="button" className="btn btn-sm" onClick={() => shift(-1)} disabled={loading}>&lsaquo;</button>
        <strong>{MONTH_NAMES[monthNo - 1]} {year}</strong>
        <button type="button" className="btn btn-sm" onClick={() => shift(1)} disabled={loading}>&rsaquo;</button>
        <span className="muted artist-calendar-count">
          {loading ? 'Loading...' : `${plural(data.count, cfg.noun)} · ${money(data.total)}`}
        </span>
      </div>

      <div className="artist-calendar-grid">
        {WEEKDAYS.map((w) => <div key={w} className="artist-calendar-weekday">{w}</div>)}
        {cells.map((key, i) => {
          if (!key) return <div key={`pad-${i}`} className="artist-calendar-day is-empty" />;
          const entry = byDay.get(key);
          const customers = entry?.customers || [];
          // Three chips a day; the rest fold into "+n more".
          const chips = customers;
          const titleParts = [];
          if (entry?.count) titleParts.push(`${plural(entry.count, cfg.noun)}, ${money(entry.total)}`);
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className={`artist-calendar-day is-clickable${key === todayKey ? ' is-today' : ''}${chips.length ? ' has-jobs' : ''}`}
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
            </div>
          );
        })}
      </div>

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
                          <tr key={d.id} className="is-clickable" onClick={() => navigate(cfg.path(d.id))}>
                            <td className="link-btn">{d.docNo}</td>
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
