import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

const STATUS_LABELS = { saved: 'Open', cancelled: 'Void' };

// Mirrors the real "Sales Invoice" detail view -- reached from a Sales Order's Related
// Records tab after billing it. Each line was a snapshot of a sales_order_line's own
// billing figures at the moment it was included, so this view is a frozen record of
// what was actually billed, not a live re-query of the SO.
export default function SalesInvoiceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [si, setSi] = useState(null);
  const [tab, setTab] = useState('items');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/sales-invoices/${id}`).then(({ data }) => { setSi(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/sales-invoices/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleCancel() {
    if (!confirm('Void this Invoice? Its billed qty will be reversed.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/sales-invoices/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !si) return <LoadingSpinner />;

  const canEdit = can('/sales-invoices', 'can_edit');
  const isSaved = si.status === 'saved';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/sales-orders/${si.sales_order_id}`)}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Invoice isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && isSaved && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Invoice</h1>
          <span className="estimate-no">{si.invoice_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[si.status] || si.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Customer : <span className="hi">{si.customer_name}</span></div>
            <div>Created Form : <button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${si.sales_order_id}`)}>{si.sales_order_no}</button></div>
            <div>Date : <span className="hi">{formatDate(si.date_created)}</span></div>
            <div>BS/SI # : <span className="hi">{si.bs_si_no || ''}</span></div>
            <div>PO # : <span className="hi">{si.po_no || ''}</span></div>
            <div>Memo : <span className="hi">{si.memo || ''}</span></div>
          </div>
          <div>
            <div>Term : <span className="hi">{si.term}</span></div>
            <div>Date Due : <span className="hi">{formatDate(si.date_due)}</span></div>
            <div>Type : <span className="hi">SI</span></div>
          </div>
          <div>
            <div>Sales Rep : <span className="hi">{si.sales_rep_name || '—'}</span></div>
            <div>Office Location : <span className="hi">{si.office_location_name || '—'}</span></div>
            <div>Department : <span className="hi">{si.department_name || '—'}</span></div>
            <div>Bill to Address : <span className="hi">{si.bill_to_address || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(si.net_of_tax)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(si.discount_amount)}</div></div>
        <div><span className="muted">EWT</span><div className="hi-lg">{money(si.ewt_amount)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(si.tax_amount)}</div></div>
        <div><span className="muted">Amount Due</span><div className="hi-lg">{money(si.amount_due)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>JO #</th><th>Description</th><th>Qty</th><th>Units</th><th>Price/Unit</th><th>Subtotal</th>
                  <th>Disc. Amt</th><th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th>
                </tr>
              </thead>
              <tbody>
                {si.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.job_order_id ? (
                      <button type="button" className="link-btn" onClick={() => navigate(`/production/${l.job_order_id}`)}>{l.job_order_no}</button>
                    ) : '—'}</td>
                    <td>{l.description}</td>
                    <td>{qty(l.quantity)}</td>
                    <td>{l.units}</td>
                    <td>{money(l.price_per_unit)}</td>
                    <td>{money(l.subtotal)}</td>
                    <td>{money(l.disc_amount)}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.gross_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <p className="muted">GL posting isn't modeled for Sales Invoice in this build.</p>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <p>Sales Order: <button type="button" className="btn btn-sm" onClick={() => navigate(`/sales-orders/${si.sales_order_id}`)}>{si.sales_order_no}</button></p>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'Date Time', render: (r) => new Date(r.set_at).toLocaleString() },
              { key: 'set_by_name', label: 'Set By' },
              { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' },
              { key: 'old_value', label: 'Old Value' },
              { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}
    </div>
  );
}
