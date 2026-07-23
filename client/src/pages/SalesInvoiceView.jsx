import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import CustomerPaymentModal from '../components/CustomerPaymentModal';
import CreditMemoModal from '../components/CreditMemoModal';
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

const STATUS_LABELS = { saved: 'Open', paid_in_full: 'Paid In Full', cancelled: 'Void' };
// Related Records lists payments and credits alongside each other, so it needs both
// vocabularies -- a payment is NOT DEPOSITED until a bank deposit sweeps it, while a
// credit memo is simply open or void.
const RELATED_STATUS_LABELS = {
  not_deposited: 'Not Deposited', deposited: 'Deposited', open: 'Open', voided: 'Void',
};

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
  const [payments, setPayments] = useState([]);
  const [creditMemos, setCreditMemos] = useState([]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCreditMemoModal, setShowCreditMemoModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return Promise.all([
      api.get(`/sales-invoices/${id}`),
      api.get(`/customer-payments/by-invoice/${id}`),
      api.get(`/credit-memos/by-invoice/${id}`),
    ]).then(([siRes, payRes, cmRes]) => {
      setSi(siRes.data);
      setPayments(payRes.data);
      setCreditMemos(cmRes.data);
      setLoading(false);
    });
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
  // Both actions settle or reduce what's owed, so they only make sense while something is
  // still owed and the invoice hasn't been voided.
  const isSettleable = si.status !== 'cancelled' && Number(si.amount_due) > 0;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/sales-orders/${si.sales_order_id}`)}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Invoice isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && isSettleable && <button className="btn btn-sm btn-primary" onClick={() => setShowPaymentModal(true)}>Accept Payment</button>}
          {canEdit && isSettleable && <button className="btn btn-sm btn-primary" onClick={() => setShowCreditMemoModal(true)}>Credit Memo</button>}
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
            {si.delivery_ticket_id && (
              <div>Delivery Ticket : <button type="button" className="link-btn" onClick={() => navigate(`/delivery-tickets/${si.delivery_ticket_id}`)}>{si.dt_no}</button></div>
            )}
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
        <div><span className="muted">Gross</span><div className="hi-lg">{money(si.gross_amount)}</div></div>
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
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Account Code</th><th>Account Title</th><th>Debit</th><th>Credit</th></tr>
              </thead>
              <tbody>
                {(!si.gl_impact || si.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(si.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {si.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(si.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(si.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <p>Sales Order: <button type="button" className="btn btn-sm" onClick={() => navigate(`/sales-orders/${si.sales_order_id}`)}>{si.sales_order_no}</button></p>
          {si.delivery_ticket_id && (
            <p>Delivery Ticket: <button type="button" className="btn btn-sm" onClick={() => navigate(`/delivery-tickets/${si.delivery_ticket_id}`)}>{si.dt_no}</button></p>
          )}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {payments.length === 0 && creditMemos.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No payments or credits against this invoice yet.</td></tr>
                )}
                {payments.map((p) => (
                  <tr key={`p${p.id}`}>
                    <td>Customer Payment</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/customer-payments/${p.id}`)}>{p.customer_payment_no}</button></td>
                    <td>{formatDate(p.date_created)}</td>
                    <td>{money(p.applied_amount)}</td>
                    <td>{RELATED_STATUS_LABELS[p.status] || p.status}</td>
                  </tr>
                ))}
                {creditMemos.map((c) => (
                  <tr key={`c${c.id}`}>
                    <td>Credit Memo</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/credit-memos/${c.id}`)}>{c.credit_memo_no}</button></td>
                    <td>{formatDate(c.date_created)}</td>
                    <td>{money(c.gross_amount)}</td>
                    <td>{RELATED_STATUS_LABELS[c.status] || c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      {showPaymentModal && (
        <CustomerPaymentModal
          invoiceId={Number(id)}
          onClose={() => setShowPaymentModal(false)}
          onSaved={async (cp) => { setShowPaymentModal(false); await load(); navigate(`/customer-payments/${cp.id}`); }}
        />
      )}

      {showCreditMemoModal && (
        <CreditMemoModal
          invoiceId={Number(id)}
          onClose={() => setShowCreditMemoModal(false)}
          onSaved={async (cm) => { setShowCreditMemoModal(false); await load(); navigate(`/credit-memos/${cm.id}`); }}
        />
      )}
    </div>
  );
}
