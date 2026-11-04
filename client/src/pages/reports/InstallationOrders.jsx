import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Pagination from '../../components/Pagination';
import SearchInput from '../../components/SearchInput';
import { CustomerLink } from '../../components/PartyLink';
import { downloadFile } from '../../utils/downloadFile';
import { RepPicker, fmtDate, money, today, useLookups } from './CommissionCommon';

const PAGE_SIZE = 25;
const thisMonth = () => today().slice(0, 7);
const blank = () => ({
  monthFrom: thisMonth(), monthTo: thisMonth(), matchedBy: '', orderType: '', orderStatus: '',
  search: '', salesRepId: '', divisionId: '', locationId: '', officeLocationId: '',
});

// Sales > Installation Orders per Month (2026-11-04): the SOs / NSSOs of each month with their
// installation Job Orders -- JOs whose Job Type or a process is an installation one
// (routes/installationOrdersReport.js). A month-by-month summary on top, the JOs below.
export default function InstallationOrders() {
  const lk = useLookups();
  const [form, setForm] = useState(blank);
  const [applied, setApplied] = useState(blank);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], summary: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const params = (f) => ({
    month_from: f.monthFrom || undefined, month_to: f.monthTo || undefined,
    matched_by: f.matchedBy || undefined, order_type: f.orderType || undefined, order_status: f.orderStatus || undefined,
    search: f.search || undefined, sales_rep_id: f.salesRepId || undefined, sales_division_id: f.divisionId || undefined,
    location_id: f.locationId || undefined, office_location_id: f.officeLocationId || undefined,
  });

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/installation-orders', { params: { ...params(applied), page, limit: PAGE_SIZE } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [applied, page]); // eslint-disable-line react-hooks/exhaustive-deps

  function search() { setApplied({ ...form }); setPage(1); }
  async function download() {
    setDownloading(true);
    try { await downloadFile('/reports/installation-orders', { ...params(applied), format: 'xlsx' }, `Installation-Orders-${applied.monthFrom}.xlsx`); }
    catch (e) { setError(e.response?.data?.error || 'Could not download the report.'); }
    setDownloading(false);
  }

  const locationSelect = (key) => (
    <select value={form[key]} onChange={(e) => set(key, e.target.value)}>
      <option value="">— All —</option>
      {lk.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
    </select>
  );
  const sum = (k) => data.summary.reduce((n, s) => n + Number(s[k] || 0), 0);

  return (
    <div>
      <div className="page-header">
        <h1>Installation Orders per Month</h1>
        <button className="btn btn-primary" disabled={downloading || !data.total} onClick={download}>{downloading ? 'Preparing…' : 'Download'}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="report-filters">
          <div className="field">
            <label>Month From</label>
            <input type="month" value={form.monthFrom} onChange={(e) => set('monthFrom', e.target.value)} />
          </div>
          <div className="field">
            <label>Month To</label>
            <input type="month" value={form.monthTo} onChange={(e) => set('monthTo', e.target.value)} />
          </div>
          <div className="field">
            <label>Installation by</label>
            <select value={form.matchedBy} onChange={(e) => set('matchedBy', e.target.value)}>
              <option value="">Job Type or Process</option>
              <option value="job_type">Job Type only</option>
              <option value="process">Process only</option>
            </select>
          </div>
          <div className="field">
            <label>Order</label>
            <select value={form.orderType} onChange={(e) => set('orderType', e.target.value)}>
              <option value="">SO and NSSO</option>
              <option value="so">Sales Orders</option>
              <option value="nsso">NSSO</option>
            </select>
          </div>
          <div className="field">
            <label>General Searching</label>
            <SearchInput placeholder="SO #, JO #, customer, description" value={form.search} onChange={(e) => set('search', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          </div>
          <div className="field">
            <label>Sales Rep</label>
            <RepPicker reps={lk.reps} value={form.salesRepId} onChange={(v) => set('salesRepId', v)} />
          </div>
          <div className="field">
            <label>Sales Division</label>
            <select value={form.divisionId} onChange={(e) => set('divisionId', e.target.value)}>
              <option value="">— All —</option>
              {lk.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>SO Status</label>
            <select value={form.orderStatus} onChange={(e) => set('orderStatus', e.target.value)}>
              <option value="">All but Cancelled</option>
              <option value="all">All, Cancelled included</option>
              <option value="pending_for_jo">Pending for JO</option>
              <option value="jo_in_process">JO in Process</option>
              <option value="pending_delivery">Pending Delivery</option>
              <option value="pending_billing_partially_delivered">Pending Billing / Partially Delivered</option>
              <option value="pending_billing">Pending Billing</option>
              <option value="billed">Billed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="field"><label>JO Location</label>{locationSelect('locationId')}</div>
          <div className="field"><label>Office Location</label>{locationSelect('officeLocationId')}</div>
          <div />
          <div className="field" style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={search}>Search</button>
            <button className="btn" onClick={() => { const b = blank(); setForm(b); setApplied(b); setPage(1); }}>Clear</button>
          </div>
        </div>
      </div>

      {loading ? <div className="card"><LoadingSpinner /></div> : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>By Month</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th><th className="text-right">Orders</th><th className="text-right">Installation JOs</th>
                    <th className="text-right">by Job Type</th><th className="text-right">by Process</th>
                    <th className="text-right">Net of Tax</th><th className="text-right">Gross Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.map((s) => (
                    <tr key={s.month}>
                      <td>{s.month_label}</td><td className="text-right">{s.orders}</td><td className="text-right">{s.job_orders}</td>
                      <td className="text-right">{s.by_type}</td><td className="text-right">{s.by_process}</td>
                      <td className="text-right">{money(s.net_of_tax)}</td><td className="text-right">{money(s.gross_amount)}</td>
                    </tr>
                  ))}
                  {!data.summary.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing for these filters.</td></tr>}
                </tbody>
                {data.summary.length > 1 && (
                  <tfoot>
                    <tr style={{ fontWeight: 600 }}>
                      <td>Total</td><td className="text-right">{sum('orders')}</td><td className="text-right">{sum('job_orders')}</td>
                      <td className="text-right">{sum('by_type')}</td><td className="text-right">{sum('by_process')}</td>
                      <td className="text-right">{money(sum('net_of_tax'))}</td><td className="text-right">{money(sum('gross_amount'))}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Amounts are the SO lines' of the installation JOs. A JO matched by both its Job Type and a process is counted once.
            </div>
          </div>

          <div className="card">
            <div className="muted" style={{ marginBottom: 8 }}>{data.total.toLocaleString()} job order(s)</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th><th>SO #</th><th>SO Date</th><th>SO Status</th><th>Customer</th><th>Contract Desc.</th><th>Sales Rep</th>
                    <th>JO #</th><th>Job Type</th><th>Description</th><th className="text-right">Qty</th><th>Location</th><th>Date Needed</th>
                    <th>JO Status</th><th>Installation Process(es)</th><th>Matched By</th>
                    <th className="text-right">Net of Tax</th><th className="text-right">Gross Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.job_order_id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.month_label}</td>
                      <td>
                        {r.so_id ? <Link to={`/sales-orders/${r.so_id}`}>{r.order_no}</Link>
                          : r.nsso_id ? <Link to={`/non-standard-sales-orders/${r.nsso_id}`}>{r.order_no}</Link> : r.order_no}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.order_date)}</td>
                      <td>{r.order_status_label}</td>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td style={{ minWidth: 200 }}>{r.contract_description}</td>
                      <td>{r.sales_rep}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><Link to={`/job-orders/${r.job_order_id}`}>{r.job_order_no}</Link></td>
                      <td>{r.job_type}</td>
                      <td style={{ minWidth: 200 }}>{r.description}</td>
                      <td className="text-right" style={{ whiteSpace: 'nowrap' }}>{r.quantity == null ? '' : `${Number(r.quantity).toLocaleString()} ${r.units || ''}`}</td>
                      <td>{r.location}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.delivery_date)}</td>
                      <td>{r.jo_status}{r.jo_sub_status ? ` / ${r.jo_sub_status}` : ''}</td>
                      <td style={{ minWidth: 220 }}>{r.installation_processes}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.matched_by}</td>
                      <td className="text-right">{money(r.net_of_tax)}</td>
                      <td className="text-right">{money(r.gross_amount)}</td>
                    </tr>
                  ))}
                  {!data.rows.length && <tr><td colSpan={18} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing for these filters.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))} onChange={setPage} />
          </div>
        </>
      )}
    </div>
  );
}
