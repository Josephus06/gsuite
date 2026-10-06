import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayDate } from '../../utils/dates';

// Sales > Pending Billing: Job Orders production has completed but that are not yet (fully)
// invoiced -- the work that is done and waiting for its bill. Oldest first, because the longer a
// finished job sits unbilled the more it matters. See routes/pendingBillingReport.js for what
// "completed" and "invoiced" mean here.
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

export default function PendingBilling() {
  const [f, setF] = useState({ search: '', sales_rep_id: '', from: '', to: '', delivered: '', include_nsjo: false });
  const [reps, setReps] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => { api.get('/employees').then((r) => setReps(r.data)).catch(() => {}); }, []);

  const params = () => ({
    search: f.search || undefined, sales_rep_id: f.sales_rep_id || undefined, from: f.from || undefined, to: f.to || undefined,
    delivered: f.delivered || undefined, include_nsjo: f.include_nsjo ? 1 : undefined,
  });

  useEffect(() => {
    const t = setTimeout(() => {
      setError('');
      api.get('/reports/pending-billing', { params: params() })
        .then((r) => setData(r.data))
        .catch((e) => { setError(e.response?.data?.error || 'Could not load the report.'); setData({ rows: [], totals: {} }); });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f]);

  async function exportExcel() {
    setExporting(true);
    try {
      const { data: blob } = await api.get('/reports/pending-billing/export', { params: params(), responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `pending-billing-${new Date().toLocaleDateString('en-CA')}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Could not export.'); } finally { setExporting(false); }
  }

  const upd = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const t = data?.totals || {};

  return (
    <div>
      <div className="page-header">
        <h1>Pending Billing</h1>
        <button type="button" className="btn btn-sm" disabled={exporting || !data?.rows?.length} onClick={exportExcel}>{exporting ? 'Exporting…' : 'Export to Excel'}</button>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>Completed Job Orders not yet invoiced, oldest first.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>General Searching</label><input value={f.search} placeholder="JO, SO, customer or description..." onChange={(e) => upd('search', e.target.value)} /></div>
          <div className="field">
            <label>Sales Rep</label>
            <select value={f.sales_rep_id} onChange={(e) => upd('sales_rep_id', e.target.value)}>
              <option value="">All</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.first_name} {r.last_name}</option>)}
            </select>
          </div>
          <div className="field"><label>Completed From</label><input type="date" value={f.from} onChange={(e) => upd('from', e.target.value)} /></div>
          <div className="field"><label>Completed To</label><input type="date" value={f.to} onChange={(e) => upd('to', e.target.value)} /></div>
          <div className="field">
            <label>Delivered</label>
            <select value={f.delivered} onChange={(e) => upd('delivered', e.target.value)}>
              <option value="">All</option><option value="yes">Delivered</option><option value="no">Not yet delivered</option>
            </select>
          </div>
        </div>
        <div className="field-checkbox" style={{ marginTop: 8 }}>
          <input type="checkbox" id="pb-nsjo" checked={f.include_nsjo} onChange={(e) => upd('include_nsjo', e.target.checked)} />
          <label htmlFor="pb-nsjo">Include non-standard JOs (internal, sample, RMA)</label>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data ? <LoadingSpinner /> : (
        <>
          <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div><span className="muted">Job Orders</span><div className="hi-lg">{(t.jobs || 0).toLocaleString()}</div></div>
            <div><span className="muted">Qty to Bill</span><div className="hi-lg">{qty(t.qty)}</div></div>
            <div><span className="muted">Unbilled Amount</span><div className="hi-lg">{money(t.amount)}</div></div>
            <div><span className="muted">Pending over 30 days</span><div className="hi-lg" style={{ color: t.over30 ? 'var(--danger, #b91c1c)' : undefined }}>{money(t.over30)}</div></div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job Order</th><th>SO / NSSO</th><th>Customer</th><th>Sales Rep</th><th>Description</th>
                    <th>Completed</th><th className="text-right">Days Pending</th><th className="text-right">Qty</th>
                    <th className="text-right">Delivered</th><th className="text-right">Invoiced</th><th className="text-right">To Bill</th>
                    <th className="text-right">Unit Price</th><th className="text-right">Unbilled Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing pending billing.</td></tr>}
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}><Link to={`/job-orders/${r.id}`}>{r.job_order_no}</Link></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.sales_order_id ? <Link to={`/sales-orders/${r.sales_order_id}`}>{r.sales_order_no}</Link> : (r.nsso_no || '')}</td>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td>{r.sales_rep_name || ''}</td>
                      <td style={{ maxWidth: 320 }}>{r.description}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{displayDate(r.completed_date || r.so_date)}</td>
                      <td className="text-right" style={r.days_pending > 30 ? { color: 'var(--danger, #b91c1c)', fontWeight: 600 } : undefined}>{r.days_pending ?? ''}</td>
                      <td className="text-right">{qty(r.quantity)}</td>
                      <td className="text-right">{qty(r.quantity_delivered)}</td>
                      <td className="text-right" title={r.invoice_nos || ''}>{qty(r.invoiced_qty)}</td>
                      <td className="text-right"><strong>{qty(r.uninvoiced_qty)}</strong></td>
                      <td className="text-right">{money(r.unit_gross)}</td>
                      <td className="text-right"><strong>{money(r.unbilled_amount)}</strong></td>
                    </tr>
                  ))}
                  {data.rows.length > 0 && (
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                      <td colSpan={10}>Total</td><td className="text-right">{qty(t.qty)}</td><td /><td className="text-right">{money(t.amount)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
