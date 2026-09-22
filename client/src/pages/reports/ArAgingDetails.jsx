import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { REPORT_TIMING } from '../../utils/reportTiming';

// Accounting > Reports > AR Aging Details -- the documents behind AR Aging, grouped by customer:
// every invoice still carrying a balance, every credit memo not yet used up, every payment with
// cash still sitting on account, with what it is and how old it is.
//
// The server computes both reports from one set of open items, so a customer's rows here always
// add up to that customer's Total Balance on AR Aging. If the two ever disagree, the cause is in
// lib/arAging.js and not in one of them being "the fresher" figure.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';
}
function dmy(v) {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return y && m && d ? `${m}-${d}-${y}` : String(v).slice(0, 10);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Where a row links to. A Trans # that is not a link is a dead end on a report whose whole job is
// to send someone to the document.
const LINK_BY_TYPE = {
  Invoice: (it) => `/sales-invoices/${it.id}`,
  'Credit Memo': (it) => `/credit-memos/${it.id}`,
  'Unapplied Payment': (it) => `/customer-payments/${it.id}`,
};

const PAGE_SIZES = [25, 50, 100, 200];

export default function ArAgingDetails() {
  const [filters, setFilters] = useState({
    customer: null, locationId: '', noLocation: false, nameStarts: '', asOf: today(),
  });
  const [applied, setApplied] = useState(null);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [locations, setLocations] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [customerText, setCustomerText] = useState('');
  const [customerOptions, setCustomerOptions] = useState([]);
  const customerTimer = useRef(null);

  useEffect(() => {
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
  }, []);

  const paramsOf = useCallback((f, extra = {}) => {
    const p = { asOf: f.asOf, ...extra };
    if (f.customer) p.customerId = f.customer.id;
    if (f.noLocation) p.noLocation = 'true';
    else if (f.locationId) p.locationId = f.locationId;
    if (f.nameStarts) p.nameStarts = f.nameStarts;
    return p;
  }, []);

  const load = useCallback(async (f, pageNum, pageSize) => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/ar-aging-details', {
        params: paramsOf(f, { page: pageNum, limit: pageSize }),
      });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate the report.');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [paramsOf]);

  // Nothing runs until Generate, matching the real report and AR Aging beside it: this reads
  // every invoice, payment and credit memo in the database, so it is not something to fire on
  // arrival or on each keystroke.
  useEffect(() => {
    if (applied) load(applied, page, limit);
  }, [applied, page, limit, load]);

  function generate() {
    setPage(1);
    setApplied({ ...filters });
  }

  function onCustomerType(text) {
    setCustomerText(text);
    const exact = customerOptions.find((c) => c.name.toLowerCase() === text.trim().toLowerCase());
    setFilters((f) => ({ ...f, customer: exact || null }));
    if (customerTimer.current) clearTimeout(customerTimer.current);
    if (text.trim().length < 2) { setCustomerOptions([]); return; }
    customerTimer.current = setTimeout(() => {
      api.get('/reports/ar-aging-details/customers', { params: { q: text.trim() } })
        .then(({ data }) => setCustomerOptions(data))
        .catch(() => setCustomerOptions([]));
    }, 300);
  }

  async function download() {
    try {
      const res = await api.get('/reports/ar-aging-details', {
        params: paramsOf(applied || filters, { format: 'csv' }),
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ar-aging-details-${(applied || filters).asOf}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not download the report.');
    }
  }

  const activeLocation = locations.find((l) => String(l.id) === String((applied || filters).locationId));
  const rows = report?.rows || [];

  return (
    <div>
      <div className="page-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="badge badge-muted" style={{ fontSize: 13 }}>
            {(applied || filters).noLocation ? 'No location' : activeLocation?.location_name || 'All locations'}
          </span>
          <span>AR Aging Details</span>
        </h1>
        <button className="btn btn-sm" disabled={!report || loading} onClick={download}>Download CSV</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Customer</label>
            <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
              <input
                list="ar-aging-details-customers"
                value={customerText}
                placeholder="Customer"
                onChange={(e) => onCustomerType(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
                style={{ flex: 1, minWidth: 0 }}
              />
              <datalist id="ar-aging-details-customers">
                {customerOptions.map((c) => <option key={c.id} value={c.name} />)}
              </datalist>
              <button
                type="button" className="btn" title="Clear Customer" aria-label="Clear Customer"
                disabled={!customerText} style={{ padding: '7px 10px' }}
                onClick={() => { setCustomerText(''); setCustomerOptions([]); setFilters({ ...filters, customer: null }); }}
              >
                ✕
              </button>
            </div>
            {customerText.trim() && !filters.customer && (
              <span className="muted" style={{ fontSize: 12 }}>Pick a name from the list to filter by it.</span>
            )}
          </div>
          <div className="field">
            <label>Location</label>
            <select
              value={filters.locationId}
              disabled={filters.noLocation}
              onChange={(e) => setFilters({ ...filters, locationId: e.target.value })}
            >
              <option value="">--ALL--</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Name Starts (eg. ABCD)</label>
            <input
              value={filters.nameStarts}
              placeholder="Name Starts"
              onChange={(e) => setFilters({ ...filters, nameStarts: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
            />
          </div>
          <div className="field">
            <label>No Location</label>
            <input
              type="checkbox"
              checked={filters.noLocation}
              onChange={(e) => setFilters({ ...filters, noLocation: e.target.checked })}
            />
          </div>
          <div className="field">
            <label>Date as of</label>
            <input type="date" value={filters.asOf} onChange={(e) => setFilters({ ...filters, asOf: e.target.value })} />
          </div>
          <div className="field">
            <label>Customers per page</label>
            <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={REPORT_TIMING.arAging} />}

      {/* Same warning AR Aging carries, for the same reason and in the same words -- the rows it
          refers to are marked on the line below, so here it only has to say how many. */}
      {!loading && report?.totals?.unevidenced_count > 0 && (
        <div className="warning-banner" style={{ marginBottom: 16 }}>
          <strong>{report.totals.unevidenced_count.toLocaleString()} invoices</strong> below are marked
          “Paid In Full” on the invoice itself, with no payment or credit memo in this system settling them.
          They are listed because the payment record is missing, not because the money is known to be owed.
        </div>
      )}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <strong>As of {report.as_of}</strong>
            <span>{report.totals.customer_count.toLocaleString()} customers</span>
            <span>{report.totals.item_count.toLocaleString()} open items</span>
            <span>Total open balance: <strong>{money(report.totals.open_balance)}</strong></span>
            <span className="muted" style={{ fontSize: 13 }}>
              Page {report.page} of {report.total_pages.toLocaleString()}
            </span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Trans Date</th>
                  <th>Trans #</th>
                  <th>BS #</th>
                  <th>Memo</th>
                  <th>PO #</th>
                  <th>Date Due</th>
                  <th style={{ textAlign: 'right' }}>Age</th>
                  <th style={{ textAlign: 'right' }}>Open Balance</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing outstanding for these filters as of this date.
                  </td></tr>
                )}
                {rows.map((g) => [
                  <tr key={`c-${g.customer_id}`} style={{ background: 'var(--color-neutral-bg)' }}>
                    <td colSpan={8} style={{ fontWeight: 600 }}>
                      <span style={{ color: 'var(--color-accent, #14b8a6)', marginRight: 8 }}>●</span>
                      {g.customer_name}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(g.total_balance)}</td>
                    <td></td>
                  </tr>,
                  ...g.items.map((it) => {
                    const href = LINK_BY_TYPE[it.type]?.(it);
                    return (
                      <tr key={`${it.type}-${it.id}`}>
                        <td></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{dmy(it.trans_date)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {href ? <Link to={href}>{it.trans_no}</Link> : it.trans_no}
                          {it.marked_paid_unevidenced && (
                            <span
                              className="badge badge-warning"
                              style={{ marginLeft: 6 }}
                              title="The invoice is marked Paid In Full and its amount due is 0, but no payment or credit memo in this system settles it. Listed because the payment record is missing, not because the money is known to be owed."
                            >
                              marked paid
                            </span>
                          )}
                        </td>
                        <td>{it.bs_no || ''}</td>
                        <td style={{ maxWidth: 260 }}>{it.memo || ''}</td>
                        <td>{it.po_no || ''}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{dmy(it.date_due)}</td>
                        <td style={{ textAlign: 'right' }}>{it.age}</td>
                        <td style={{ textAlign: 'right', color: Number(it.open_balance) < 0 ? '#b91c1c' : undefined }}>
                          {money(it.open_balance)}
                        </td>
                        <td>{it.location_name || ''}</td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={8} style={{ textAlign: 'right' }}>This page :</td>
                    <td style={{ textAlign: 'right' }}>{money(report.page_total)}</td>
                    <td></td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={8} style={{ textAlign: 'right' }}>All {report.totals.customer_count.toLocaleString()} customers :</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.open_balance)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {report.total_pages > 1 && (
            <div className="picker-pagination" style={{ marginTop: 16 }}>
              <button type="button" disabled={report.page === 1} onClick={() => setPage(report.page - 1)}>Previous</button>
              <span style={{ padding: '0 12px', alignSelf: 'center' }}>
                {report.page.toLocaleString()} / {report.total_pages.toLocaleString()}
              </span>
              <button type="button" disabled={report.page >= report.total_pages} onClick={() => setPage(report.page + 1)}>Next</button>
            </div>
          )}

          <div className="muted" style={{ marginTop: 16, fontSize: 13, lineHeight: 1.6 }}>
            <div>
              <strong>Age</strong> counts days from the due date for an invoice, and from the document date for a credit memo or an
              unapplied payment, which have none. A negative age is an invoice not yet due.
            </div>
            <div>
              <strong>Open Balance</strong> is signed the way the receivable is: an invoice&apos;s unsettled remainder is positive, a
              credit memo you still owe back and cash received but not yet applied are negative.
            </div>
            <div>
              The rows for a customer add up to that customer&apos;s Total Balance on <Link to="/reports/ar-aging">AR Aging</Link> —
              both reports are built from the same open items, as of the same date.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
