import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import EntityPicker from '../../components/EntityPicker';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const day = (v) => (v ? String(v).slice(0, 10) : '');

function lastMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last), customer: null, bucket: '', search: '', includeGenerated: false };
}

const filterParams = (r) => ({
  from: r.from, to: r.to,
  ...(r.customer ? { customer_id: r.customer.id } : {}),
  ...(r.bucket ? { bucket: r.bucket } : {}),
  ...(r.search.trim() ? { search: r.search.trim() } : {}),
  ...(r.includeGenerated ? { include_generated: '1' } : {}),
});

// Treasury > Collection Report with Aging: Customer Payments in a date range, one row per invoice
// settled, with how old the invoice was when it was collected (routes/collectionAgingReport.js).
export default function CollectionAgingReport() {
  const [range, setRange] = useState(lastMonth);
  const [applied, setApplied] = useState(lastMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [customers, setCustomers] = useState([]);

  useEffect(() => {
    api.get('/reports/collection-aging/customers').then(({ data: d }) => setCustomers(d || [])).catch(() => setCustomers([]));
  }, []);

  const load = useCallback(async (r) => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/reports/collection-aging', { params: filterParams(r) });
      setData(d);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load the report.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(applied); }, [load, applied]);

  async function download() {
    const res = await api.get('/reports/collection-aging/export', { params: filterParams(applied), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `collection-aging-${applied.from}-to-${applied.to}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const rows = data?.rows || [];
  const summary = data?.summary || [];
  const summaryTotal = summary.reduce((s, b) => s + b.amount, 0);
  // Clicking a bucket filters to it; clicking it again clears.
  const pickBucket = (key) => {
    const next = { ...applied, bucket: applied.bucket === key ? '' : key };
    setRange((r) => ({ ...r, bucket: next.bucket }));
    setApplied(next);
  };

  return (
    <div>
      <div className="page-header">
        <h1>Collection Report with Aging</h1>
        <button className="btn btn-primary" disabled={loading || !rows.length} onClick={download}>Export to Excel</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Payment Date From</label>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
          <div className="field">
            <label>Customer</label>
            <EntityPicker
              label="Customer" items={customers} value={range.customer?.id || ''} getLabel={(x) => x?.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="All customers"
              onSelect={(x) => setRange({ ...range, customer: x })}
              onClear={() => setRange({ ...range, customer: null })}
            />
          </div>
          <div className="field">
            <label>Aging</label>
            <select value={range.bucket} onChange={(e) => setRange({ ...range, bucket: e.target.value })}>
              <option value="">All</option>
              {(summary.length ? summary : [{ key: '0-30', label: '0–30 days' }, { key: '31-60', label: '31–60 days' }, { key: '61-90', label: '61–90 days' }, { key: '91-120', label: '91–120 days' }, { key: '120+', label: 'Over 120 days' }])
                .map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Search</label>
            <input value={range.search} placeholder="CPAY #, Invoice #, OR #, customer"
              onChange={(e) => setRange({ ...range, search: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && setApplied({ ...range })} />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}
              title="CPAY-INV- payments were generated for imported paid invoices; no money was received on their date">
              <input type="checkbox" checked={range.includeGenerated}
                onChange={(e) => setRange({ ...range, includeGenerated: e.target.checked })} />
              Include system-generated (CPAY-INV-)
            </label>
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={() => setApplied({ ...range })}>Generate</button>
          </div>
        </div>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Collected by Age of Invoice</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Age at Collection</th><th style={{ textAlign: 'right' }}>Invoices</th><th style={{ textAlign: 'right' }}>Amount Collected</th><th style={{ textAlign: 'right' }}>% of Total</th></tr>
                </thead>
                <tbody>
                  {summary.map((b) => (
                    <tr key={b.key} onClick={() => pickBucket(b.key)} style={{ cursor: 'pointer', fontWeight: applied.bucket === b.key ? 700 : undefined }}
                      title="Show only this bucket (click again for all)">
                      <td>{b.label}</td>
                      <td style={{ textAlign: 'right' }}>{b.count.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{money(b.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{summaryTotal ? `${((b.amount / summaryTotal) * 100).toFixed(1)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ fontWeight: 700 }}>Total</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{summary.reduce((s, b) => s + b.count, 0).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(summaryTotal)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {rows.length} invoice{rows.length === 1 ? '' : 's'} collected {applied.from} to {applied.to}
              {rows.length > 0 && <> — total {money(data?.total_amount)}</>}.
              {' '}Age at Collection = payment date − invoice date; Days Past Due = payment date − invoice due date.
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>CPAY #</th><th>Payment Date</th><th>OR #</th><th>Customer</th><th>Invoice #</th>
                    <th>Invoice Date</th><th>Invoice Due Date</th>
                    <th style={{ textAlign: 'right' }}>Age at Collection</th><th style={{ textAlign: 'right' }}>Days Past Due</th>
                    <th>Aging</th><th style={{ textAlign: 'right' }}>Amount Collected</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No collections in this range.</td></tr>
                  )}
                  {rows.map((r, i) => (
                    <tr key={`${r.payment_id}-${r.invoice_id}-${i}`}>
                      <td><Link className="link-btn" to={`/customer-payments/${r.payment_id}`}>{r.customer_payment_no}</Link></td>
                      <td>{day(r.payment_date)}</td>
                      <td>{r.or_no || '—'}</td>
                      <td>{r.customer_name || '—'}</td>
                      <td><Link className="link-btn" to={`/sales-invoices/${r.invoice_id}`}>{r.invoice_no}</Link></td>
                      <td>{day(r.invoice_date)}</td>
                      <td>{day(r.date_due) || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.age_days ?? '—'}</td>
                      <td style={{ textAlign: 'right', color: r.days_past_due > 0 ? 'var(--danger, #b91c1c)' : undefined }}>
                        {r.days_past_due == null ? '—' : r.days_past_due > 0 ? r.days_past_due : 'On time'}
                      </td>
                      <td>{(summary.find((b) => b.key === r.bucket) || {}).label || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.applied_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
